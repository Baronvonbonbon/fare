import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// Randomized invariant / fuzz campaign. A seeded PRNG drives a long sequence of
// real protocol operations (create, bid, accept, tip, cancel, abandon, pickup,
// ZK dropoff, dispute, resolve, withdraw, dust-claim) against the full contract
// system, and after every successful operation asserts the money invariants.
//
// Reproduce a failure by re-running with the printed seed:
//   FUZZ_SEED=123456 FUZZ_OPS=150 npx hardhat test test/invariant.test.ts
//
// Invariants (exact equalities, checked every step):
//   INV-1  escrow conservation : balance(FareOrders)  == Σ order.escrow
//   INV-2  vault solvency       : balance(FareVault)   == Σ balanceOf + Σ pendingPaseoDust
//   INV-4  credited/withdrawn   : totalCredited − totalWithdrawn == Σ balanceOf
// (INV-2 carries the Paseo dust-queue term because _safeSend runs on any EVM.)

// Fixed default seed keeps `npm test` deterministic + reproducible; override for
// broad exploration, e.g. `for s in $(seq 1 50); do FUZZ_SEED=$s npx hardhat
// test test/invariant.test.ts; done`.
const SEED = Number(process.env.FUZZ_SEED ?? 0xfa5e);
const OPS = Number(process.env.FUZZ_OPS ?? 160);
const ORDER_CAP = 60; // bound Σ order.escrow to keep the O(n) check fast

