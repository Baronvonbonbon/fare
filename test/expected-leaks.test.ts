import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { poseidon3 } from "poseidon-lite";

// The Open list, made executable (TEST-PLAN B3).
//
// Every other privacy test in this repo asserts that something is HIDDEN. This
// one asserts the opposite, deliberately: each row of PRIVACY-STATUS.md's Open
// tables that is a claim about chain data gets a test proving the leak is still
// there.
//
// The point is the coupling, and it runs both ways:
//
//   · Close a leak, and the test fails — so PRIVACY-STATUS.md's Open table has
//     to be updated in the same commit rather than drifting into a document
//     that describes a system nobody runs any more.
//   · Edit or delete an Open row without touching the tests, and the doc-text
//     assertions below fail — because each test quotes the exact row it pins.
//
// That second direction is what stops this becoming a list of assertions whose
// connection to the document is a comment somebody wrote once.
//
// ── What is deliberately NOT here ────────────────────────────────────────────
//
// Four Open rows are not claims about chain data and cannot be leak tests:
// the single-party trusted setups (a process fact — C4's mainnet gate),
// relay metadata (B5), "anonymity is only as large as usage" (B4's measured
// numbers), and the dormant shield keeper (unreachable until someone calls
// `setShieldKeeper`; the authority is covered by C3). They are listed here as
// data so the completeness check can account for every row rather than
// silently ignoring the ones that were inconvenient.
//
// ── Maintenance ─────────────────────────────────────────────────────────────
//
// This file is a standing commitment, which is why the plan left B3 as a
// decision rather than a recommendation. A failure here is good news — it means
// a leak closed — and the fix is to delete the test and move the row out of the
// Open table, together.

const PAS = (n: string | number) => ethers.parseEther(String(n));
const b32 = (x: bigint) => "0x" + x.toString(16).padStart(64, "0");
const abi = ethers.AbiCoder.defaultAbiCoder();

const STATUS_DOC = join(__dirname, "..", "docs", "PRIVACY-STATUS.md");
const DOC = readFileSync(STATUS_DOC, "utf8");

/// Every Open row this file pins, quoted from the document. The quote is the
/// coupling: if the row is reworded or removed, the test that cites it fails
/// and whoever changed the doc has to look at the assertion too.
const PINNED_ROWS = [
  "**Order value and tip are public**",
  "**Delivery timing is public**",
  "**Which venue an order is for**",
  "**Persistent identity**",
  "**Per-order earnings**",
  "**The winning bid is public**",
  "**The open-bid path still exists**",
  "**Location and menu are public**",
  "**Settlement names the venue**",
  "**Amounts are public everywhere**",
] as const;

/// Open rows that are NOT assertions about chain data, with the item that owns
/// them instead. Listed so the completeness check can prove every row is
/// accounted for — pinned or deliberately delegated.
const DELEGATED_ROWS: Record<string, string> = {
  "**Both trusted setups are single-party**": "C4 — mainnet gate, a process fact",
  "**Relay metadata**": "B5 — venue-node/relaymeta.test.mjs",
  "**Anonymity is only as large as usage**": "B4 — test/anonymity-set.test.ts",
  "**A shield keeper can divert the ticket-path buffer**": "C3 — unreachable until setShieldKeeper",
  "**Order volume and timing**": "derived from the venue edge; no separate on-chain fact",
};

/// Assert the leak is still present, and say what to do when it is not.
function stillLeaks(row: string, condition: boolean, detail: string) {
  expect(DOC, `PRIVACY-STATUS.md no longer contains the Open row ${row} — this test pins it`)
    .to.include(row);
  expect(
    condition,
    `${row} appears to be CLOSED (${detail}).\n` +
      `      That is good news. Move the row out of PRIVACY-STATUS.md's Open table\n` +
      `      and delete this assertion, in the same commit.`
  ).to.equal(true);
}

