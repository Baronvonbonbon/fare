import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { poseidon3 } from "poseidon-lite";
import { LeakSweep, fragments } from "./helpers/leaksweep";

// Leak sweep over a whole delivery (TEST-PLAN B1/B2).
//
// The privacy suites already assert on raw calldata, but each does it by hand,
// for one value, in one transaction — which only ever covers the leak someone
// already thought of. This drives a full lifecycle and then scans EVERY block
// it produced: every transaction's calldata, every log's data and topics. A
// secret that escapes through a path nobody considered is caught anyway.
//
// Every absence claim here is paired with a presence claim on the same matcher
// (B2). That pairing is the point: a sweep reporting "no leaks" is worthless
// until you have watched it find something. The controls are chosen to be
// values the protocol publishes DELIBERATELY, so they also document the
// difference between what is hidden and what is simply public.

const abi = ethers.AbiCoder.defaultAbiCoder();
const PAS = (n: string | number) => ethers.parseEther(String(n));

// ── the geography ───────────────────────────────────────────────────────────
const VENUE = { lat: 37_774_900, lon: -122_419_400 };
// The customer's front door. Nothing derived from these two numbers may reach
// the chain — that is the entire claim of the ZK dropoff.
//
// Deliberately share no component with the venue: the venue's coordinates are
// published by design, so reusing one would make the sweep report a "leak" that
// is really the venue's own longitude. (It did, the first time this ran.)
const DROP = { lat: 37_784_913, lon: -122_431_777 };
// Fixed, not random: a deterministic salt keeps the whole sweep reproducible,
// so a fragment collision would be permanent and visible rather than flaky.
const DROP_SALT = 0x5eed_1234_5678_9abcn;

// Where the driver actually stood at pickup, to ~1 m. The attestation carries a
// COARSENED version (~33 m); the exact reading must not survive anywhere.
const DRIVER_EXACT = { lat: 37_775_312, lon: -122_419_377 };
const snap = (v: number) => Math.round(v / 300) * 300;
const DRIVER_SNAPPED = { lat: snap(DRIVER_EXACT.lat), lon: snap(DRIVER_EXACT.lon) };

// Poseidon takes unsigned inputs, so coordinates are offset before hashing.
// These offset forms are just as secret as the raw ones.
const encLat = (l: number) => BigInt(l) + 90_000_000n;
const encLon = (l: number) => BigInt(l) + 180_000_000n;
const positionCommit = (lat: number, lon: number, salt: bigint) =>
  poseidon3([encLat(lat), encLon(lon), salt]);
const b32 = (x: bigint) => "0x" + x.toString(16).padStart(64, "0");

// A distinctive, easily-spotted value that the protocol publishes on purpose —
// used as the control that log scanning works at all.
const MAX_FARE = 1_234_567_890_123_456_789n;

const LOCATION_TYPES = {
  LocationAttestation: [
    { name: "orderId", type: "uint256" }, { name: "phase", type: "uint8" },
    { name: "actor", type: "address" }, { name: "lat", type: "int32" },
    { name: "lon", type: "int32" }, { name: "timestamp", type: "uint64" },
  ],
};
const DRIVER_COMMIT_TYPES = {
  DriverCommitAttestation: [
    { name: "orderId", type: "uint256" }, { name: "phase", type: "uint8" },
    { name: "actor", type: "address" }, { name: "posCommit", type: "bytes32" },
    { name: "timestamp", type: "uint64" },
  ],
};

