#!/usr/bin/env node
// LIVE end-to-end order on the migrated deployment — every privacy path.
//
// The migration (scripts/upgrade-privacy.ts) put phases 1–4 on Paseo, but
// nothing had been driven through them there. This runs one real delivery and
// exercises each path the privacy work added, in the order a user meets them:
//
//   1. shielded funding      customer burner funded out of Kusama Shield
//   2. order                 created by that burner
//   3. SEALED bid            only a hash on-chain, submitted by the relay
//   4. accept                the customer reveals the winner
//   5. pickup                venue + driver attestations
//   6. ZK dropoff            Groth16 proximity proof, no coordinates on-chain
//   7. payouts               vault credits
//   8. ZK shielded payout    driver's earnings → note → proof → pool
//   9. pool withdrawal       that note spent to a fresh address
//
// Run:  node scripts/privacy/live-order-e2e.mjs
import { ethers } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as snarkjs from "snarkjs";
import { poseidon1, poseidon2, poseidon3 } from "poseidon-lite";
import { WITHDRAW_WASM, loadWithdrawZkey } from "../shield/zkey.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ks = await import(pathToFileURL(path.join(ROOT, "web/src/shieldpool.ts")).href);

const RPC = process.env.TESTNET_RPC ?? "https://eth-rpc-testnet.polkadot.io/";
const BOOK = JSON.parse(fs.readFileSync(path.join(ROOT, "deployed-addresses.json"), "utf8"));
const POOL = process.env.SHIELD_POOL ?? "0x7d5a496bD61b631025A828d9049f6A68e007e0dC";
const OUT = path.join(ROOT, "e2e-runs", "privacy-order");
const GAS = 500_000_000n;

const ORDER_VALUE = ethers.parseEther("1");
const TIP = 0n;
const MAX_FARE = ethers.parseEther("3");
const FARE = ethers.parseEther("2"); // driver nets ~1.95 after the protocol fee → one 1 PAS note
const BUCKET = ethers.parseEther("1");
const NOTE_DEPTH = 16;

// San Francisco fixtures, matching the other e2e scripts.
const VENUE = { lat: 37_774_900, lon: -122_419_400 };
const DRIVER_PICKUP = { lat: 37_775_300, lon: -122_419_400 };
const DROP = { lat: 37_784_900, lon: -122_419_400 };
const DRIVER_DROPOFF = { lat: 37_784_940, lon: -122_419_400 };

const steps = [];
const log = (...a) => console.log(...a);
const rec = (step, detail = {}) => { steps.push({ step, ...detail }); log(`   ${step}${detail.tx ? ` ${detail.tx}` : ""}`); };
const b32 = (x) => "0x" + BigInt(x).toString(16).padStart(64, "0");
const rand = () => ethers.toBigInt(ethers.randomBytes(31));
const encLat = (l) => BigInt(l) + 90_000_000n;
const encLon = (l) => BigInt(l) + 180_000_000n;
const snap = (v) => Math.round(v / 300) * 300; // ~33 m grid, as the client coarsens
// Poseidon(latEnc, lonEnc, salt) — a THREE-input hash, matching
// circuits/proximity.circom and web/src/zk.ts. Nesting two-input hashes instead
// produces a commitment the circuit rejects.
const positionCommit = (lat, lon, salt) => poseidon3([encLat(lat), encLon(lon), salt]);

const zeros = (() => { const z = [0n]; for (let i = 1; i <= NOTE_DEPTH; i++) z.push(poseidon2([z[i - 1], z[i - 1]])); return z; })();
const noteCommitment = (n, s, b) => poseidon2([poseidon2([n, s]), b]);
class NoteTree {
  constructor(leaves = []) { this.leaves = leaves; this.memo = new Map(); }
  node(lv, i) {
    if (i * 2 ** lv >= this.leaves.length) return zeros[lv];
    if (lv === 0) return this.leaves[i];
    const k = `${lv}:${i}`;
    if (this.memo.has(k)) return this.memo.get(k);
    const v = poseidon2([this.node(lv - 1, i * 2), this.node(lv - 1, i * 2 + 1)]);
    this.memo.set(k, v); return v;
  }
  root() { return this.node(NOTE_DEPTH, 0); }
  path(i) {
    const elements = [], indices = [];
    let idx = i;
    for (let lv = 0; lv < NOTE_DEPTH; lv++) {
      elements.push(this.node(lv, idx % 2 === 0 ? idx + 1 : idx - 1));
      indices.push(idx % 2);
      idx = Math.floor(idx / 2);
    }
    return { elements, indices };
  }
}

