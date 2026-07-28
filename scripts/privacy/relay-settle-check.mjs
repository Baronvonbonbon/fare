#!/usr/bin/env node
// Does the relay actually settle, now that the flat service fee is set?
//
// A2 measured the problem: at the deployed bps rebate the relay needs a 183 PAS
// fare to break even, so with the profit guard on it declines every realistic
// order and the app prompts "pay your own gas?". The flat service fee (F6-flat)
// is the fix — a fixed payment for a fixed cost.
//
// This drives ONE real delivery on Paseo and submits the reward-bearing half
// through the relay. `confirmPickup` is gated on the subsidy budget, so it
// proves nothing about the economics; `confirmDropoffZK` is the one the
// profitability guard actually judges. A 402 there means the fee is too small.
//
// Run: node scripts/privacy/relay-settle-check.mjs
import { ethers } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as snarkjs from "snarkjs";
import { poseidon2, poseidon3 } from "poseidon-lite";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BOOK = JSON.parse(fs.readFileSync(path.join(ROOT, "deployed-addresses.json"), "utf8"));
const RPC = process.env.TESTNET_RPC ?? "https://eth-rpc-testnet.polkadot.io/";
const RELAY = process.env.RELAY_URL ?? "http://127.0.0.1:8788";

const VENUE_ID = 1n;
const ORDER_VALUE = ethers.parseEther("0.1");
const TIP = 0n;
const FARE = ethers.parseEther("0.5");

const VENUE = { lat: 37_774_900, lon: -122_419_400 };
const DROP = { lat: 37_784_900, lon: -122_419_400 };
const DROPOFF = { lat: 37_784_940, lon: -122_419_400 };

const encLat = (l) => BigInt(l) + 90_000_000n;
const encLon = (l) => BigInt(l) + 180_000_000n;
const b32 = (x) => "0x" + BigInt(x).toString(16).padStart(64, "0");
const commit = (lat, lon, s) => poseidon3([encLat(lat), encLon(lon), s]);

const ORDERS_ABI = [
  "function createOrder(uint64 venueId, bytes32 dropCommit, uint96 orderValue, uint96 tip, uint96 maxFare, uint64 pw, uint64 dw) payable returns (uint256)",
  "function placeBid(uint256 orderId, uint96 amount)",
  "function acceptBid(uint256 orderId, address driver) payable",
  "function relayServiceFee(address) view returns (uint96)",
  "function statusOf(uint256) view returns (uint8)",
  "function nextOrderId() view returns (uint256)",
  // Field order must match `struct Order` in contracts/FareOrders.sol exactly —
  // a public mapping getter returns the members positionally, so a wrong order
  // decodes silently into garbage rather than reverting. escrow precedes
  // dropCommit, and serviceFee is LAST, after token.
  "function orders(uint256) view returns (address customer,uint64 venueId,uint8 status,address driver,uint96 orderValue,uint96 tip,uint96 fare,uint96 maxFare,uint96 escrow,bytes32 dropCommit,uint64 createdAt,uint64 pickupWindowSecs,uint64 deliveryWindowSecs,uint64 pickupDeadline,uint64 deliveryDeadline,address token,uint96 serviceFee)",
  "event OrderCreated(uint256 indexed orderId, address indexed customer, uint64 indexed venueId, uint96 orderValue, uint96 tip, uint96 maxFare, bytes32 dropCommit)",
];
const DRIVERS_ABI = [
  "function register(string metadataURI) payable",
  "function drivers(address) view returns (bool registered,uint96 stake,uint32 delivered,uint32 failed,uint32 ratingX100,uint32 ratingN,string metadataURI,uint64 unbondingAt)",
  "function minStake() view returns (uint96)",
];
const VAULT_ABI = ["function balanceOf(address) view returns (uint256)"];

