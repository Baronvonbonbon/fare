import { expect } from "chai";
import hre, { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
// @ts-ignore — circomlib's generated Poseidon has no types
import { poseidonContract } from "circomlibjs";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { assignSealed } from "./helpers/bids";

// Gas snapshot (TEST-PLAN A1). Every user-facing path is measured on a local
// chain and diffed against a committed baseline, so a change that makes a
// delivery more expensive has to be noticed and accepted rather than merely
// shipped.
//
// Regenerate after a deliberate change:
//
//   UPDATE_GAS_SNAPSHOT=1 npx hardhat test test/gas-snapshot.test.ts
//
// and commit the diff — the review is the point. A drift beyond ±5% fails.
//
// Determinism: every measurement runs from `loadFixture`, so each path starts
// from an identical chain state and warm/cold storage costs cannot depend on
// what some earlier test happened to touch. The numbers are solc- and
// EVM-version specific, which is deliberate: a compiler bump that moves gas
// should surface here and be recorded, not pass silently.

const SNAPSHOT = join(__dirname, "..", "gas-snapshot.json");
const UPDATE = process.env.UPDATE_GAS_SNAPSHOT === "1";
const TOLERANCE = 0.05;

// Under `hardhat coverage` these measurements are meaningless: solidity-coverage
// rewrites every contract to emit a marker per branch, so gas is inflated by
// far more than the ±5% gate allows and every measured path fails at once (E2).
// Nothing would be learned by running them instrumented — coverage measures
// which lines ran, and this file measures what they cost.
//
// The signal is a flag the plugin sets on the hardhat runtime environment.
// There is no `SOLIDITY_COVERAGE` env var to read: the plugin *reads* one of
// that name, it does not set it, so guarding on it silently does nothing —
// which is how this was first written, and the 11 failures said so.
const UNDER_COVERAGE = Boolean((hre as any).__SOLIDITY_COVERAGE_RUNNING);

const baseline: Record<string, number> =
  existsSync(SNAPSHOT) ? JSON.parse(readFileSync(SNAPSHOT, "utf8")) : {};
const measured: Record<string, number> = {};

const abi = ethers.AbiCoder.defaultAbiCoder();
const PAS = (n: string | number) => ethers.parseEther(String(n));
const USDC = (n: number) => BigInt(Math.round(n * 1e6));

const VENUE = { lat: 37_774_900, lon: -122_419_400 };
const NEAR = { lat: 37_775_100, lon: -122_419_400 };
const DROP_SALT = 0xabc_def_123n;
const ORDER_VALUE = PAS(1);
const TIP = PAS("0.1");
const MAX_FARE = PAS(3);
// Large enough that the driver's payout (fare less the 2.5% protocol fee)
// clears the 1 PAS shield bucket, so the shielded paths have something to move.
const FARE = PAS(2);
const STAKE = PAS(1);

const dropCommit = (lat: number, lon: number, salt: bigint) =>
  ethers.keccak256(abi.encode(["int32", "int32", "uint256"], [lat, lon, salt]));
const driverCommit = (id: bigint) =>
  ethers.keccak256(abi.encode(["string", "uint256"], ["driver-pos", id]));
const nullifierOf = (id: bigint, salt: bigint) =>
  ethers.keccak256(abi.encode(["uint256", "uint256"], [salt, id]));

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

/// Record a path's gas and hold it to the committed baseline.
async function measure(name: string, tx: Promise<any>) {
  const rc = await (await tx).wait();
  const used = Number(rc.gasUsed);
  measured[name] = used;
  if (UPDATE) return rc;

  const base = baseline[name];
  expect(base, `"${name}" has no baseline — run UPDATE_GAS_SNAPSHOT=1 and commit`).to.be.a("number");
  const drift = (used - base) / base;
  expect(
    Math.abs(drift),
    `${name}: ${base.toLocaleString()} → ${used.toLocaleString()} (${drift >= 0 ? "+" : ""}${(drift * 100).toFixed(2)}%)`
  ).to.be.at.most(TOLERANCE);
  return rc;
}

/// For paths that are reads rather than transactions — the Groth16 verifies,
/// where the cost is the whole point and no state changes.
async function measureCall(name: string, estimate: Promise<bigint>) {
  const used = Number(await estimate);
  measured[name] = used;
  if (UPDATE) return;
  const base = baseline[name];
  expect(base, `"${name}" has no baseline — run UPDATE_GAS_SNAPSHOT=1 and commit`).to.be.a("number");
  const drift = (used - base) / base;
  expect(
    Math.abs(drift),
    `${name}: ${base.toLocaleString()} → ${used.toLocaleString()} (${drift >= 0 ? "+" : ""}${(drift * 100).toFixed(2)}%)`
  ).to.be.at.most(TOLERANCE);
}

describe("gas snapshot", function () {
  // Skipped, not deleted: the coverage run still compiles and deploys every
  // contract here, and a silent pass would be worse than a visible skip.
  if (UNDER_COVERAGE) this.pending = true;

  async function deployAll() {
    const [deployer, treasury, customer, driver, driver2, venueOp, venueSigner, relay] =
      await ethers.getSigners();

    const pause = await (await ethers.getContractFactory("FarePauseRegistry")).deploy();
    const vault = await (await ethers.getContractFactory("FareVault")).deploy();
    const drivers = await (await ethers.getContractFactory("FareDrivers")).deploy(pause.target);
    const venues = await (await ethers.getContractFactory("FareVenues")).deploy(pause.target);
    const forwarder = await (await ethers.getContractFactory("FareForwarder")).deploy();
    const orders = await (await ethers.getContractFactory("FareOrders")).deploy(pause.target, forwarder.target);
    const settlement = await (await ethers.getContractFactory("FareSettlement")).deploy(pause.target);
    const disputes = await (await ethers.getContractFactory("FareDisputes")).deploy(pause.target);
    const locVerifier = await (await ethers.getContractFactory("MockLocationVerifier")).deploy();
    const ratings = await (await ethers.getContractFactory("FareRatings")).deploy(forwarder.target);
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    const pool = await (await ethers.getContractFactory("MockShieldPool")).deploy();
    const shieldVerifier = await (await ethers.getContractFactory("FareShieldVerifier")).deploy();
    const poseidonImpl = await new ethers.ContractFactory(
      poseidonContract.generateABI(2), poseidonContract.createCode(2), deployer
    ).deploy();
    const adapter = await (await ethers.getContractFactory("PoseidonT3Adapter"))
      .deploy(await poseidonImpl.getAddress());

    await ratings.configure(orders.target);
    await orders.configure(vault.target, drivers.target, venues.target, settlement.target, disputes.target, treasury.address);
    await settlement.configure(orders.target, venues.target);
    await settlement.setLocationVerifier(locVerifier.target);
    await disputes.configure(orders.target, vault.target, drivers.target, treasury.address);
    await vault.setAuthorized(orders.target, true);
    await vault.setAuthorized(disputes.target, true);
    await drivers.setAuthorized(orders.target, true);
    await drivers.setAuthorized(disputes.target, true);
    await venues.setAuthorized(orders.target, true);
    await orders.setAcceptedToken(usdc.target, true);
    await vault.setShieldPool(pool.target);
    await vault.setShieldBuckets([PAS(1), PAS(5)]);
    await vault.setShieldPoseidon(adapter.target);
    await vault.setShieldVerifier(shieldVerifier.target);

    await drivers.connect(driver).register("ipfs://d1", { value: STAKE });
    await drivers.connect(driver2).register("ipfs://d2", { value: STAKE });
    await venues.connect(venueOp).registerVenue(VENUE.lat, VENUE.lon, venueSigner.address, venueOp.address, "ipfs://v");
    await usdc.mint(customer.address, USDC(10_000));
    await usdc.connect(customer).approve(orders.target, USDC(10_000));

    const domain = {
      name: "FareSettlement", version: "1",
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: settlement.target as string,
    };
    return {
      deployer, treasury, customer, driver, driver2, venueOp, venueSigner, relay,
      vault, drivers, venues, orders, settlement, disputes, ratings, usdc, forwarder,
      adapter, domain, venueId: 1n,
    };
  }

  /// A native order in the Open state.
  async function opened(f: any) {
    await f.orders.connect(f.customer).createOrder(
      f.venueId, dropCommit(37_784_900, -122_419_400, DROP_SALT), ORDER_VALUE, TIP, MAX_FARE, 0, 0,
      { value: ORDER_VALUE + TIP }
    );
    return 1n;
  }

  /// …assigned to `driver` through the open-bid path.
  async function assigned(f: any) {
    const id = await opened(f);
    await assignSealed(f.orders, id, f.driver, f.customer, FARE);
    return id;
  }

  async function pickedUp(f: any, id: bigint) {
    const now = await time.latest();
    const dAtt = { orderId: id, phase: 1, actor: f.driver.address, lat: NEAR.lat, lon: NEAR.lon, timestamp: now };
    const vAtt = { orderId: id, phase: 1, actor: f.venueSigner.address, lat: VENUE.lat, lon: VENUE.lon, timestamp: now };
    await f.settlement.confirmPickup(
      dAtt, await f.driver.signTypedData(f.domain, LOCATION_TYPES, dAtt),
      vAtt, await f.venueSigner.signTypedData(f.domain, LOCATION_TYPES, vAtt)
    );
  }

  async function delivered(f: any, id: bigint) {
    await pickedUp(f, id);
    const now = await time.latest();
    const posCommit = driverCommit(id);
    const att = { orderId: id, phase: 2, actor: f.driver.address, posCommit, timestamp: now };
    await f.settlement.confirmDropoffZK(
      att, await f.driver.signTypedData(f.domain, DRIVER_COMMIT_TYPES, att),
      "0x" + "00".repeat(256),
      [id, BigInt(dropCommit(37_784_900, -122_419_400, DROP_SALT)), BigInt(posCommit),
       await f.settlement.dropoffRadiusMeters(), BigInt(nullifierOf(id, DROP_SALT))]
    );
  }

  // ── registration ──────────────────────────────────────────────────────────

  it("drivers.register", async () => {
    const f = await loadFixture(deployAll);
    await measure("drivers.register", f.drivers.connect(f.relay).register("ipfs://new", { value: STAKE }));
  });

  it("venues.registerVenue", async () => {
    const f = await loadFixture(deployAll);
    await measure("venues.registerVenue",
      f.venues.connect(f.relay).registerVenue(VENUE.lat, VENUE.lon, f.relay.address, f.relay.address, "ipfs://v2"));
  });

  // ── the order lifecycle, native ───────────────────────────────────────────

  it("orders.createOrder", async () => {
    const f = await loadFixture(deployAll);
    await measure("orders.createOrder", f.orders.connect(f.customer).createOrder(
      f.venueId, dropCommit(37_784_900, -122_419_400, DROP_SALT), ORDER_VALUE, TIP, MAX_FARE, 0, 0,
      { value: ORDER_VALUE + TIP }
    ));
  });


  it("settlement.confirmPickup", async () => {
    const f = await loadFixture(deployAll);
    const id = await assigned(f);
    const now = await time.latest();
    const dAtt = { orderId: id, phase: 1, actor: f.driver.address, lat: NEAR.lat, lon: NEAR.lon, timestamp: now };
    const vAtt = { orderId: id, phase: 1, actor: f.venueSigner.address, lat: VENUE.lat, lon: VENUE.lon, timestamp: now };
    await measure("settlement.confirmPickup", f.settlement.confirmPickup(
      dAtt, await f.driver.signTypedData(f.domain, LOCATION_TYPES, dAtt),
      vAtt, await f.venueSigner.signTypedData(f.domain, LOCATION_TYPES, vAtt)
    ));
  });

  it("settlement.confirmDropoffZK", async () => {
    // Settlement overhead only — the mock verifier stands in, so the Groth16
    // cost is snapshotted separately below and the two move independently.
    const f = await loadFixture(deployAll);
    const id = await assigned(f);
    await pickedUp(f, id);
    const now = await time.latest();
    const posCommit = driverCommit(id);
    const att = { orderId: id, phase: 2, actor: f.driver.address, posCommit, timestamp: now };
    await measure("settlement.confirmDropoffZK", f.settlement.confirmDropoffZK(
      att, await f.driver.signTypedData(f.domain, DRIVER_COMMIT_TYPES, att),
      "0x" + "00".repeat(256),
      [id, BigInt(dropCommit(37_784_900, -122_419_400, DROP_SALT)), BigInt(posCommit),
       await f.settlement.dropoffRadiusMeters(), BigInt(nullifierOf(id, DROP_SALT))]
    ));
  });

  // ── sealed bids (privacy phase 4) ─────────────────────────────────────────

  it("orders.commitBid", async () => {
    const f = await loadFixture(deployAll);
    const id = await opened(f);
    const salt = ethers.keccak256(ethers.toUtf8Bytes("s"));
    const hash = await f.orders.bidHashOf(id, f.driver.address, FARE, salt);
    const revokeHash = ethers.keccak256(abi.encode(["bytes32"], [salt]));
    await measure("orders.commitBid", f.orders.connect(f.relay).commitBid(id, hash, revokeHash));
  });

  it("orders.acceptSealedBid", async () => {
    const f = await loadFixture(deployAll);
    const id = await opened(f);
    const salt = ethers.keccak256(ethers.toUtf8Bytes("s"));
    const hash = await f.orders.bidHashOf(id, f.driver.address, FARE, salt);
    await f.orders.connect(f.relay).commitBid(id, hash, ethers.keccak256(abi.encode(["bytes32"], [salt])));
    await measure("orders.acceptSealedBid",
      f.orders.connect(f.customer).acceptSealedBid(id, f.driver.address, FARE, salt, { value: FARE }));
  });

  // ── stablecoin path (C3) ──────────────────────────────────────────────────

  it("orders.createOrderERC20", async () => {
    const f = await loadFixture(deployAll);
    await measure("orders.createOrderERC20", f.orders.connect(f.customer).createOrderERC20(
      f.usdc.target, f.venueId, dropCommit(37_784_900, -122_419_400, DROP_SALT),
      USDC(20), USDC(2), USDC(40), 0, 0
    ));
  });

  // ── payouts ───────────────────────────────────────────────────────────────

  it("vault.withdraw", async () => {
    const f = await loadFixture(deployAll);
    const id = await assigned(f);
    await delivered(f, id);
    await measure("vault.withdraw", f.vault.connect(f.driver).withdraw());
  });

  it("vault.withdrawFor (gasless)", async () => {
    const f = await loadFixture(deployAll);
    const id = await assigned(f);
    await delivered(f, id);
    const deadline = (await time.latest()) + 3600;
    const sig = await f.driver.signTypedData(
      { name: "FareVault", version: "1", chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: f.vault.target },
      { Withdraw: [
        { name: "account", type: "address" }, { name: "recipient", type: "address" },
        { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
      { account: f.driver.address, recipient: f.driver.address, nonce: await f.vault.withdrawNonce(f.driver.address), deadline }
    );
    await measure("vault.withdrawFor (gasless)",
      f.vault.connect(f.relay).withdrawFor(f.driver.address, f.driver.address, deadline, sig));
  });

  // ── shielded payouts ──────────────────────────────────────────────────────

  it("vault.insertShieldNote", async () => {
    const f = await loadFixture(deployAll);
    const id = await assigned(f);
    await delivered(f, id);
    // A depth-16 Poseidon tree insert — ~16 hashes through the adapter.
    await measure("vault.insertShieldNote",
      f.vault.connect(f.driver).insertShieldNote(PAS(1), 12345678901234567890n));
  });

  // ── disputes + ratings ────────────────────────────────────────────────────

  it("disputes.openDispute", async () => {
    const f = await loadFixture(deployAll);
    const id = await assigned(f);
    await pickedUp(f, id); // only Assigned / PickedUp are disputable
    await measure("disputes.openDispute", f.disputes.connect(f.customer).openDispute(id, "ipfs://evidence"));
  });

  it("disputes.resolve", async () => {
    const f = await loadFixture(deployAll);
    const id = await assigned(f);
    await pickedUp(f, id); // dispute an in-flight order so escrow is still held
    await f.disputes.connect(f.customer).openDispute(id, "ipfs://evidence");
    await measure("disputes.resolve", f.disputes.resolve(1n, 5_000, false, false, 0));
  });

  it("ratings.rate", async () => {
    const f = await loadFixture(deployAll);
    const id = await assigned(f);
    await delivered(f, id);
    await measure("ratings.rate", f.ratings.connect(f.customer).rate(id, 5, 4));
  });

  // ── the Groth16 verifies, where the cost IS the feature ───────────────────

  it("FareLocationVerifier.verifyProximity", async () => {
    const fx = JSON.parse(readFileSync(join(__dirname, "fixtures", "zk-proximity.json"), "utf8"));
    const verifier = await (await ethers.getContractFactory("FareLocationVerifier")).deploy();
    const vk = fx.vkCalldata;
    await verifier.setVerifyingKey(vk.alpha1, vk.beta2, vk.gamma2, vk.delta2, vk.IC0, vk.IC1, vk.IC2, vk.IC3, vk.IC4, vk.IC5);
    const proof = abi.encode(["uint256[2]", "uint256[4]", "uint256[2]"], [fx.proof.pi_a, fx.proof.pi_b, fx.proof.pi_c]);
    await measureCall("FareLocationVerifier.verifyProximity",
      verifier.verifyProximity.estimateGas(proof, fx.publicSignals.map((s: string) => BigInt(s))));
  });

  // ── completeness ──────────────────────────────────────────────────────────

  after(function () {
    if (UPDATE) {
      const sorted = Object.fromEntries(Object.keys(measured).sort().map((k) => [k, measured[k]]));
      writeFileSync(SNAPSHOT, JSON.stringify(sorted, null, 2) + "\n");
      console.log(`\n  gas snapshot written: ${Object.keys(sorted).length} paths → gas-snapshot.json`);
      for (const [k, v] of Object.entries(sorted)) console.log(`    ${k.padEnd(34)} ${v.toLocaleString().padStart(10)}`);
    }
  });

  it("the snapshot covers exactly the paths that are measured", function () {
    if (UPDATE) return this.skip();
    // Guards both directions: a path deleted without updating the baseline, and
    // a stale baseline entry for something no longer measured.
    const stale = Object.keys(baseline).filter((k) => !(k in measured));
    expect(stale, `gas-snapshot.json has entries nothing measures: ${stale.join(", ")}`).to.deep.equal([]);
  });
});