// mulberry32 — tiny deterministic PRNG so a seed fully reproduces a run.
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("Invariant fuzz: escrow conservation & vault solvency", () => {
  const VENUE_LAT = 37_774_900;
  const VENUE_LON = -122_419_400;
  const abi = ethers.AbiCoder.defaultAbiCoder();

  const LOCATION_TYPES = {
    LocationAttestation: [
      { name: "orderId", type: "uint256" },
      { name: "phase", type: "uint8" },
      { name: "actor", type: "address" },
      { name: "lat", type: "int32" },
      { name: "lon", type: "int32" },
      { name: "timestamp", type: "uint64" },
    ],
  };
  const DRIVER_COMMIT_TYPES = {
    DriverCommitAttestation: [
      { name: "orderId", type: "uint256" },
      { name: "phase", type: "uint8" },
      { name: "actor", type: "address" },
      { name: "posCommit", type: "bytes32" },
      { name: "timestamp", type: "uint64" },
    ],
  };

  it(`holds under ${OPS} randomized operations (seed=${SEED})`, async function () {
    this.timeout(300_000);
    const rng = mulberry32(SEED);
    const randInt = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
    const pick = <T>(arr: T[]): T => arr[Math.floor(rng() * arr.length)];
    // Small, messy-on-purpose amounts so fee/split math produces dust and
    // exercises INV-2's pending-dust term.
    const someWei = () => BigInt(randInt(0, 900)) * 10n ** 15n + BigInt(randInt(0, 999999));

    const signers = await ethers.getSigners();
    const [deployer, treasury, venueOp, venueSigner] = signers;
    const customers = signers.slice(4, 8);
    const drivers = signers.slice(8, 12);

    // ── Deploy + wire the full system (mock verifier so ZK dropoff is drivable).
    const pause = await (await ethers.getContractFactory("FarePauseRegistry")).deploy();
    const vault = await (await ethers.getContractFactory("FareVault")).deploy();
    const driversC = await (await ethers.getContractFactory("FareDrivers")).deploy(pause.target);
    const venues = await (await ethers.getContractFactory("FareVenues")).deploy(pause.target);
    const orders = await (await ethers.getContractFactory("FareOrders")).deploy(pause.target);
    const settlement = await (await ethers.getContractFactory("FareSettlement")).deploy(pause.target);
    const disputes = await (await ethers.getContractFactory("FareDisputes")).deploy(pause.target);
    const verifier = await (await ethers.getContractFactory("MockLocationVerifier")).deploy();

    await orders.configure(vault.target, driversC.target, venues.target, settlement.target, disputes.target, treasury.address);
    await settlement.configure(orders.target, venues.target);
    await settlement.setLocationVerifier(verifier.target);
    await disputes.configure(orders.target, vault.target, driversC.target, treasury.address);
    await disputes.setDisputeBond(ethers.parseEther("0.01"));
    await vault.setAuthorized(orders.target, true);
    await vault.setAuthorized(disputes.target, true);
    await driversC.setAuthorized(orders.target, true);
    await driversC.setAuthorized(disputes.target, true);
    await venues.setAuthorized(orders.target, true);

    for (const d of drivers) await driversC.connect(d).register("demo://d", { value: ethers.parseEther("1") });
    await venues.connect(venueOp).registerVenue(VENUE_LAT, VENUE_LON, venueSigner.address, venueOp.address, "demo://v");
    const venueId = 1n;

    const chainId = (await ethers.provider.getNetwork()).chainId;
    const domain = { name: "FareSettlement", version: "1", chainId, verifyingContract: settlement.target as string };

    // Every address the vault can ever credit (refunds, payouts, fares, fees,
    // dispute bonds) — the complete set INV-2/INV-4 must sum over.
    const participants = [...customers, ...drivers, venueOp, treasury].map((s) => s.address);

    interface OrderInfo { id: bigint; customer: HardhatEthersSigner; dropCommit: string; salt: bigint; status: number; }
    const created: OrderInfo[] = [];
    const TERMINAL = new Set([4, 5, 7]); // Delivered / Cancelled / Resolved
    // Local mirror of the on-chain status transition an op causes (source of
    // truth is still the chain — a drift would just make the op revert/bounce).
    const NEXT: Record<string, number> = {
      accept: 2, pickup: 3, dropoff: 4, cancelOpen: 5, cancelAssigned: 5,
      abandon: 5, dispute: 6, resolve: 7,
    };
    const counts: Record<string, number> = {};
    let bounced = 0;
    const tally = (k: string) => (counts[k] = (counts[k] || 0) + 1);

    const driverOf = (addr: string) => drivers.find((d) => d.address.toLowerCase() === addr.toLowerCase());

    async function checkInvariants(label: string) {
      const n = await orders.nextOrderId();
      let sumEscrow = 0n;
      for (let i = 1n; i < n; i++) sumEscrow += (await orders.orders(i)).escrow;
      const ordersBal = await ethers.provider.getBalance(orders.target);
      expect(ordersBal, `INV-1 escrow conservation [seed=${SEED}] after ${label}`).to.equal(sumEscrow);

      let sumBal = 0n, sumDust = 0n;
      for (const a of participants) {
        sumBal += await vault.balanceOf(a);
        sumDust += await vault.pendingPaseoDust(a);
      }
      const vaultBal = await ethers.provider.getBalance(vault.target);
      expect(vaultBal, `INV-2 vault solvency [seed=${SEED}] after ${label}`).to.equal(sumBal + sumDust);

      const credited = await vault.totalCredited();
      const withdrawn = await vault.totalWithdrawn();
      expect(credited - withdrawn, `INV-4 credited/withdrawn [seed=${SEED}] after ${label}`).to.equal(sumBal);
    }

    // ── Operations. Each returns a label on success, or throws (invalid action,
    //    treated as an expected bounce) — the contract correctly rejecting an
    //    action is itself fine; only a broken invariant fails the test.
    async function opCreate() {
      if (created.length >= ORDER_CAP) throw new Error("cap");
      const customer = pick(customers);
      const orderValue = someWei();
      const tip = someWei();
      const maxFare = someWei() + 1n;
      const salt = BigInt(randInt(1, 1e9));
      const dropCommit = ethers.keccak256(abi.encode(["uint256", "uint256"], [salt, BigInt(created.length)]));
      const tx = await orders.connect(customer).createOrder(venueId, dropCommit, orderValue, tip, maxFare, 0, 0, { value: orderValue + tip });
      await tx.wait();
      created.push({ id: BigInt(created.length + 1), customer, dropCommit, salt, status: 1 });
      return "create";
    }
    async function opBid(info: OrderInfo) {
      const o = await orders.orders(info.id);
      const amount = someWei() % o.maxFare || 1n;
      await (await orders.connect(pick(drivers)).placeBid(info.id, amount)).wait();
      return "bid";
    }
    async function opAccept(info: OrderInfo) {
      const bidders: string[] = await orders.biddersOf(info.id);
      const withBids: { addr: string; amt: bigint }[] = [];
      for (const b of bidders) {
        const amt = await orders.bidOf(info.id, b);
        if (amt > 0n) withBids.push({ addr: b, amt });
      }
      if (withBids.length === 0) throw new Error("no-bids");
      const win = pick(withBids);
      await (await orders.connect(info.customer).acceptBid(info.id, win.addr, { value: win.amt })).wait();
      return "accept";
    }
    async function opTip(info: OrderInfo) {
      await (await orders.connect(info.customer).increaseTip(info.id, { value: someWei() + 1n })).wait();
      return "tip";
    }
    async function opCancelOpen(info: OrderInfo) {
      await (await orders.connect(info.customer).cancelOpen(info.id)).wait();
      return "cancelOpen";
    }
    async function opCancelAssigned(info: OrderInfo) {
      await (await orders.connect(info.customer).cancelAssigned(info.id)).wait();
      return "cancelAssigned";
    }
    async function opAbandon(info: OrderInfo) {
      const o = await orders.orders(info.id);
      const d = driverOf(o.driver);
      if (!d) throw new Error("no-driver");
      await (await orders.connect(d).abandonOrder(info.id)).wait();
      return "abandon";
    }
    async function opPickup(info: OrderInfo) {
      const o = await orders.orders(info.id);
      const d = driverOf(o.driver);
      if (!d) throw new Error("no-driver");
      const now = await time.latest();
      const dAtt = { orderId: info.id, phase: 1, actor: d.address, lat: VENUE_LAT, lon: VENUE_LON, timestamp: now };
      const vAtt = { orderId: info.id, phase: 1, actor: venueSigner.address, lat: VENUE_LAT, lon: VENUE_LON, timestamp: now };
      const dSig = await d.signTypedData(domain, LOCATION_TYPES, dAtt);
      const vSig = await venueSigner.signTypedData(domain, LOCATION_TYPES, vAtt);
      await (await settlement.confirmPickup(dAtt, dSig, vAtt, vSig)).wait();
      return "pickup";
    }
    async function opDropoff(info: OrderInfo) {
      const o = await orders.orders(info.id);
      const d = driverOf(o.driver);
      if (!d) throw new Error("no-driver");
      const now = await time.latest();
      const posCommit = ethers.keccak256(abi.encode(["string", "uint256"], ["pos", info.id]));
      const dAtt = { orderId: info.id, phase: 2, actor: d.address, posCommit, timestamp: now };
      const dSig = await d.signTypedData(domain, DRIVER_COMMIT_TYPES, dAtt);
      const radius = await settlement.dropoffRadiusMeters();
      const nullifier = ethers.keccak256(abi.encode(["uint256", "uint256"], [info.salt, info.id]));
      const pub = [info.id, BigInt(info.dropCommit), BigInt(posCommit), radius, BigInt(nullifier)];
      await (await settlement.confirmDropoffZK(dAtt, dSig, "0x" + "00".repeat(256), pub)).wait();
      return "dropoff";
    }
    async function opDispute(info: OrderInfo) {
      const o = await orders.orders(info.id);
      const opener = rng() < 0.5 ? info.customer : driverOf(o.driver);
      if (!opener) throw new Error("no-opener");
      await (await disputes.connect(opener).openDispute(info.id, "e", { value: ethers.parseEther("0.01") })).wait();
      return "dispute";
    }
    async function opResolve(info: OrderInfo) {
      const did = await disputes.disputeOfOrder(info.id);
      if (did === 0n) throw new Error("no-dispute");
      await (await disputes.connect(deployer).resolve(did, randInt(0, 10000), rng() < 0.5, rng() < 0.5, 0)).wait();
      return "resolve";
    }
    async function opWithdraw() {
      const holders = [];
      for (const s of [...customers, ...drivers, venueOp, treasury]) {
        if ((await vault.balanceOf(s.address)) > 0n) holders.push(s);
      }
      if (holders.length === 0) throw new Error("none");
      await (await vault.connect(pick(holders)).withdraw()).wait();
      return "withdraw";
    }
    async function opClaimDust() {
      const holders = [];
      for (const s of [...customers, ...drivers, venueOp, treasury]) {
        if ((await vault.pendingPaseoDust(s.address)) > 0n) holders.push(s);
      }
      if (holders.length === 0) throw new Error("none");
      await (await vault.connect(pick(holders)).claimPaseoDust()).wait();
      return "claimDust";
    }

    // Status → the actions worth trying, biased toward ADVANCING the order so a
    // meaningful fraction reach pickup/dropoff (otherwise most orders idle Open
    // and the settlement value paths never run).
    async function actOnOrder(info: OrderInfo): Promise<string> {
      const r = rng();
      switch (info.status) {
        case 1: { // Open
          const bidders: string[] = await orders.biddersOf(info.id);
          let anyBid = false;
          for (const b of bidders) if ((await orders.bidOf(info.id, b)) > 0n) { anyBid = true; break; }
          if (!anyBid) return opBid(info);                 // no bids yet → bid
          if (r < 0.68) return opAccept(info);             // advance
          if (r < 0.83) return opBid(info);
          if (r < 0.93) return opTip(info);
          return opCancelOpen(info);
        }
        case 2: // Assigned
          if (r < 0.66) return opPickup(info);             // advance
          if (r < 0.78) return opTip(info);
          if (r < 0.88) return opDispute(info);
          if (r < 0.95) return opCancelAssigned(info);
          return opAbandon(info);
        case 3: // PickedUp
          if (r < 0.74) return opDropoff(info);            // advance
          if (r < 0.86) return opTip(info);
          return opDispute(info);
        case 6: // Disputed
          return opResolve(info);
        default:
          throw new Error("terminal");
      }
    }

    console.log(`\n  fuzz seed=${SEED} ops=${OPS}`);
    await checkInvariants("init");
    for (let step = 0; step < OPS; step++) {
      const roll = rng();
      try {
        let label: string;
        let advanced: OrderInfo | null = null;
        if (created.length < 6 || roll < 0.24) label = await opCreate();
        else if (roll < 0.36) label = await opWithdraw();
        else if (roll < 0.42) label = await opClaimDust();
        else {
          const live = created.filter((i) => !TERMINAL.has(i.status));
          if (live.length === 0) { label = await opCreate(); }
          else { advanced = pick(live); label = await actOnOrder(advanced); }
        }
        if (advanced && NEXT[label] !== undefined) advanced.status = NEXT[label];
        tally(label);
        await checkInvariants(`step ${step} (${label})`);
      } catch {
        bounced++;
      }
    }

    console.log("  coverage:", JSON.stringify(counts), `bounced=${bounced}`);
    // Guard against a degenerate campaign: the settlement value paths must have
    // actually run, or the invariants proved nothing interesting.
    expect(counts["pickup"] ?? 0, "campaign never confirmed a pickup").to.be.greaterThan(0);
    expect(counts["dropoff"] ?? 0, "campaign never confirmed a dropoff").to.be.greaterThan(0);
    expect(counts["withdraw"] ?? 0, "campaign never withdrew from the vault").to.be.greaterThan(0);
    await checkInvariants("final");
  });
});