const ORDERS_ABI = [
  "function createOrder(uint64 venueId, bytes32 dropCommit, uint96 orderValue, uint96 tip, uint96 maxFare, uint64 pw, uint64 dw) payable returns (uint256)",
  "function nextOrderId() view returns (uint256)",
  "function statusOf(uint256) view returns (uint8)",
  "function bidHashOf(uint256 orderId, address driver, uint96 amount, bytes32 salt) pure returns (bytes32)",
  "function commitBid(uint256 orderId, bytes32 bidHash, bytes32 revokeHash)",
  "function acceptSealedBid(uint256 orderId, address driver, uint96 amount, bytes32 salt) payable",
  "function sealedBid(uint256 orderId, bytes32 bidHash) view returns (bytes32 revokeHash, bool exists, bool revoked)",
  "function treasury() view returns (address)",
  "event BidCommitted(uint256 indexed orderId, bytes32 bidHash)",
];
const VAULT_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function withdraw()",
  "function insertShieldNote(uint96 bucket, uint256 commitment)",
  "function depositShieldNoteZK(bytes proof, uint256 root, uint256 nullifierHash, uint96 bucket, bytes32 ksCommitment)",
  "function noteRoot() view returns (uint256)",
  "event ShieldNoteInserted(address indexed account, uint96 indexed bucket, uint256 commitment, uint32 index)",
];
const POOL_ABI = [
  "function depositNative(bytes32 commitment) payable",
  "function proxy_withdraw(uint[2] pA, uint[2][2] pB, uint[2] pC, uint[8] pubSignals, address recipient)",
  "function treeSize() view returns (uint256)",
  "function sideNodes(uint256) view returns (uint256)",
  "function currentRoot() view returns (uint256)",
  "event Deposit(address indexed asset, bytes32 commitment)",
  "event NewCommitment(bytes32 commitment)",
];

function deployerKey() {
  if (process.env.DEPLOYER_PRIVATE_KEY) return process.env.DEPLOYER_PRIVATE_KEY;
  return fs.readFileSync(path.join(ROOT, ".env"), "utf8").match(/^DEPLOYER_PRIVATE_KEY=(.+)$/m)[1].trim();
}
const send = async (label, p) => { const t = await p; const r = await t.wait(); rec(label, { tx: t.hash, gasUsed: String(r.gasUsed) }); return r; };

/// Estimate-based gas, with margin. Paseo reserves gasLimit × gasPrice at
/// SUBMISSION, so the 500 M weight limit reserves ~500 PAS — fine for a funded
/// relay, impossible for a burner or a fresh driver. User transactions must size
/// their own gas (venue-node/README.md, "Gas sizing on Paseo").
const est = async (fn, args, overrides = {}) => ({
  ...overrides,
  gasLimit: ((await fn.estimateGas(...args, overrides)) * 130n) / 100n,
});