describe("leak sweep: a whole delivery, checked against every block it wrote", () => {
  let orders: any, settlement: any, vault: any, drivers: any, venues: any, verifier: any;
  let deployer: HardhatEthersSigner, treasury: HardhatEthersSigner, customer: HardhatEthersSigner,
      winner: HardhatEthersSigner, loser: HardhatEthersSigner, venueOp: HardhatEthersSigner,
      venueSigner: HardhatEthersSigner, relay: HardhatEthersSigner;
  let domain: any;

  let lifecycle: LeakSweep;   // spans the entire delivery
  let auction: LeakSweep;     // spans only the bidding window
  const LOSING_BID = PAS("0.911");
  const WINNING_BID = PAS("0.7");
  const orderId = 1n;

  before(async () => {
    [deployer, treasury, customer, winner, loser, venueOp, venueSigner, relay] = await ethers.getSigners();

    const pause = await (await ethers.getContractFactory("FarePauseRegistry")).deploy();
    vault = await (await ethers.getContractFactory("FareVault")).deploy();
    drivers = await (await ethers.getContractFactory("FareDrivers")).deploy(pause.target);
    venues = await (await ethers.getContractFactory("FareVenues")).deploy(pause.target);
    const forwarder = await (await ethers.getContractFactory("FareForwarder")).deploy();
    orders = await (await ethers.getContractFactory("FareOrders")).deploy(pause.target, forwarder.target);
    settlement = await (await ethers.getContractFactory("FareSettlement")).deploy(pause.target);
    const disputes = await (await ethers.getContractFactory("FareDisputes")).deploy(pause.target);
    verifier = await (await ethers.getContractFactory("MockLocationVerifier")).deploy();

    await orders.configure(vault.target, drivers.target, venues.target, settlement.target, disputes.target, treasury.address);
    await settlement.configure(orders.target, venues.target);
    await settlement.setLocationVerifier(verifier.target);
    await disputes.configure(orders.target, vault.target, drivers.target, treasury.address);
    await vault.setAuthorized(orders.target, true);
    await drivers.setAuthorized(orders.target, true);
    await venues.setAuthorized(orders.target, true);

    await drivers.connect(winner).register("ipfs://winner", { value: PAS(1) });
    await drivers.connect(loser).register("ipfs://loser", { value: PAS(1) });
    await venues.connect(venueOp).registerVenue(VENUE.lat, VENUE.lon, venueSigner.address, venueOp.address, "ipfs://venue");

    domain = {
      name: "FareSettlement", version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: settlement.target as string,
    };

    // ── everything past this point is swept ────────────────────────────────
    lifecycle = await LeakSweep.start();

    // 1. the order. The drop is a Poseidon commitment; no coordinate travels.
    const dropCommit = b32(positionCommit(DROP.lat, DROP.lon, DROP_SALT));
    await orders.connect(customer).createOrder(1n, dropCommit, PAS(1), 0, MAX_FARE, 0, 0, { value: PAS(1) });

    // 2. the auction. Both drivers bid through the relay, so the chain sees
    //    only hashes — the loser should be unattributable afterwards.
    auction = await LeakSweep.start();
    const salt = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s));
    const revokeHash = (s: string) => ethers.keccak256(abi.encode(["bytes32"], [salt("revoke:" + s)]));
    for (const [who, amount, tag] of [[winner, WINNING_BID, "w"], [loser, LOSING_BID, "l"]] as const) {
      const hash = await orders.bidHashOf(orderId, who.address, amount, salt(tag));
      await orders.connect(relay).commitBid(orderId, hash, revokeHash(tag));
    }
    await orders.connect(customer).acceptSealedBid(orderId, winner.address, WINNING_BID, salt("w"), { value: WINNING_BID });

    // 3. pickup — the attestation carries COARSENED driver coordinates.
    const now = await time.latest();
    const dAtt = { orderId, phase: 1, actor: winner.address, lat: DRIVER_SNAPPED.lat, lon: DRIVER_SNAPPED.lon, timestamp: now };
    const vAtt = { orderId, phase: 1, actor: venueSigner.address, lat: VENUE.lat, lon: VENUE.lon, timestamp: now };
    await settlement.confirmPickup(
      dAtt, await winner.signTypedData(domain, LOCATION_TYPES, dAtt),
      vAtt, await venueSigner.signTypedData(domain, LOCATION_TYPES, vAtt)
    );

    // 4. dropoff — proof only. The driver commits to a position; the public
    //    signals name commitments and a nullifier, never a coordinate.
    const t2 = await time.latest();
    const driverPos = b32(positionCommit(DROP.lat + 40, DROP.lon, 0x1111n));
    const nullifier = b32(poseidon3([DROP_SALT, orderId, 0n]));
    const dropAtt = { orderId, phase: 2, actor: winner.address, posCommit: driverPos, timestamp: t2 };
    await settlement.confirmDropoffZK(
      dropAtt, await winner.signTypedData(domain, DRIVER_COMMIT_TYPES, dropAtt),
      "0x" + "00".repeat(256),
      [orderId, BigInt(dropCommit), BigInt(driverPos), await settlement.dropoffRadiusMeters(), BigInt(nullifier)]
    );

    expect(await orders.statusOf(orderId)).to.equal(4); // Delivered

    // Freeze both windows. The B2 controls below deliberately plant some of the
    // same secrets on-chain; without this they would retroactively fail the
    // absence claims, since a live sweep always runs to the current head.
    await lifecycle.stop();
    await auction.stop();
  });

  // ── B2 first: prove the matcher can see, before trusting what it cannot ──

  it("CONTROL: the sweep finds values the protocol publishes on purpose", async () => {
    // If any of these fail, every absence assertion below is meaningless.
    await lifecycle.present([
      // a uint256 in a log — proves log data + topics are scanned
      { name: "maxFare (OrderCreated)", value: MAX_FARE },
      // an address in calldata — proves address matching works
      { name: "winning driver", value: winner.address },
      // a NEGATIVE int32, sign-extended — the encoding the drop longitude uses,
      // so this proves the matcher would catch that longitude if it leaked
      { name: "coarsened pickup lon", value: BigInt(DRIVER_SNAPPED.lon) },
      { name: "coarsened pickup lat", value: BigInt(DRIVER_SNAPPED.lat) },
      // the venue's coordinates are public by design (PRIVACY-TIERS §2)
      { name: "venue lat", value: BigInt(VENUE.lat) },
    ]);
  });

  it("CONTROL: a planted secret is caught in calldata and in a log", async () => {
    // The strongest control available: put a value on-chain deliberately and
    // require the sweep to report it. Anything weaker leaves open the
    // possibility that `absent()` returns clean because scanning is broken.
    const planted = 0xdead_beef_cafe_f00dn;
    const sweep = await LeakSweep.start();

    await deployer.sendTransaction({ to: ethers.Wallet.createRandom().address, data: b32(planted) });
    await sweep.present([{ name: "planted in calldata", value: planted }]);

    const logSweep = await LeakSweep.start();
    await vault.setAuthorized(deployer.address, true);
    await vault.connect(deployer).credit(customer.address, { value: planted }); // emits the amount
    await logSweep.present([{ name: "planted in a log", value: planted }]);
  });

  it("CONTROL: the pre-ZK dropoff shape would have been caught", async () => {
    // The sharpest control available, and the one that actually licenses the
    // claims below: replay the calldata shape the dropoff had BEFORE the ZK
    // path — a LocationAttestation carrying the customer's real coordinates —
    // and require the sweep to flag the very values it reports as absent from
    // the real run. Same secrets, same encoding, opposite verdict.
    const sweep = await LeakSweep.start();
    const preZK = abi.encode(
      ["uint256", "uint8", "address", "int32", "int32", "uint64"],
      [orderId, 2, winner.address, DROP.lat, DROP.lon, await time.latest()]
    );
    await deployer.sendTransaction({ to: ethers.Wallet.createRandom().address, data: preZK });
    await (await sweep.stop()).present([
      { name: "drop latitude", value: BigInt(DROP.lat) },
      { name: "drop longitude", value: BigInt(DROP.lon) },
    ]);

    // And a salt reveal, the other way the commitment could be undone.
    const saltSweep = await LeakSweep.start();
    await deployer.sendTransaction({
      to: ethers.Wallet.createRandom().address,
      data: abi.encode(["uint256", "uint256"], [DROP_SALT, encLat(DROP.lat)]),
    });
    await (await saltSweep.stop()).present([
      { name: "drop salt", value: DROP_SALT },
      { name: "drop latitude (Poseidon-encoded)", value: encLat(DROP.lat) },
    ]);
  });

  // ── B1: the actual claims ────────────────────────────────────────────────

  it("no drop coordinate, in any encoding, reaches the chain", async () => {
    await lifecycle.absent([
      { name: "drop latitude", value: BigInt(DROP.lat) },
      { name: "drop longitude", value: BigInt(DROP.lon) },
      { name: "drop latitude (Poseidon-encoded)", value: encLat(DROP.lat) },
      { name: "drop longitude (Poseidon-encoded)", value: encLon(DROP.lon) },
    ]);
  });

  it("the drop salt never leaves the customer's device", async () => {
    // The salt is what makes the commitment hiding. With it, anyone who guesses
    // a candidate address can confirm it against dropCommit.
    await lifecycle.absent([{ name: "drop salt", value: DROP_SALT }]);
  });

  it("the driver's exact pickup position is coarsened, not merely unemitted", async () => {
    // The coarsened pair IS on-chain (asserted in the control above). What must
    // not be recoverable is the metre-accurate reading behind it.
    await lifecycle.absent([
      { name: "exact pickup latitude", value: BigInt(DRIVER_EXACT.lat) },
      { name: "exact pickup longitude", value: BigInt(DRIVER_EXACT.lon) },
    ]);
  });

  it("a losing bid names neither its driver nor its price", async () => {
    // Scoped to the auction window on purpose: the loser registered as a driver
    // earlier, so their address is legitimately on-chain from that. The claim
    // is narrower and more honest — bidding and losing adds nothing.
    await auction.absent([
      { name: "losing bidder", value: loser.address },
      { name: "losing bid amount", value: LOSING_BID },
    ]);
    // …while the winner is necessarily named, since they get paid.
    await auction.present([{ name: "winning driver", value: winner.address }]);
  });

  // ── the matcher itself ───────────────────────────────────────────────────

  it("fragments() covers the encodings a value actually takes on-chain", async () => {
    // Asserted as properties against real ABI encoding rather than against
    // hand-computed hex — the first version of this test hardcoded the wrong
    // digits for 37,784,900 and failed for that reason alone.
    //
    // The load-bearing property: for a positive value the MINIMAL form is a
    // substring of the padded form, which is why searching for it also catches
    // every wider encoding.
    for (const v of [37_784_913n, 1n, 2n ** 200n]) {
      const [minimal] = fragments(v);
      expect(abi.encode(["uint256"], [v]).toLowerCase(), `uint256 ${v}`).to.include(minimal);
      expect(fragments(v).some((f) => f.length === 64), `padded form for ${v}`).to.equal(true);
    }

    // Negatives are sign-extended, not zero-padded, so they need their own
    // two's-complement forms at both the width they are declared at and the
    // width they occupy in a slot.
    for (const v of [-122_431_777n, -1n]) {
      const encoded = abi.encode(["int256"], [v]).toLowerCase();
      const forms = fragments(v);
      expect(forms.some((f) => f.length === 8), `int32 form for ${v}`).to.equal(true);
      expect(forms.some((f) => f.length === 64 && encoded.includes(f)), `int256 form for ${v}`).to.equal(true);
      // the int32 form is how it appears inside an int32 struct field
      const asInt32 = abi.encode(["int32"], [v]).toLowerCase();
      expect(forms.some((f) => f.length === 8 && asInt32.includes(f))).to.equal(true);
    }

    // Addresses and hex strings are matched raw, without the 0x.
    expect(fragments("0xAbCdEf0123456789012345678901234567890123")).to.deep.equal([
      "abcdef0123456789012345678901234567890123",
    ]);
  });
});
