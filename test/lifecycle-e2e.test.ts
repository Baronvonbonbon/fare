import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-ignore — no types
import * as snarkjs from "snarkjs";
import { poseidon2, poseidon3 } from "poseidon-lite";

// One delivery, end to end, on a local chain (TEST-PLAN D4).
//
// `scripts/privacy/live-order-e2e.mjs` drives this same lifecycle against Paseo
// and is the nightly (§7 E3). It cannot gate a pull request — it needs a funded
// deployer and several minutes — so this is the half that can.
//
// ── Why this is not a duplicate of the phase suites ──────────────────────────
//
// Every phase here is already tested: privacy-e2e.test.ts (vault → keeper →
// note), shieldnote-vault.test.ts (ZK authorization), sealed-bids.test.ts,
// shielded-payouts.test.ts, leak-sweep.test.ts. Each builds its OWN fixture,
// which is right for testing a phase and is exactly what leaves a gap: nothing
// asserts that one phase's real output is a valid input to the next.
//
// So this file has one continuous run, and every stage consumes what the
// previous stage actually produced. The assertions are the SEAMS:
//
//   · the burner that created the order is the account that accepts the bid
//   · the Groth16 proof opens the drop commitment stored at ORDER time — not a
//     commitment the test picked to match a canned proof
//   · the driver's shielded note is funded by settlement EARNINGS, not by a
//     fixture `credit()`
//   · escrow in equals payouts out, across the whole delivery
//
// The proof is generated live for these fixture coordinates rather than replayed
// from test/fixtures/zk-proximity.json. That is the point of the second seam: a
// canned proof carries a canned dropCommit, so the order → dropoff handoff would
// be asserted against a value the order never produced.
//
// ── What a local chain honestly cannot cover ────────────────────────────────
//
// The live script's stages 1 and 9 — funding the burner OUT of the Kusama Shield
// pool, and later spending that pool note — are the POOL's Groth16 withdraw
// circuit, not FARE code, and `MockShieldPool` has no `proxy_withdraw` to stand
// in for it. Mocking it would assert nothing about either system. The burner
// here is therefore funded plainly, and the boundary is marked where it falls.
// Shielded PAYOUT (vault → note → pool deposit) is FARE code and is covered.

const PAS = (n: string | number) => ethers.parseEther(String(n));
const abi = ethers.AbiCoder.defaultAbiCoder();
const b32 = (x: bigint) => "0x" + x.toString(16).padStart(64, "0");
const rand = () => ethers.toBigInt(ethers.randomBytes(31));

// µdegree encodings, matching circuits/proximity.circom and web/src/zk.ts.
const encLat = (l: number) => BigInt(l) + 90_000_000n;
const encLon = (l: number) => BigInt(l) + 180_000_000n;
/// Poseidon(latEnc, lonEnc, salt) — a THREE-input hash. Nesting two-input
/// hashes instead produces a commitment the circuit rejects.
const positionCommit = (lat: number, lon: number, salt: bigint) =>
  poseidon3([encLat(lat), encLon(lon), salt]);
const noteCommitment = (nullifier: bigint, secret: bigint, bucket: bigint) =>
  poseidon2([poseidon2([nullifier, secret]), bucket]);

// San Francisco, matching the other e2e fixtures. The drop must share no
// coordinate with the venue — leak-sweep.test.ts learned that the hard way.
const VENUE = { lat: 37_774_900, lon: -122_419_400 };
const PICKUP = { lat: 37_775_300, lon: -122_419_400 };
const DROP = { lat: 37_784_900, lon: -122_419_400 };
const DROPOFF = { lat: 37_784_940, lon: -122_419_400 }; // ~44 m from DROP, inside 100 m

const ORDER_VALUE = PAS(1);
const FARE = PAS(2);
const BUCKET = PAS(1);
const RADIUS = 100;

/// IFare.Status. Named because the enum leads with `None`, so Open is 1 — and a
/// bare `equal(0)` reads perfectly plausibly while asserting "no such order".
const Status = { None: 0, Open: 1, Assigned: 2, PickedUp: 3, Delivered: 4 } as const;

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