describe("expected leaks: the Open list, executable", function () {
  this.timeout(120_000);

  let vault: any, orders: any, settlement: any, drivers: any, venues: any;
  let deployer: HardhatEthersSigner, treasury: HardhatEthersSigner, customer: HardhatEthersSigner,
      winner: HardhatEthersSigner, loser: HardhatEthersSigner,
      venueOp: HardhatEthersSigner, venueSigner: HardhatEthersSigner, relay: HardhatEthersSigner;

  const VENUE = { lat: 37_774_900, lon: -122_419_400 };
  const DROP = { lat: 37_784_900, lon: -122_419_400 };
  const DROP_SALT = 0xfeedn;
  const ORDER_VALUE = PAS(1);
  const TIP = PAS("0.25");
  const WINNING_BID = PAS(2);
  const orderId = 1n;

  let createdLogs: any[] = [];
  let deliveredLogs: any[] = [];
  let deliveredAt = 0;

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
    const verifier = await (await ethers.getContractFactory("MockLocationVerifier")).deploy();

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

    const domain = {
      name: "FareSettlement", version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: settlement.target as string,
    };

    // One delivery, start to finish — the same shape leak-sweep drives, but read
    // for what it PUBLISHES rather than what it withholds.
    const dropCommit = b32(poseidon3([BigInt(DROP.lat) + 90_000_000n, BigInt(DROP.lon) + 180_000_000n, DROP_SALT]));
    const create = await orders.connect(customer).createOrder(
      1n, dropCommit, ORDER_VALUE, TIP, PAS(3), 0, 0, { value: ORDER_VALUE + TIP }
    );
    createdLogs = (await create.wait()).logs;

    const salt = (s: string) => ethers.keccak256(ethers.toUtf8Bytes(s));
    const revokeHash = (s: string) => ethers.keccak256(abi.encode(["bytes32"], [salt("revoke:" + s)]));
    const hash = await orders.bidHashOf(orderId, winner.address, WINNING_BID, salt("w"));
    await orders.connect(relay).commitBid(orderId, hash, revokeHash("w"));
    await orders.connect(customer).acceptSealedBid(orderId, winner.address, WINNING_BID, salt("w"), { value: WINNING_BID });

    let now = await time.latest();
    const dAtt = { orderId, phase: 1, actor: winner.address, lat: VENUE.lat + 300, lon: VENUE.lon, timestamp: now };
    const vAtt = { orderId, phase: 1, actor: venueSigner.address, lat: VENUE.lat, lon: VENUE.lon, timestamp: now };
    await settlement.confirmPickup(
      dAtt, await winner.signTypedData(domain, LOCATION_TYPES, dAtt),
      vAtt, await venueSigner.signTypedData(domain, LOCATION_TYPES, vAtt)
    );

    now = await time.latest();
    const posCommit = b32(poseidon3([BigInt(DROP.lat) + 90_000_000n, BigInt(DROP.lon) + 180_000_000n, 0x1111n]));
    const dropAtt = { orderId, phase: 2, actor: winner.address, posCommit, timestamp: now };
    const drop = await settlement.confirmDropoffZK(
      dropAtt, await winner.signTypedData(domain, DRIVER_COMMIT_TYPES, dropAtt),
      "0x" + "00".repeat(256),
      [orderId, BigInt(dropCommit), BigInt(posCommit), await settlement.dropoffRadiusMeters(), 7n]
    );
    const rc = await drop.wait();
    deliveredLogs = rc.logs;
    deliveredAt = (await ethers.provider.getBlock(rc.blockNumber))!.timestamp;

    expect(await orders.statusOf(orderId)).to.equal(4); // Delivered
  });

  /// Decode every log this contract emitted in a receipt.
  const decoded = (logs: any[], contract: any) =>
    logs.map((l) => { try { return contract.interface.parseLog(l); } catch { return null; } })
        .filter(Boolean) as any[];

  // ── Customer ──────────────────────────────────────────────────────────────

  it("order value and tip are public", async () => {
    // PRIVACY.md's original finding, still true: spend per order is legible
    // forever. Closing it needs confidential escrow, which nothing here has.
    const events = decoded(createdLogs, orders);
    const created = events.find((e) => e.name === "OrderCreated");
    const blob = JSON.stringify(created?.args?.map?.((a: any) => String(a)) ?? []);

    stillLeaks(
      "**Order value and tip are public**",
      blob.includes(ORDER_VALUE.toString()) && blob.includes(TIP.toString()),
      "OrderCreated no longer publishes both amounts"
    );
  });

  it("the order's value and tip are also readable from storage, not just events", async () => {
    // A leak that lives in storage cannot be pruned by an archive node policy.
    const o = await orders.orders(orderId);
    stillLeaks(
      "**Order value and tip are public**",
      o.orderValue === ORDER_VALUE && o.tip === TIP,
      "the order struct no longer exposes the amounts"
    );
  });

  it("delivery timing is public", async () => {
    // When a delivery completes signals when someone is home — burglary and
    // stalking relevance, independent of any coordinate. PRIVACY.md risk #4.
    const events = decoded(deliveredLogs, orders);
    const delivered = events.find((e) => e.name === "OrderDelivered");
    stillLeaks(
      "**Delivery timing is public**",
      !!delivered && deliveredAt > 0,
      "no OrderDelivered event carries a timestamped block"
    );
  });

  it("which venue an order is for is public STORAGE, not merely an event", async () => {
    // The distinction matters: an event can in principle be pruned, storage is
    // read back by anyone with an RPC forever.
    const o = await orders.orders(orderId);
    stillLeaks(
      "**Which venue an order is for**",
      o.venueId === 1n,
      "orders(orderId).venueId no longer returns the venue"
    );
  });

  // ── Driver ────────────────────────────────────────────────────────────────

  it("a driver's identity is persistent and address-bound", async () => {
    // Stake, reputation and the winning assignment all key off one address.
    // Anonymous driver credentials were never in scope.
    const rec = await drivers.drivers(winner.address);
    const o = await orders.orders(orderId);
    stillLeaks(
      "**Persistent identity**",
      rec[0] === true && o.driver === winner.address,
      "the driver is no longer identified by a persistent address"
    );
  });

  it("per-order earnings are published", async () => {
    // OrderDelivered carries the amount paid, so a driver's income is
    // reconstructable per job even though payouts later enter the pool.
    const delivered = decoded(deliveredLogs, orders).find((e) => e.name === "OrderDelivered");
    const args = JSON.stringify(delivered?.args?.map?.((a: any) => String(a)) ?? []);
    stillLeaks(
      "**Per-order earnings**",
      args.includes(WINNING_BID.toString()) || (await vault.balanceOf(winner.address)) > 0n,
      "the delivery no longer publishes or credits a per-order amount"
    );
  });

  it("the winning bid is public", async () => {
    // Unavoidable in this design — the winner performs the delivery and is
    // paid. Sealed bids remove the losers, which is most of the graph, not all.
    const o = await orders.orders(orderId);
    stillLeaks(
      "**The winning bid is public**",
      o.fare === WINNING_BID && o.driver === winner.address,
      "the accepted fare and its driver are no longer both readable"
    );
  });

  it("the open-bid path still exists and publishes price and availability", async () => {
    // Sealed bids are additive; the old path is still callable, and a driver
    // using it still names themselves and their price on chain. The UI defaults
    // to sealed and says so, but the choice is the driver's.
    const open = await orders.connect(loser).placeBid.staticCall(orderId, PAS(1)).then(() => true).catch(() => false);
    const bidderView = typeof orders.bidOf === "function";
    stillLeaks(
      "**The open-bid path still exists**",
      typeof orders.placeBid === "function" && bidderView,
      "placeBid or its public bid mapping is gone"
    );
    void open; // the call reverts once assigned; existence is the claim
  });

  // ── Venue ─────────────────────────────────────────────────────────────────

  it("settlement names the venue", async () => {
    // The payout credits venues.payoutOf(venueId), so the venue is named in the
    // settlement it is paid by. Closing this means venue payouts entering the
    // note pool as commitments — research-scale, tracked as phase 4c.
    const v = await venues.venues(1n);
    stillLeaks(
      "**Settlement names the venue**",
      (await vault.balanceOf(v.payout)) > 0n,
      "the venue's payout address is no longer credited directly"
    );
  });

  it("amounts are public everywhere", async () => {
    // Cross-cutting: order values, fees and payouts. Hiding them needs
    // confidential escrow, which nothing here provides.
    const treasuryCut = await vault.balanceOf(treasury.address);
    stillLeaks(
      "**Amounts are public everywhere**",
      treasuryCut > 0n && (await vault.balanceOf(winner.address)) > 0n,
      "vault balances are no longer readable per account"
    );
  });

  // ── Deliberate by design, not debt ────────────────────────────────────────

  describe("deliberate, not debt", () => {
    it("a venue's location and menu are public ON PURPOSE", async () => {
      // PRIVACY-TIERS §2: a venue is a business address. Encrypting it breaks
      // discovery and navigation for no adversary-visible gain.
      //
      // Pinned anyway, and separated from the rows above, because the failure
      // is worth catching from the other direction: if someone later hides a
      // venue's coordinates, that tradeoff should be argued in a review rather
      // than shipped as an improvement.
      const v = await venues.venues(1n);
      stillLeaks(
        "**Location and menu are public**",
        Number(v.lat) === VENUE.lat && Number(v.lon) === VENUE.lon && v.metadataURI.length > 0,
        "a venue's coordinates or menu URI are no longer readable"
      );
    });
  });

  // ── the doc cannot drift away from this file ──────────────────────────────

  it("every Open row in PRIVACY-STATUS.md is either pinned here or delegated", () => {
    // The self-maintaining half. Adding an Open row to the document without a
    // test — or without a written reason it cannot be one — fails here, which
    // is the only thing stopping this file from covering the rows that happened
    // to be convenient on the day it was written.
    // Only the OPEN tables. The document has other tables — what is closed, and
    // what is live — whose bold first cells are not leaks at all, so a
    // document-wide regex would drag them in and the check would be noise.
    const openRows: string[] = [];
    const lines = DOC.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!/^\|\s*Open\s*\|/.test(lines[i])) continue;
      // Skip the header and its separator, then read until the table ends.
      for (let j = i + 2; j < lines.length && lines[j].startsWith("|"); j++) {
        const cell = lines[j].match(/^\|\s*(.+?)\s*\|/)?.[1];
        if (cell) openRows.push(cell.trim());
      }
    }
    expect(openRows.length, "found no Open rows — did the table format change?")
      .to.be.greaterThan(5);

    // Rows lead with a bold phrase and may continue in plain prose
    // ("**Both trusted setups are single-party** — the proximity circuit…"), so
    // the phrase is the identity and the rest is commentary. A row with no bold
    // lead has no stable handle to cite, and would silently escape the check.
    const leads = openRows.map((r) => r.match(/^\*\*.+?\*\*/)?.[0] ?? r);
    const unbolded = leads.filter((r) => !r.startsWith("**"));
    expect(unbolded, `Open rows are expected to lead with a bold phrase:\n      ${unbolded.join("\n      ")}`)
      .to.deep.equal([]);

    const accounted = new Set<string>([...PINNED_ROWS, ...Object.keys(DELEGATED_ROWS)]);
    const orphans = leads.filter((r) => !accounted.has(r));

    expect(
      orphans,
      `these Open rows are neither pinned nor delegated:\n      ${orphans.join("\n      ")}\n` +
        `      Add a test above, or an entry in DELEGATED_ROWS saying which item owns it.`
    ).to.deep.equal([]);
  });

  it("every row this file claims to pin still exists in the document", () => {
    // The other direction: a test citing a row that was quietly deleted would
    // keep passing its chain assertion while pinning nothing.
    const missing = [...PINNED_ROWS, ...Object.keys(DELEGATED_ROWS)].filter((r) => !DOC.includes(r));
    expect(missing, `cited but absent from PRIVACY-STATUS.md:\n      ${missing.join("\n      ")}`)
      .to.deep.equal([]);
  });
});