const post = async (route, body) => {
  const res = await fetch(`${RELAY}${route}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const est = async (fn, args, ov = {}) => ({ ...ov, gasLimit: ((await fn.estimateGas(...args, ov)) * 130n) / 100n });
const log = (...a) => console.log(...a);

async function main() {
  const prov = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true });
  const key = process.env.DEPLOYER_PRIVATE_KEY
    ?? fs.readFileSync(path.join(ROOT, ".env"), "utf8").match(/^DEPLOYER_PRIVATE_KEY=(.+)$/m)[1].trim();
  const deployer = new ethers.Wallet(key, prov);

  const orders = new ethers.Contract(BOOK.orders, ORDERS_ABI, deployer);
  const drivers = new ethers.Contract(BOOK.drivers, DRIVERS_ABI, deployer);
  const vault = new ethers.Contract(BOOK.vault, VAULT_ABI, prov);

  const fee = await orders.relayServiceFee(ethers.ZeroAddress);
  log(`relay service fee : ${ethers.formatEther(fee)} PAS`);
  log(`relay             : ${RELAY}`);

  const health = await (await fetch(`${RELAY}/health`)).json();
  log(`relay account     : ${health.relay} (${health.balance} PAS)\n`);

  // A driver, funded and registered. The deployer plays every role here — this
  // is an economics check, not a privacy one; live-order-e2e.mjs is the run that
  // exercises burners and the shielded path.
  const driver = ethers.Wallet.createRandom().connect(prov);
  const minStake = await drivers.minStake();
  log(`1. funding + registering a driver (stake ${ethers.formatEther(minStake)} PAS)`);
  await (await deployer.sendTransaction({
    to: driver.address, value: minStake + ethers.parseEther("2"), gasLimit: 100_000n,
  })).wait();
  await (await new ethers.Contract(BOOK.drivers, DRIVERS_ABI, driver)
    .register("ipfs://relay-settle-check", await est(
      new ethers.Contract(BOOK.drivers, DRIVERS_ABI, driver).register,
      ["ipfs://relay-settle-check"], { value: minStake }))).wait();

  // ── the order ─────────────────────────────────────────────────────────────
  const salt = ethers.toBigInt(ethers.randomBytes(31));
  const dropCommit = b32(commit(DROP.lat, DROP.lon, salt));
  const total = ORDER_VALUE + TIP + fee;
  log(`\n2. createOrder — value ${ethers.formatEther(ORDER_VALUE)} + fee ${ethers.formatEther(fee)} = ${ethers.formatEther(total)} PAS`);
  const created = await (await orders.createOrder(
    VENUE_ID, dropCommit, ORDER_VALUE, TIP, FARE, 0, 0,
    await est(orders.createOrder, [VENUE_ID, dropCommit, ORDER_VALUE, TIP, FARE, 0, 0], { value: total })
  )).wait();
  const orderId = created.logs.map((l) => { try { return orders.interface.parseLog(l); } catch { return null; } })
    .find((e) => e?.name === "OrderCreated").args.orderId;
  log(`   order #${orderId}`);

  const o = await orders.orders(orderId);
  log(`   serviceFee snapshotted on the order: ${ethers.formatEther(o.serviceFee)} PAS`);

  // ── auction ───────────────────────────────────────────────────────────────
  log(`\n3. bid + accept`);
  const dOrders = new ethers.Contract(BOOK.orders, ORDERS_ABI, driver);
  await (await dOrders.placeBid(orderId, FARE, await est(dOrders.placeBid, [orderId, FARE]))).wait();
  await (await orders.acceptBid(orderId, driver.address,
    await est(orders.acceptBid, [orderId, driver.address], { value: FARE }))).wait();
  log(`   status ${await orders.statusOf(orderId)} (2 = Assigned)`);

  // ── pickup, through the relay (budget-gated, not profit-gated) ────────────
  const chainId = (await prov.getNetwork()).chainId;
  const domain = { name: "FareSettlement", version: "1", chainId, verifyingContract: BOOK.settlement };
  const LOC = { LocationAttestation: [
    { name: "orderId", type: "uint256" }, { name: "phase", type: "uint8" }, { name: "actor", type: "address" },
    { name: "lat", type: "int32" }, { name: "lon", type: "int32" }, { name: "timestamp", type: "uint64" }] };
  const DC = { DriverCommitAttestation: [
    { name: "orderId", type: "uint256" }, { name: "phase", type: "uint8" }, { name: "actor", type: "address" },
    { name: "posCommit", type: "bytes32" }, { name: "timestamp", type: "uint64" }] };

  const venueSigner = deployer; // the demo venue's signer
  let now = Number((await prov.getBlock("latest")).timestamp);
  const dAtt = { orderId, phase: 1, actor: driver.address, lat: VENUE.lat + 200, lon: VENUE.lon, timestamp: now };
  const vAtt = { orderId, phase: 1, actor: venueSigner.address, lat: VENUE.lat, lon: VENUE.lon, timestamp: now };

  log(`\n4. POST /submit confirmPickup  (subsidy-budget gated)`);
  const pu = await post("/submit", {
    method: "confirmPickup",
    args: [{ ...dAtt, orderId: orderId.toString() }, await driver.signTypedData(domain, LOC, dAtt),
           { ...vAtt, orderId: orderId.toString() }, await venueSigner.signTypedData(domain, LOC, vAtt)],
  });
  log(`   -> ${pu.status} ${JSON.stringify(pu.json).slice(0, 140)}`);
  if (pu.status !== 200) throw new Error("pickup was not relayed");
  await prov.waitForTransaction(pu.json.txHash, 1, 180_000);
  log(`   status ${await orders.statusOf(orderId)} (3 = PickedUp)`);

  // ── the dropoff — THE test ────────────────────────────────────────────────
  log(`\n5. building the Groth16 proximity proof`);
  const drvSalt = ethers.toBigInt(ethers.randomBytes(31));
  const driverCommit = b32(commit(DROPOFF.lat, DROPOFF.lon, drvSalt));
  const nullifier = b32(poseidon2([salt, orderId]));
  const zk = await snarkjs.groth16.fullProve({
    orderId: orderId.toString(), dropCommit: BigInt(dropCommit).toString(),
    driverCommit: BigInt(driverCommit).toString(), radiusMeters: "100",
    nullifier: BigInt(nullifier).toString(),
    custLatEnc: encLat(DROP.lat).toString(), custLonEnc: encLon(DROP.lon).toString(), salt: salt.toString(),
    drvLatEnc: encLat(DROPOFF.lat).toString(), drvLonEnc: encLon(DROPOFF.lon).toString(), drvSalt: drvSalt.toString(),
  }, path.join(ROOT, "web/public/zk/proximity.wasm"), path.join(ROOT, "web/public/zk/proximity.zkey"));
  const proofBytes = ethers.solidityPacked(Array(8).fill("uint256"), [
    zk.proof.pi_a[0], zk.proof.pi_a[1], zk.proof.pi_b[0][1], zk.proof.pi_b[0][0],
    zk.proof.pi_b[1][1], zk.proof.pi_b[1][0], zk.proof.pi_c[0], zk.proof.pi_c[1]]);

  now = Number((await prov.getBlock("latest")).timestamp);
  const dropAtt = { orderId, phase: 2, actor: driver.address, posCommit: driverCommit, timestamp: now };

  log(`\n6. POST /submit confirmDropoffZK  <- the profitability guard decides here`);
  const before = await prov.getBalance(health.relay);
  const dz = await post("/submit", {
    method: "confirmDropoffZK",
    args: [{ ...dropAtt, orderId: orderId.toString() }, await driver.signTypedData(domain, DC, dropAtt),
           proofBytes,
           [orderId.toString(), BigInt(dropCommit).toString(), BigInt(driverCommit).toString(), "100", BigInt(nullifier).toString()]],
  });
  log(`   -> ${dz.status} ${JSON.stringify(dz.json).slice(0, 200)}`);

  if (dz.status === 402) {
    log(`\n❌ DECLINED. The service fee does not cover this order's relayed gas.`);
    process.exit(2);
  }
  if (dz.status !== 200) throw new Error(`unexpected: ${dz.status}`);

  const rc = await prov.waitForTransaction(dz.json.txHash, 1, 180_000);
  const after = await prov.getBalance(health.relay);
  const gasCost = rc.gasUsed * (rc.gasPrice ?? 1_000_000_000_000n);

  log(`\n7. settled. status ${await orders.statusOf(orderId)} (4 = Delivered)`);
  log(`   dropoff gas       : ${rc.gasUsed} → ${ethers.formatEther(gasCost)} PAS`);
  log(`   relay native Δ    : ${ethers.formatEther(after - before)} PAS  (gas it paid)`);
  log(`   relay vault credit: ${ethers.formatEther(await vault.balanceOf(health.relay))} PAS  (service fee earned)`);
  log(`\n✅ Settlement went through the relay — gasless for the driver, and the relay was paid.`);
  process.exit(0);
}

main().catch((e) => { console.error("\n❌", e?.shortMessage ?? e?.message ?? e); process.exit(1); });