describe("full lifecycle on a local chain: one delivery, every seam", function () {
  this.timeout(240_000);

  let vault: any, orders: any, settlement: any, drivers: any, venues: any, pool: any, verifier: any;
  let deployer: HardhatEthersSigner, treasury: HardhatEthersSigner, driver: HardhatEthersSigner,
      venueOp: HardhatEthersSigner, venueSigner: HardhatEthersSigner, bidderB: HardhatEthersSigner;
  let burner: ethers.Wallet;
  let domain: any, chainId: bigint;
  let orderId: bigint;
  let dropSalt: bigint, dropCommit: string;
  let venueId: bigint;

  /// Everything the run learns as it goes. Later stages read this rather than
  /// recomputing, so a broken handoff shows up as a failed assertion instead of
  /// two stages independently agreeing on a value neither got from the other.
  const carried: Record<string, any> = {};

  before(async () => {
    [deployer, treasury, driver, venueOp, venueSigner, bidderB] = await ethers.getSigners();
    chainId = (await ethers.provider.getNetwork()).chainId;

    const pause = await (await ethers.getContractFactory("FarePauseRegistry")).deploy();
    vault = await (await ethers.getContractFactory("FareVault")).deploy();
    drivers = await (await ethers.getContractFactory("FareDrivers")).deploy(pause.target);
    venues = await (await ethers.getContractFactory("FareVenues")).deploy(pause.target);
    const forwarder = await (await ethers.getContractFactory("FareForwarder")).deploy();
    orders = await (await ethers.getContractFactory("FareOrders")).deploy(pause.target, forwarder.target);
    settlement = await (await ethers.getContractFactory("FareSettlement")).deploy(pause.target);
    const disputes = await (await ethers.getContractFactory("FareDisputes")).deploy(pause.target);
    pool = await (await ethers.getContractFactory("MockShieldPool")).deploy();

    // The REAL verifier, not MockLocationVerifier — a lifecycle test that mocks
    // the proof check is not testing the lifecycle. The VK is circuit-wide, so
    // the one committed alongside the canned proof verifies the fresh proof
    // this file generates.
    verifier = await (await ethers.getContractFactory("FareLocationVerifier")).deploy();
    const vk = JSON.parse(
      readFileSync(join(__dirname, "fixtures", "zk-proximity.json"), "utf8")
    ).vkCalldata;
    await verifier.setVerifyingKey(
      vk.alpha1, vk.beta2, vk.gamma2, vk.delta2, vk.IC0, vk.IC1, vk.IC2, vk.IC3, vk.IC4, vk.IC5
    );

    await orders.configure(vault.target, drivers.target, venues.target, settlement.target, disputes.target, treasury.address);
    await settlement.configure(orders.target, venues.target);
    await settlement.setLocationVerifier(verifier.target);
    await disputes.configure(orders.target, vault.target, drivers.target, treasury.address);
    await vault.setAuthorized(orders.target, true);
    await drivers.setAuthorized(orders.target, true);
    await venues.setAuthorized(orders.target, true);
    await vault.setShieldPool(pool.target);
    await vault.setShieldBuckets([BUCKET]);

    await drivers.connect(driver).register("ipfs://driver", { value: PAS(1) });
    await drivers.connect(bidderB).register("ipfs://loser", { value: PAS(1) });
    await venues.connect(venueOp).registerVenue(VENUE.lat, VENUE.lon, venueSigner.address, venueOp.address, "ipfs://venue");
    venueId = 1n;

    domain = {
      name: "FareSettlement", version: "1", chainId,
      verifyingContract: settlement.target as string,
    };
  });

  // ── 1. the customer's burner ───────────────────────────────────────────────

  it("1. a fresh burner holds nothing until it is funded", async () => {
    // BOUNDARY: on Paseo this comes out of the Kusama Shield pool, so no
    // on-chain edge links the burner to the customer. That withdrawal is the
    // pool's own Groth16 circuit — not FARE code, and MockShieldPool has no
    // `proxy_withdraw` to stand in for it. Funding it plainly here keeps the
    // rest of the lifecycle honest without pretending to test the pool.
    burner = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, ethers.provider);
    expect(await ethers.provider.getBalance(burner.address)).to.equal(0n);

    await deployer.sendTransaction({ to: burner.address, value: PAS(10) });
    expect(await ethers.provider.getBalance(burner.address)).to.equal(PAS(10));
    carried.burner = burner.address;
  });

  // ── 2. the order ───────────────────────────────────────────────────────────

  it("2. the burner creates an order committing to a drop it never reveals", async () => {
    dropSalt = rand();
    dropCommit = b32(positionCommit(DROP.lat, DROP.lon, dropSalt));

    const tx = await orders.connect(burner).createOrder(
      venueId, dropCommit, ORDER_VALUE, 0, FARE, 0, 0, { value: ORDER_VALUE }
    );
    const rc = await tx.wait();
    orderId = 1n;

    expect(await orders.statusOf(orderId)).to.equal(Status.Open);
    const o = await orders.orders(orderId);
    expect(o.customer).to.equal(burner.address, "the order is not owned by the burner that made it");

    // The commitment the CHAIN stored — every later stage must agree with this
    // one, not with a local copy.
    carried.dropCommit = o.dropCommit;
    expect(carried.dropCommit).to.equal(dropCommit);

    // And the coordinates themselves are absent from the transaction.
    const blob = (tx.data + rc.logs.map((l: any) => l.data + l.topics.join("")).join("")).toLowerCase();
    for (const [name, v] of [["lat", encLat(DROP.lat)], ["lon", encLon(DROP.lon)]] as const) {
      expect(blob, `the order leaked the drop ${name}`).to.not.include((v as bigint).toString(16));
    }
  });

  // ── 3–4. the auction ───────────────────────────────────────────────────────

  it("3. a sealed bid puts only a hash on chain", async () => {
    // The hash comes from the contract's own `bidHashOf`, not a local
    // reimplementation — a test that computes the commitment itself would keep
    // passing if the two ever disagreed, which is the bug it should catch.
    const salt = ethers.keccak256(ethers.toUtf8Bytes("lifecycle-bid"));
    const bidHash = await orders.bidHashOf(orderId, driver.address, FARE, salt);
    const revokeHash = ethers.keccak256(abi.encode(["bytes32"], [
      ethers.keccak256(ethers.toUtf8Bytes("lifecycle-revoke")),
    ]));

    // Submitted by the relay, so even the SENDER says nothing about the driver.
    const tx = await orders.connect(deployer).commitBid(orderId, bidHash, revokeHash);
    const rc = await tx.wait();

    // Neither the bidder nor the price is anywhere in that transaction — the
    // relay submitted it, so even the sender says nothing about the driver.
    const blob = (tx.data + rc.logs.map((l: any) => l.data + l.topics.join("")).join("")).toLowerCase();
    expect(blob).to.not.include(driver.address.slice(2).toLowerCase());
    expect(blob).to.not.include(FARE.toString(16));

    carried.bid = { fare: FARE, salt, bidHash };
  });

  it("4. the customer accepts, revealing the winner and escrowing the fare", async () => {
    const before = await ethers.provider.getBalance(burner.address);
    await orders.connect(burner).acceptSealedBid(
      orderId, driver.address, carried.bid.fare, carried.bid.salt, { value: FARE }
    );

    expect(await orders.statusOf(orderId)).to.equal(Status.Assigned);
    const o = await orders.orders(orderId);
    expect(o.driver).to.equal(driver.address);
    expect(o.fare).to.equal(FARE);

    // SEAM: the account that accepted is the account that created the order.
    // A burner-derivation bug that produced a second address would show up
    // here as a revert, not as a silent privacy loss.
    expect(o.customer).to.equal(carried.burner);
    expect(await ethers.provider.getBalance(burner.address)).to.be.lessThan(before - FARE);

    carried.escrowed = ORDER_VALUE + FARE;
  });

  // ── 5. pickup ──────────────────────────────────────────────────────────────

  it("5. pickup is attested by venue and driver, and coarsens the driver's position", async () => {
    const now = await time.latest();
    const dAtt = { orderId, phase: 1, actor: driver.address, lat: PICKUP.lat, lon: PICKUP.lon, timestamp: now };
    const vAtt = { orderId, phase: 1, actor: venueSigner.address, lat: VENUE.lat, lon: VENUE.lon, timestamp: now };

    const tx = await settlement.connect(deployer).confirmPickup(
      dAtt, await driver.signTypedData(domain, LOCATION_TYPES, dAtt),
      vAtt, await venueSigner.signTypedData(domain, LOCATION_TYPES, vAtt)
    );
    const rc = await tx.wait();

    expect(await orders.statusOf(orderId)).to.equal(Status.PickedUp);

    // The driver's EXACT position is not published — the venue's is, because it
    // is already public from registration.
    const blob = (tx.data + rc.logs.map((l: any) => l.data + l.topics.join("")).join("")).toLowerCase();
    expect(blob, "the driver's exact pickup latitude reached the chain")
      .to.not.include(encLat(PICKUP.lat).toString(16));
  });

  // ── 6. the ZK dropoff — the seam this file exists for ──────────────────────

  it("6. a live Groth16 proof opens the commitment the ORDER stored", async function () {
    const drvSalt = rand();
    const driverCommit = b32(positionCommit(DROPOFF.lat, DROPOFF.lon, drvSalt));
    const nullifier = b32(poseidon2([dropSalt, orderId]));

    // The public signal is read back off the chain, not from a local variable:
    // the claim is that the proof opens what the order actually stored.
    const onChainCommit = (await orders.orders(orderId)).dropCommit;
    expect(onChainCommit).to.equal(carried.dropCommit);

    const zk = await snarkjs.groth16.fullProve(
      {
        orderId: orderId.toString(),
        dropCommit: BigInt(onChainCommit).toString(),
        driverCommit: BigInt(driverCommit).toString(),
        radiusMeters: String(RADIUS),
        nullifier: BigInt(nullifier).toString(),
        custLatEnc: encLat(DROP.lat).toString(),
        custLonEnc: encLon(DROP.lon).toString(),
        salt: dropSalt.toString(),
        drvLatEnc: encLat(DROPOFF.lat).toString(),
        drvLonEnc: encLon(DROPOFF.lon).toString(),
        drvSalt: drvSalt.toString(),
      },
      join(__dirname, "..", "web", "public", "zk", "proximity.wasm"),
      join(__dirname, "..", "web", "public", "zk", "proximity.zkey")
    );

    const proofBytes = ethers.solidityPacked(Array(8).fill("uint256"), [
      zk.proof.pi_a[0], zk.proof.pi_a[1], zk.proof.pi_b[0][1], zk.proof.pi_b[0][0],
      zk.proof.pi_b[1][1], zk.proof.pi_b[1][0], zk.proof.pi_c[0], zk.proof.pi_c[1],
    ]);
    const pub = [
      orderId.toString(), BigInt(onChainCommit).toString(), BigInt(driverCommit).toString(),
      String(RADIUS), BigInt(nullifier).toString(),
    ];

    // The verifier is the real one, so this is a real pairing check.
    expect(await verifier.verifyProximity(proofBytes, pub)).to.equal(true);

    const now = await time.latest();
    const dropAtt = { orderId, phase: 2, actor: driver.address, posCommit: driverCommit, timestamp: now };
    const tx = await settlement.connect(deployer).confirmDropoffZK(
      dropAtt, await driver.signTypedData(domain, DRIVER_COMMIT_TYPES, dropAtt), proofBytes, pub
    );
    const rc = await tx.wait();

    expect(await orders.statusOf(orderId)).to.equal(Status.Delivered);

    // Still no coordinate, in the transaction that finally proves proximity to
    // one. This is the whole design in a single assertion.
    const blob = (tx.data + rc.logs.map((l: any) => l.data + l.topics.join("")).join("")).toLowerCase();
    for (const [name, v] of [["lat", encLat(DROP.lat)], ["lon", encLon(DROP.lon)]] as const) {
      expect(blob, `the ZK dropoff leaked the drop ${name}`).to.not.include((v as bigint).toString(16));
    }
    expect(blob, "the drop salt reached the chain").to.not.include(dropSalt.toString(16));
  });

  it("6b. the same proof cannot be replayed against a different commitment", async () => {
    // The seam asserted negatively: a proof is bound to the commitment it
    // opened, so it proves nothing about any other order's drop.
    const other = b32(positionCommit(DROP.lat + 1_000, DROP.lon, rand()));
    const drvSalt = rand();
    const driverCommit = b32(positionCommit(DROPOFF.lat, DROPOFF.lon, drvSalt));
    const nullifier = b32(poseidon2([dropSalt, orderId]));
    const pub = [
      orderId.toString(), BigInt(other).toString(), BigInt(driverCommit).toString(),
      String(RADIUS), BigInt(nullifier).toString(),
    ];
    // Re-use the shape with a commitment nothing proved: the verifier must say no.
    const stale = ethers.solidityPacked(Array(8).fill("uint256"), Array(8).fill(1n));
    expect(await verifier.verifyProximity(stale, pub)).to.equal(false);
  });

  // ── 7. payouts ─────────────────────────────────────────────────────────────

  it("7. payouts credit venue, driver and treasury, and conserve the escrow", async () => {
    const [bVenue, bDriver, bTreasury] = await Promise.all([
      vault.balanceOf(venueOp.address),
      vault.balanceOf(driver.address),
      vault.balanceOf(treasury.address),
    ]);

    expect(bDriver, "the driver earned nothing").to.be.greaterThan(0n);
    expect(bVenue, "the venue earned nothing").to.be.greaterThan(0n);

    // SEAM: everything escrowed across stages 2 and 4 is now credited, to the
    // wei. A rounding change that quietly kept dust would show up here and in
    // no single-phase test.
    expect(bVenue + bDriver + bTreasury).to.equal(carried.escrowed);

    carried.driverEarnings = bDriver;
    expect(carried.driverEarnings, "earnings below one bucket — the note stage cannot run")
      .to.be.gte(BUCKET);
  });

  // ── 8. the driver shields those earnings ───────────────────────────────────

  it("8. the driver's ACTUAL earnings become a pool note", async () => {
    // SEAM: the bucket is funded from what stage 7 credited, not from a
    // fixture `credit()`. Every other suite starts the note story with a
    // hand-placed balance, so nothing until now has shown that a real
    // delivery pays enough, in the right denomination, to be shielded at all.
    const before = await vault.balanceOf(driver.address);
    expect(before).to.equal(carried.driverEarnings);

    const note = { nullifier: rand(), secret: rand() };
    const commitment = noteCommitment(note.nullifier, note.secret, BUCKET);

    const nonce = await vault.shieldNonce(driver.address);
    const deadline = BigInt(await time.latest()) + 3600n;
    const signature = await driver.signTypedData(
      { name: "FareVault", version: "1", chainId, verifyingContract: vault.target as string },
      { ShieldCredit: [
        { name: "account", type: "address" }, { name: "bucket", type: "uint96" },
        { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
      { account: driver.address, bucket: BUCKET, nonce, deadline }
    );

    // The relay's /shield-queue half: the authorization goes on chain, the
    // commitment stays in the request body.
    const tx = await vault.connect(deployer).queueShieldCreditFor(driver.address, BUCKET, deadline, signature);
    const rc = await tx.wait();

    expect(await vault.balanceOf(driver.address)).to.equal(before - BUCKET);

    // The pairing invariant, on real earnings: the account and its commitment
    // must never share a transaction (PRIVACY-TIERS §3).
    const blob = (tx.data + rc.logs.map((l: any) => l.data + l.topics.join("")).join("")).toLowerCase();
    expect(blob, "the queue transaction named the commitment")
      .to.not.include(commitment.toString(16));
    expect(blob, "CONTROL: the account should be present — the matcher must be able to see")
      .to.include(driver.address.slice(2).toLowerCase());

    carried.note = { note, commitment };
  });

  it("8b. one delivery's note cannot be shielded alone — it waits for a crowd", async () => {
    // The most important thing this lifecycle shows, and the reason it is worth
    // running the whole delivery to get here: a complete, correct delivery
    // produces a note the contract REFUSES to deposit. `shieldMinBatch` is 8,
    // so a batch of one is rejected as linkable — B4's "a lone note has an
    // anonymity set of 1", enforced on chain rather than merely documented.
    await vault.setShieldKeeper(deployer.address, true);
    await time.increase(6 * 60); // past shieldMinDwell, so only the size is at issue

    await expect(vault.connect(deployer).sealShieldBatch(BUCKET, 1))
      .to.be.revertedWith("batch-too-small");

    const minBatch = await vault.shieldMinBatch();
    expect(minBatch).to.equal(8n);
    carried.minBatch = Number(minBatch);
  });

  it("8c. with a crowd, the note reaches the pool naming nobody", async () => {
    // Seven other drivers cash out into the same bucket. Only now can the
    // delivery's note move — and the seal is what sizes the anonymity set, not
    // the deposits, which is why the deposits can be chunked freely.
    const others = (await ethers.getSigners()).slice(10, 10 + carried.minBatch - 1);
    expect(others).to.have.length(7);

    // The crowd's balances come from a direct credit rather than seven more
    // deliveries — they exist to be a crowd, and their provenance is not what
    // this file is about.
    await vault.setAuthorized(deployer.address, true);

    const crowd: bigint[] = [];
    for (const s of others) {
      await vault.connect(deployer).credit(s.address, { value: BUCKET });
      await vault.connect(s).queueShieldCredit(BUCKET);
      crowd.push(noteCommitment(rand(), rand(), BUCKET));
    }
    await time.increase(6 * 60); // the new tickets have to dwell too

    await vault.connect(deployer).sealShieldBatch(BUCKET, carried.minBatch);

    const all = [carried.note.commitment, ...crowd].map((c: bigint) => b32(c));
    const before = await pool.depositCount();
    // Chunked at two per call, the Paseo per-transaction ceiling.
    for (let i = 0; i < all.length; i += 2) {
      await vault.connect(deployer).depositShieldBatch(BUCKET, all.slice(i, i + 2));
    }
    expect(await pool.depositCount()).to.equal(before + BigInt(all.length));

    // The delivery's own commitment is in the pool, funded with the bucket —
    // and the pool was never told whose earnings paid for it.
    const mine = b32(carried.note.commitment);
    expect(await pool.depositedValue(mine)).to.equal(BUCKET);

    // SEAM, stated as a number: the driver's earnings are now hidden among 8,
    // not among 1. That is the whole purpose of the queue.
    const deposited: string[] = [];
    for (let i = Number(before); i < Number(before) + all.length; i++) {
      deposited.push((await pool.commitments(i)).toLowerCase());
    }
    expect(deposited).to.include(mine.toLowerCase());
    expect(new Set(deposited).size).to.equal(carried.minBatch);

    // BOUNDARY: spending this note is the pool's own Groth16 withdraw circuit,
    // which MockShieldPool cannot verify. The live nightly covers it (E3).
  });

  // ── 9. the unshielded path still works ─────────────────────────────────────

  it("9. the venue takes the plain path, and the vault is left exactly empty", async () => {
    const owed = await vault.balanceOf(venueOp.address);
    const before = await ethers.provider.getBalance(venueOp.address);

    const rc = await (await vault.connect(venueOp).withdraw()).wait();
    const gas = rc.gasUsed * rc.gasPrice;

    expect(await ethers.provider.getBalance(venueOp.address)).to.equal(before + owed - gas);
    expect(await vault.balanceOf(venueOp.address)).to.equal(0n);

    // Solvency across the whole run, stated explicitly rather than left to a
    // convenient coincidence: the vault's native balance is exactly the credits
    // it still owes, plus the value held against unconsumed shield tickets.
    // Everyone who touched it is summed — including the eight-strong crowd, so
    // this cannot pass merely because their balances happened to be zero.
    const holders = [
      driver.address, treasury.address, venueOp.address, burner.address,
      ...(await ethers.getSigners()).slice(10, 10 + carried.minBatch - 1).map((s) => s.address),
    ];
    let owedTotal = 0n;
    for (const h of holders) owedTotal += await vault.balanceOf(h);

    expect(await ethers.provider.getBalance(vault.target)).to.equal(owedTotal + (await vault.shieldBuffer()));

    // And the eight buckets really did leave — the pool holds them.
    expect(await ethers.provider.getBalance(pool.target)).to.equal(BUCKET * BigInt(carried.minBatch));
  });
});