/// A pool withdrawal proof, built with the NODE artifacts. The client's
/// `buildWithdrawal` fetches its proving key over HTTP, which only works in a
/// browser — so this mirrors it, reusing the client's path reconstruction so the
/// part that could actually diverge is still the shipped code.
async function ksWithdraw(prov, record, recipient, valueWei) {
  const { siblings, root } = await ks.reconstructPath(prov, POOL, record);
  const change = ks.makeNote(BigInt(record.value) - valueWei);
  const input = {
    withdrawnValue: valueWei.toString(), treeDepth: "128", context: ks.contextFor(recipient).toString(),
    root, asset: "0", existingValue: record.value,
    existingNullifier: record.nullifier, existingSecret: record.secret,
    newNullifier: change.nullifier, newSecret: change.secret,
    siblings, leafIndex: String(record.index),
  };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WITHDRAW_WASM, loadWithdrawZkey());
  if (publicSignals[1] !== ks.nullifierHashOf(record).toString()) throw new Error("nullifierHash mismatch");
  return {
    pA: [proof.pi_a[0], proof.pi_a[1]],
    pB: [[proof.pi_b[0][1], proof.pi_b[0][0]], [proof.pi_b[1][1], proof.pi_b[1][0]]],
    pC: [proof.pi_c[0], proof.pi_c[1]],
    pubSignals: publicSignals,
  };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const prov = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true, batchMaxCount: 1 });
  const D0 = new ethers.Wallet(deployerKey(), prov); // deployer: funds, venue signer, and stands in for the relay
  const chainId = (await prov.getNetwork()).chainId;

  const orders = new ethers.Contract(BOOK.orders, ORDERS_ABI, D0);
  const vault = new ethers.Contract(BOOK.vault, VAULT_ABI, D0);
  const pool = new ethers.Contract(POOL, POOL_ABI, D0);
  const drivers = new ethers.Contract(BOOK.drivers, ["function register(string) payable", "function isEligible(address) view returns (bool)"], D0);

  log(`\nFARE — live order on the migrated deployment`);
  log(`   orders ${BOOK.orders}`);
  log(`   vault  ${BOOK.vault}`);
  log(`   pool   ${POOL}  treeSize=${await pool.treeSize()}\n`);

  const customer = ethers.Wallet.createRandom().connect(prov);
  const driver = ethers.Wallet.createRandom().connect(prov);
  fs.writeFileSync(path.join(OUT, "actors.json"), JSON.stringify({
    customer: { address: customer.address, privateKey: customer.privateKey },
    driver: { address: driver.address, privateKey: driver.privateKey },
  }, null, 2));

  // ── 1. Shielded funding: the customer's burner is funded out of the pool ───
  log("1. funding the customer burner through Kusama Shield");
  const fundAmount = ethers.parseEther("5");
  const { record: ksNote } = await ks.depositAndSnapshot(POOL, D0, prov, fundAmount, GAS);
  rec("KS deposit", { value: ethers.formatEther(fundAmount) });
  const wd = await ksWithdraw(prov, ksNote, customer.address, fundAmount);
  const before = await prov.getBalance(customer.address);
  await send("proxy_withdraw → burner", pool.proxy_withdraw(wd.pA, wd.pB, wd.pC, wd.pubSignals, customer.address, { gasLimit: GAS }));
  const funded = await prov.getBalance(customer.address);
  if (funded <= before) throw new Error("burner was not funded");
  log(`   burner ${customer.address} holds ${ethers.formatEther(funded)} PAS (no edge from the deployer)`);

  // The driver needs gas of its own for the note insert later.
  await send("fund driver gas", D0.sendTransaction({ to: driver.address, value: ethers.parseEther("3"), gasLimit: 100_000n }));
  const dReg = drivers.connect(driver);
  const regArgs = ["fare-meta:v1:" + "0".repeat(64)];
  await send("driver register", dReg.register(...regArgs, await est(dReg.register, regArgs)));
  if (!(await drivers.isEligible(driver.address))) throw new Error("driver not eligible");

  // ── 2. Order ───────────────────────────────────────────────────────────────
  log("\n2. creating the order from the burner");
  const dropSalt = rand();
  const dropCommit = b32(positionCommit(DROP.lat, DROP.lon, dropSalt));
  const orderId = await orders.nextOrderId();
  const oc = orders.connect(customer);
  const coArgs = [1n, dropCommit, ORDER_VALUE, TIP, MAX_FARE, 0, 0];
  await send("createOrder", oc.createOrder(...coArgs, await est(oc.createOrder, coArgs, { value: ORDER_VALUE + TIP })));
  log(`   order #${orderId} · status ${await orders.statusOf(orderId)} (1=Open)`);

  // ── 3. Sealed bid ──────────────────────────────────────────────────────────
  log("\n3. sealed bid (only a hash on-chain, submitted by the relay)");
  const bidSalt = ethers.hexlify(ethers.randomBytes(32));
  const revokeSecret = ethers.hexlify(ethers.randomBytes(32));
  const revokeHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [revokeSecret]));
  const bidHash = await orders.bidHashOf(orderId, driver.address, FARE, bidSalt);
  const commitRec = await send("commitBid (relay submits)", orders.commitBid(orderId, bidHash, revokeHash, { gasLimit: GAS }));

  // The property, checked against the real chain: the commit names neither the
  // bidder nor the price.
  const commitTx = await prov.getTransaction(commitRec.hash);
  const blob = (commitTx.data + commitRec.logs.map((l) => l.data + l.topics.join("")).join("")).toLowerCase();
  if (blob.includes(driver.address.slice(2).toLowerCase())) throw new Error("commitBid leaked the driver");
  if (blob.includes(FARE.toString(16))) throw new Error("commitBid leaked the amount");
  log("   ✓ commit names neither the driver nor the amount");

  // ── 4. Accept ──────────────────────────────────────────────────────────────
  log("\n4. customer accepts the sealed bid");
  const abArgs = [orderId, driver.address, FARE, bidSalt];
  await send("acceptSealedBid", oc.acceptSealedBid(...abArgs, await est(oc.acceptSealedBid, abArgs, { value: FARE })));
  log(`   status ${await orders.statusOf(orderId)} (2=Assigned)`);

  // ── 5. Pickup ──────────────────────────────────────────────────────────────
  log("\n5. confirmPickup (driver + venue attestations)");
  const settle = new ethers.Contract(BOOK.settlement, [
    "function confirmPickup((uint256 orderId,uint8 phase,address actor,int32 lat,int32 lon,uint64 timestamp),bytes,(uint256 orderId,uint8 phase,address actor,int32 lat,int32 lon,uint64 timestamp),bytes)",
    "function confirmDropoffZK((uint256 orderId,uint8 phase,address actor,bytes32 posCommit,uint64 timestamp),bytes,bytes,uint256[5])",
  ], D0);
  const domain = { name: "FareSettlement", version: "1", chainId, verifyingContract: BOOK.settlement };
  const LOC = { LocationAttestation: [
    { name: "orderId", type: "uint256" }, { name: "phase", type: "uint8" }, { name: "actor", type: "address" },
    { name: "lat", type: "int32" }, { name: "lon", type: "int32" }, { name: "timestamp", type: "uint64" }] };
  let now = Number((await prov.getBlock("latest")).timestamp);
  const dAtt = { orderId, phase: 1, actor: driver.address, lat: snap(DRIVER_PICKUP.lat), lon: snap(DRIVER_PICKUP.lon), timestamp: now };
  const vAtt = { orderId, phase: 1, actor: D0.address, lat: VENUE.lat, lon: VENUE.lon, timestamp: now };
  await send("confirmPickup", settle.confirmPickup(
    dAtt, await driver.signTypedData(domain, LOC, dAtt), vAtt, await D0.signTypedData(domain, LOC, vAtt), { gasLimit: GAS }
  ));
  log(`   status ${await orders.statusOf(orderId)} (3=PickedUp)`);

  // ── 6. ZK dropoff ──────────────────────────────────────────────────────────
  log("\n6. confirmDropoffZK (Groth16 proximity — no coordinates on-chain)");
  const drvSalt = rand();
  const driverCommit = b32(positionCommit(DRIVER_DROPOFF.lat, DRIVER_DROPOFF.lon, drvSalt));
  const nullifier = b32(poseidon2([dropSalt, orderId]));
  const zkInput = {
    orderId: orderId.toString(), dropCommit: BigInt(dropCommit).toString(),
    driverCommit: BigInt(driverCommit).toString(), radiusMeters: "100",
    nullifier: BigInt(nullifier).toString(),
    custLatEnc: encLat(DROP.lat).toString(), custLonEnc: encLon(DROP.lon).toString(), salt: dropSalt.toString(),
    drvLatEnc: encLat(DRIVER_DROPOFF.lat).toString(), drvLonEnc: encLon(DRIVER_DROPOFF.lon).toString(), drvSalt: drvSalt.toString(),
  };
  const zk = await snarkjs.groth16.fullProve(zkInput,
    path.join(ROOT, "web/public/zk/proximity.wasm"), path.join(ROOT, "web/public/zk/proximity.zkey"));
  const proofBytes = ethers.solidityPacked(Array(8).fill("uint256"), [
    zk.proof.pi_a[0], zk.proof.pi_a[1], zk.proof.pi_b[0][1], zk.proof.pi_b[0][0],
    zk.proof.pi_b[1][1], zk.proof.pi_b[1][0], zk.proof.pi_c[0], zk.proof.pi_c[1]]);
  now = Number((await prov.getBlock("latest")).timestamp);
  const DC = { DriverCommitAttestation: [
    { name: "orderId", type: "uint256" }, { name: "phase", type: "uint8" }, { name: "actor", type: "address" },
    { name: "posCommit", type: "bytes32" }, { name: "timestamp", type: "uint64" }] };
  const dropAtt = { orderId, phase: 2, actor: driver.address, posCommit: driverCommit, timestamp: now };
  const dropRec = await send("confirmDropoffZK", settle.confirmDropoffZK(
    dropAtt, await driver.signTypedData(domain, DC, dropAtt), proofBytes,
    [orderId.toString(), BigInt(dropCommit).toString(), BigInt(driverCommit).toString(), "100", BigInt(nullifier).toString()],
    { gasLimit: GAS }
  ));
  log(`   status ${await orders.statusOf(orderId)} (4=Delivered)`);

  // No coordinate may appear in the dropoff transaction.
  const dropTx = await prov.getTransaction(dropRec.hash);
  const dropBlob = (dropTx.data + dropRec.logs.map((l) => l.data + l.topics.join("")).join("")).toLowerCase();
  for (const c of [encLat(DROP.lat), encLon(DROP.lon)]) {
    if (dropBlob.includes(c.toString(16))) throw new Error("dropoff leaked a coordinate");
  }
  log("   ✓ no drop coordinate in calldata or logs");

  // ── 7. Payouts ─────────────────────────────────────────────────────────────
  const treasury = await orders.treasury();
  const [bV, bD, bT] = await Promise.all([
    vault.balanceOf(D0.address), vault.balanceOf(driver.address), vault.balanceOf(treasury),
  ]);
  log(`\n7. vault credits — venue ${ethers.formatEther(bV)} · driver ${ethers.formatEther(bD)} · treasury ${ethers.formatEther(bT)} PAS`);
  if (bD < BUCKET) throw new Error(`driver credited ${ethers.formatEther(bD)}, need ≥ 1 PAS to shield`);

  // ── 8. Shielded payout: earnings → note → proof → pool ─────────────────────
  log("\n8. driver shields earnings (ZK note, no keeper)");
  const note = { nullifier: rand(), secret: rand() };
  const commitment = noteCommitment(note.nullifier, note.secret, BUCKET);
  fs.writeFileSync(path.join(OUT, "note.json"), JSON.stringify({
    nullifier: note.nullifier.toString(), secret: note.secret.toString(), bucket: BUCKET.toString(),
    commitment: commitment.toString(),
  }, null, 2));
  const vd = vault.connect(driver);
  const insArgs = [BUCKET, commitment];
  await send("insertShieldNote", vd.insertShieldNote(...insArgs, await est(vd.insertShieldNote, insArgs)));

  // Rebuild the tree from the vault's own events, exactly as the client does.
  const inserted = await vault.queryFilter(vault.filters.ShieldNoteInserted(), 0, "latest");
  const leaves = inserted
    .map((l) => ({ i: Number(l.args.index), c: ethers.toBigInt(l.args.commitment) }))
    .sort((a, b) => a.i - b.i).map((x) => x.c);
  const tree = new NoteTree(leaves);
  if ((await vault.noteRoot()) !== tree.root()) throw new Error("note tree disagrees with the client");
  const myIndex = leaves.findIndex((l) => l === commitment);
  log(`   ✓ tree matches the client; our leaf is #${myIndex} of ${leaves.length}`);

  const ksOut = ks.makeNote(BUCKET);
  const ksCommitment = ks.commitmentOf(ksOut);
  fs.writeFileSync(path.join(OUT, "ks-note.json"), JSON.stringify(ksOut, null, 2));
  const { elements, indices } = tree.path(myIndex);
  const spend = await snarkjs.groth16.fullProve({
    root: tree.root().toString(), nullifierHash: poseidon1([note.nullifier]).toString(),
    bucket: BUCKET.toString(), ksCommitment: ksCommitment.toString(),
    nullifier: note.nullifier.toString(), secret: note.secret.toString(),
    pathElements: elements.map(String), pathIndices: indices,
  }, path.join(ROOT, "circuits/build/shieldnote_js/shieldnote.wasm"), path.join(ROOT, "circuits/build/shieldnote.zkey"));
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["uint256[2]", "uint256[4]", "uint256[2]"],
    [[spend.proof.pi_a[0], spend.proof.pi_a[1]],
     [spend.proof.pi_b[0][1], spend.proof.pi_b[0][0], spend.proof.pi_b[1][1], spend.proof.pi_b[1][0]],
     [spend.proof.pi_c[0], spend.proof.pi_c[1]]]
  );

  const ksStart = Number(await pool.treeSize());
  const preSideNodes = {};
  for (let lv = 0; lv < 128; lv++) preSideNodes[lv] = (await pool.sideNodes(lv)).toString();

  // Submitted by the deployer, NOT the driver: the call is permissionless and
  // the proof binds the destination, so the submitter can neither be linked to
  // the note nor redirect it.
  const spendRec = await send("depositShieldNoteZK (submitted by a third party)", vault.depositShieldNoteZK(
    encoded, tree.root(), spend.publicSignals[1], BUCKET, b32(ksCommitment), { gasLimit: GAS }
  ));
  const spendTx = await prov.getTransaction(spendRec.hash);
  const spendBlob = (spendTx.data + spendRec.logs.map((l) => l.data + l.topics.join("")).join("")).toLowerCase();
  if (spendBlob.includes(driver.address.slice(2).toLowerCase())) throw new Error("spend leaked the driver");
  log("   ✓ the spend names no account");

  // ── 9. Spend the resulting pool note ───────────────────────────────────────
  log("\n9. withdrawing the shielded note to a fresh address");
  const paths = ks.batchNotePaths(ksStart, preSideNodes, [ksCommitment]);
  const outRec = { ...ksOut, index: paths[0].index, leftSnapshot: paths[0].leftSnapshot, depositBlock: spendRec.blockNumber };
  const recipient = ethers.Wallet.createRandom().address;
  const w = await ksWithdraw(prov, outRec, recipient, BUCKET);
  const rb = await prov.getBalance(recipient);
  await send("proxy_withdraw → fresh address", pool.proxy_withdraw(w.pA, w.pB, w.pC, w.pubSignals, recipient, { gasLimit: GAS }));
  const ra = await prov.getBalance(recipient);
  if (ra <= rb) throw new Error("fresh address received nothing");

  // ── 10. Venue takes the plain path, proving it still works ─────────────────
  log("\n10. venue withdraws normally (the unshielded path is untouched)");
  if (bV > 0n) await send("venue withdraw", vault.withdraw({ gasLimit: GAS }));

  const report = {
    ranAt: new Date().toISOString(), orders: BOOK.orders, vault: BOOK.vault, pool: POOL,
    orderId: orderId.toString(), customer: customer.address, driver: driver.address,
    fare: ethers.formatEther(FARE),
    credits: { venue: ethers.formatEther(bV), driver: ethers.formatEther(bD), treasury: ethers.formatEther(bT) },
    noteLeaf: myIndex, noteTreeSize: leaves.length,
    ksTreeBefore: ksStart, ksTreeAfter: Number(await pool.treeSize()),
    recipient, received: ethers.formatEther(ra - rb), steps,
  };
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));

  log(`\n✅ every privacy path exercised on the live deployment`);
  log(`   order #${orderId} delivered · driver netted ${ethers.formatEther(bD)} PAS`);
  log(`   shielded 1 PAS → fresh ${recipient} received ${ethers.formatEther(ra - rb)} PAS`);
  log(`   report e2e-runs/privacy-order/report.json\n`);
}

main().catch((e) => {
  console.error("\n❌", e?.shortMessage ?? e?.reason ?? e?.message ?? e);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "failure.json"), JSON.stringify({ error: String(e?.message ?? e), steps }, null, 2));
  process.exit(1);
});
