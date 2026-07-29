#!/usr/bin/env node
// Gas, cost and relay profitability across every on-chain path — measured live
// on Paseo, through three real relay processes.
//
// Two things at once:
//
//   1. Phase 3b in practice. The note INSERT names the account and the SPEND
//      names the commitment, so a relay that sees both learns what the proof
//      hides. With three relays running, the client routes those halves to
//      different ones — this drives that for real and asserts it happened.
//   2. An economics ledger. Every transaction is recorded with its payer, gas,
//      and PAS cost, plus whatever revenue the relay earned for it. The relay's
//      only revenue on this deployment is the 1% withdraw fee, so most rows are
//      subsidies; the report says so per endpoint rather than in aggregate.
//
// Run:  node scripts/privacy/measure-costs.mjs   (relays must be running)
import { ethers } from "ethers";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as snarkjs from "snarkjs";
import { poseidon1, poseidon2, poseidon3 } from "poseidon-lite";
import { WITHDRAW_WASM, loadWithdrawZkey } from "../shield/zkey.mjs";
import { createLedger } from "./ledger.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ks = await import(pathToFileURL(path.join(ROOT, "web/src/shieldpool.ts")).href);

const RPC = process.env.TESTNET_RPC ?? "https://eth-rpc-testnet.polkadot.io/";
const BOOK = JSON.parse(fs.readFileSync(path.join(ROOT, "deployed-addresses.json"), "utf8"));
const POOL = "0x7d5a496bD61b631025A828d9049f6A68e007e0dC";
const OUT = path.join(ROOT, "e2e-runs", "relay-lab");
const RELAYS = JSON.parse(fs.readFileSync(path.join(OUT, "relays.json"), "utf8"));
const url = (id) => `http://127.0.0.1:${RELAYS.find((r) => r.id === id).port}`;
const addrOf = (id) => RELAYS.find((r) => r.id === id).address;

const ORDER_VALUE = ethers.parseEther("1");
const FARE = ethers.parseEther("2");
const BUCKET = ethers.parseEther("1");
const NOTE_DEPTH = 16;
const VENUE = { lat: 37_774_900, lon: -122_419_400 };
const DRIVER_PICKUP = { lat: 37_775_300, lon: -122_419_400 };
const DROP = { lat: 37_784_900, lon: -122_419_400 };
const DRIVER_DROPOFF = { lat: 37_784_940, lon: -122_419_400 };

const b32 = (x) => "0x" + BigInt(x).toString(16).padStart(64, "0");
const rand = () => ethers.toBigInt(ethers.randomBytes(31));
const encLat = (l) => BigInt(l) + 90_000_000n;
const encLon = (l) => BigInt(l) + 180_000_000n;
const snap = (v) => Math.round(v / 300) * 300;
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

// ── the ledger ──────────────────────────────────────────────────────────────
// Shared with the local-chain run in test/cost-ledger.test.ts, so both modes
// emit the same report shape and can be diffed against each other (TEST-PLAN A3).
const ledger = createLedger();
let prov;
/// Poll for the receipt. The Paseo eth-rpc returns a hash well before the
/// receipt is queryable, and `tx.wait()` is unavailable here because the relay
/// submitted the transaction, not us.
async function receiptOf(hash, maxWait = 240) {
  for (let i = 0; i < maxWait; i++) {
    const r = await prov.getTransactionReceipt(hash).catch(() => null);
    if (r) return r;
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error(`no receipt for ${hash} after ${maxWait}s`);
}

async function track(step, { payer, via = null, revenue = 0n }, hash) {
  if (!hash) { console.log(`   ${step.padEnd(34)} (no transaction — skipped)`); return null; }
  const r = await receiptOf(hash);
  const gasPrice = r.gasPrice ?? 1_000_000_000_000n;
  ledger.record({ step, payer, via, gasUsed: r.gasUsed, gasPrice, revenue });
  const cost = ethers.formatEther(r.gasUsed * gasPrice);
  console.log(`   ${step.padEnd(34)} ${payer.padEnd(9)} ${cost.padStart(10)} PAS  gas ${r.gasUsed}`);
  return r;
}

/// Client-side padding, mirroring web/src/relaypick.ts. Asserted, not assumed:
/// if a body is not a multiple of the block size, its length still identifies
/// the request type.
const PAD_BLOCK = 512;
function padBody(body) {
  const base = JSON.stringify({ ...body, _pad: "" }).length;
  const target = Math.ceil(base / PAD_BLOCK) * PAD_BLOCK;
  return JSON.stringify({ ...body, _pad: "0".repeat(target - base) });
}
async function post(relayId, route, body) {
  const payload = padBody(body);
  if (payload.length % PAD_BLOCK !== 0) throw new Error("padding is not block-aligned");
  const res = await fetch(`${url(relayId)}${route}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: payload,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${route} via ${relayId}: ${res.status} ${JSON.stringify(j)}`);
  return j;
}

const deployerKey = () =>
  process.env.DEPLOYER_PRIVATE_KEY ??
  fs.readFileSync(path.join(ROOT, ".env"), "utf8").match(/^DEPLOYER_PRIVATE_KEY=(.+)$/m)[1].trim();
const est = async (fn, args, o = {}) => ({ ...o, gasLimit: ((await fn.estimateGas(...args, o)) * 130n) / 100n });

async function ksWithdrawProof(record, recipient, valueWei) {
  const { siblings, root } = await ks.reconstructPath(prov, POOL, record);
  const change = ks.makeNote(BigInt(record.value) - valueWei);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve({
    withdrawnValue: valueWei.toString(), treeDepth: "128", context: ks.contextFor(recipient).toString(),
    root, asset: "0", existingValue: record.value,
    existingNullifier: record.nullifier, existingSecret: record.secret,
    newNullifier: change.nullifier, newSecret: change.secret,
    siblings, leafIndex: String(record.index),
  }, WITHDRAW_WASM, loadWithdrawZkey());
  return {
    pA: [proof.pi_a[0], proof.pi_a[1]],
    pB: [[proof.pi_b[0][1], proof.pi_b[0][0]], [proof.pi_b[1][1], proof.pi_b[1][0]]],
    pC: [proof.pi_c[0], proof.pi_c[1]],
    pubSignals: publicSignals,
  };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  prov = new ethers.JsonRpcProvider(RPC, undefined, { staticNetwork: true, batchMaxCount: 1 });
  const D0 = new ethers.Wallet(deployerKey(), prov);
  const chainId = (await prov.getNetwork()).chainId;

  const ORDERS_ABI = [
    "function createOrder(uint64,bytes32,uint96,uint96,uint96,uint64,uint64) payable returns (uint256)",
    // F6-flat: createOrder requires msg.value == orderValue + tip + this.
    "function relayServiceFee(address) view returns (uint96)",
    "function nextOrderId() view returns (uint256)",
    "function statusOf(uint256) view returns (uint8)",
    "function bidHashOf(uint256,address,uint96,bytes32) pure returns (bytes32)",
    "function acceptSealedBid(uint256,address,uint96,bytes32) payable",
    "function treasury() view returns (address)",
  ];
  const VAULT_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function withdraw()",
    "function withdrawNonce(address) view returns (uint256)",
    "function shieldNonce(address) view returns (uint256)",
    "function insertShieldNote(uint96,uint256)",
    "function noteRoot() view returns (uint256)",
    "event ShieldNoteInserted(address indexed account, uint96 indexed bucket, uint256 commitment, uint32 index)",
  ];
  const orders = new ethers.Contract(BOOK.orders, ORDERS_ABI, D0);
  const vault = new ethers.Contract(BOOK.vault, VAULT_ABI, D0);
  const pool = new ethers.Contract(POOL, [
    "function treeSize() view returns (uint256)", "function sideNodes(uint256) view returns (uint256)",
  ], prov);
  const drivers = new ethers.Contract(BOOK.drivers, ["function register(string) payable", "function isEligible(address) view returns (bool)"], D0);

  console.log(`\nFARE — relay economics, live on Paseo`);
  for (const r of RELAYS) console.log(`   relay ${r.id} :${r.port} ${r.address}`);
  console.log(`   gas price 1000 gwei · relay revenue: withdrawFee 1%, rebate 0, serviceFee 0\n`);

  const customer = ethers.Wallet.createRandom().connect(prov);
  const driver = ethers.Wallet.createRandom().connect(prov);

  // ── 1. Sponsor gas via /fund (relay A) ────────────────────────────────────
  console.log("1. relay endpoints — funding");
  const fund = await post("A", "/fund", { address: driver.address });
  await track("/fund (sponsor driver gas)", { payer: "relay A", via: "A" }, fund.txHash);

  // ── 2. Shielded funding of the customer burner via /shield-withdraw ────────
  const dep = await ks.depositAndSnapshot(POOL, D0, prov, ethers.parseEther("5"), 500_000_000n);
  await track("KS depositNative (customer)", { payer: "customer" }, dep.txHash);
  const wd = await ksWithdrawProof(dep.record, customer.address, ethers.parseEther("5"));
  const sw = await post("A", "/shield-withdraw", {
    pA: wd.pA, pB: wd.pB, pC: wd.pC, pubSignals: wd.pubSignals, recipient: customer.address,
  });
  await track("/shield-withdraw (fund burner)", { payer: "relay A", via: "A" }, sw.txHash);

  // ── 3. Driver registers (own gas, from the /fund sponsorship) ─────────────
  const regArgs = ["fare-meta:v1:" + "0".repeat(64)];
  const dReg = drivers.connect(driver);
  const reg = await dReg.register(...regArgs, await est(dReg.register, regArgs));
  await receiptOf(reg.hash);
  await track("register driver", { payer: "driver" }, reg.hash);

  // ── 4. Order ──────────────────────────────────────────────────────────────
  console.log("\n2. order lifecycle");
  const dropSalt = rand();
  const dropCommit = b32(positionCommit(DROP.lat, DROP.lon, dropSalt));
  const orderId = await orders.nextOrderId();
  const oc = orders.connect(customer);
  const coArgs = [1n, dropCommit, ORDER_VALUE, 0n, ethers.parseEther("3"), 0, 0];
  // The flat service fee is escrowed on top of orderValue+tip — omitting it
  // reverts with "bad-value".
  const svcFee = await orders.relayServiceFee(ethers.ZeroAddress);
  const co = await oc.createOrder(...coArgs, await est(oc.createOrder, coArgs, { value: ORDER_VALUE + svcFee }));
  await receiptOf(co.hash);
  await track("createOrder", { payer: "customer" }, co.hash);

  // ── 5. Sealed bid via relay B ─────────────────────────────────────────────
  const bidSalt = ethers.hexlify(ethers.randomBytes(32));
  const revokeSecret = ethers.hexlify(ethers.randomBytes(32));
  const revokeHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes32"], [revokeSecret]));
  const bidHash = await orders.bidHashOf(orderId, driver.address, FARE, bidSalt);
  const cb = await post("B", "/commit-bid", {
    orderId: orderId.toString(), bidHash, revokeHash,
    sealed: { epk: "0x" + "11".repeat(33), iv: "0x" + "22".repeat(12), ct: "0x" + "33".repeat(64) },
  });
  await track("/commit-bid (sealed bid)", { payer: "relay B", via: "B" }, cb.txHash);

  const abArgs = [orderId, driver.address, FARE, bidSalt];
  const ab = await oc.acceptSealedBid(...abArgs, await est(oc.acceptSealedBid, abArgs, { value: FARE }));
  await receiptOf(ab.hash);
  await track("acceptSealedBid", { payer: "customer" }, ab.hash);

  // ── 6. Settlement via /submit (relay C) ───────────────────────────────────
  const domain = { name: "FareSettlement", version: "1", chainId, verifyingContract: BOOK.settlement };
  const LOC = { LocationAttestation: [
    { name: "orderId", type: "uint256" }, { name: "phase", type: "uint8" }, { name: "actor", type: "address" },
    { name: "lat", type: "int32" }, { name: "lon", type: "int32" }, { name: "timestamp", type: "uint64" }] };
  let now = Number((await prov.getBlock("latest")).timestamp);
  const dAtt = { orderId: orderId.toString(), phase: 1, actor: driver.address, lat: snap(DRIVER_PICKUP.lat), lon: snap(DRIVER_PICKUP.lon), timestamp: now };
  const vAtt = { orderId: orderId.toString(), phase: 1, actor: D0.address, lat: VENUE.lat, lon: VENUE.lon, timestamp: now };
  const pu = await post("C", "/submit", {
    method: "confirmPickup",
    args: [dAtt, await driver.signTypedData(domain, LOC, { ...dAtt, orderId }), vAtt, await D0.signTypedData(domain, LOC, { ...vAtt, orderId })],
  });
  await track("/submit confirmPickup", { payer: "relay C", via: "C" }, pu.txHash);

  const drvSalt = rand();
  const driverCommit = b32(positionCommit(DRIVER_DROPOFF.lat, DRIVER_DROPOFF.lon, drvSalt));
  const nullifier = b32(poseidon2([dropSalt, orderId]));
  const zk = await snarkjs.groth16.fullProve({
    orderId: orderId.toString(), dropCommit: BigInt(dropCommit).toString(),
    driverCommit: BigInt(driverCommit).toString(), radiusMeters: "100", nullifier: BigInt(nullifier).toString(),
    custLatEnc: encLat(DROP.lat).toString(), custLonEnc: encLon(DROP.lon).toString(), salt: dropSalt.toString(),
    drvLatEnc: encLat(DRIVER_DROPOFF.lat).toString(), drvLonEnc: encLon(DRIVER_DROPOFF.lon).toString(), drvSalt: drvSalt.toString(),
  }, path.join(ROOT, "web/public/zk/proximity.wasm"), path.join(ROOT, "web/public/zk/proximity.zkey"));
  const proofBytes = ethers.solidityPacked(Array(8).fill("uint256"), [
    zk.proof.pi_a[0], zk.proof.pi_a[1], zk.proof.pi_b[0][1], zk.proof.pi_b[0][0],
    zk.proof.pi_b[1][1], zk.proof.pi_b[1][0], zk.proof.pi_c[0], zk.proof.pi_c[1]]);
  now = Number((await prov.getBlock("latest")).timestamp);
  const DC = { DriverCommitAttestation: [
    { name: "orderId", type: "uint256" }, { name: "phase", type: "uint8" }, { name: "actor", type: "address" },
    { name: "posCommit", type: "bytes32" }, { name: "timestamp", type: "uint64" }] };
  const dropAtt = { orderId: orderId.toString(), phase: 2, actor: driver.address, posCommit: driverCommit, timestamp: now };
  const dz = await post("C", "/submit", {
    method: "confirmDropoffZK",
    args: [dropAtt, await driver.signTypedData(domain, DC, { ...dropAtt, orderId }), proofBytes,
      [orderId.toString(), BigInt(dropCommit).toString(), BigInt(driverCommit).toString(), "100", BigInt(nullifier).toString()]],
  });
  await track("/submit confirmDropoffZK", { payer: "relay C", via: "C" }, dz.txHash);

  // ── 7. Phase 3b: the two halves go to DIFFERENT relays ────────────────────
  console.log("\n3. shielded payout — the 3b split");
  const insertVia = "A", spendVia = "B";
  if (insertVia === spendVia) throw new Error("3b: insert and spend must not share a relay");

  const note = { nullifier: rand(), secret: rand() };
  const commitment = noteCommitment(note.nullifier, note.secret, BUCKET);
  const nonce = await vault.shieldNonce(driver.address);
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const sig = await driver.signTypedData(
    { name: "FareVault", version: "1", chainId, verifyingContract: BOOK.vault },
    { ShieldNote: [
      { name: "account", type: "address" }, { name: "bucket", type: "uint96" },
      { name: "commitment", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
    { account: driver.address, bucket: BUCKET, commitment, nonce, deadline }
  );
  const ins = await post(insertVia, "/shield-note", {
    account: driver.address, bucket: BUCKET.toString(), commitment: commitment.toString(), deadline, signature: sig,
  });
  await track(`/shield-note (insert, relay ${insertVia})`, { payer: `relay ${insertVia}`, via: insertVia }, ins.txHash);

  const inserted = await vault.queryFilter(vault.filters.ShieldNoteInserted(), 0, "latest");
  const leaves = inserted.map((l) => ({ i: Number(l.args.index), c: ethers.toBigInt(l.args.commitment) }))
    .sort((a, b) => a.i - b.i).map((x) => x.c);
  const tree = new NoteTree(leaves);
  if ((await vault.noteRoot()) !== tree.root()) throw new Error("note tree disagrees with the client");
  const myIndex = leaves.findIndex((l) => l === commitment);

  const ksOut = ks.makeNote(BUCKET);
  const ksCommitment = ks.commitmentOf(ksOut);
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
     [spend.proof.pi_c[0], spend.proof.pi_c[1]]]);

  const ksStart = Number(await pool.treeSize());
  const preSideNodes = {};
  for (let lv = 0; lv < 128; lv++) preSideNodes[lv] = (await pool.sideNodes(lv)).toString();

  const sp = await post(spendVia, "/shield-note-spend", {
    proof: encoded, root: tree.root().toString(), nullifierHash: spend.publicSignals[1],
    bucket: BUCKET.toString(), ksCommitment: b32(ksCommitment),
  });
  const spRec = await track(`/shield-note-spend (relay ${spendVia})`, { payer: `relay ${spendVia}`, via: spendVia }, sp.txHash);
  console.log(`   ✓ insert via ${insertVia}, spend via ${spendVia} — neither relay saw both halves`);

  // ── 8. Gasless withdrawal — the one endpoint that earns ───────────────────
  console.log("\n4. earning endpoint");
  const relayBalBefore = await vault.balanceOf(addrOf("C"));
  const driverBal = await vault.balanceOf(driver.address);
  const wNonce = await vault.withdrawNonce(driver.address);
  const wDeadline = Math.floor(Date.now() / 1000) + 3600;
  const wSig = await driver.signTypedData(
    { name: "FareVault", version: "1", chainId, verifyingContract: BOOK.vault },
    { Withdraw: [
      { name: "account", type: "address" }, { name: "recipient", type: "address" },
      { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
    { account: driver.address, recipient: driver.address, nonce: wNonce, deadline: wDeadline }
  );
  const wr = await post("C", "/withdraw", {
    account: driver.address, recipient: driver.address, deadline: wDeadline, signature: wSig,
  });
  // Read the fee only AFTER the transaction mines: the POST returns on
  // submission, and reading the relay's balance before inclusion reports zero
  // revenue for the one endpoint that actually earns.
  await receiptOf(wr.txHash);
  const fee = (await vault.balanceOf(addrOf("C"))) - relayBalBefore;
  await track("/withdraw (gasless, earns 1%)", { payer: "relay C", via: "C", revenue: fee }, wr.txHash);
  console.log(`   driver balance ${ethers.formatEther(driverBal)} PAS → relay fee ${ethers.formatEther(fee)} PAS`);

  // ── 9. Pool withdrawal of the shielded note ──────────────────────────────
  const paths = ks.batchNotePaths(ksStart, preSideNodes, [ksCommitment]);
  const outRec = { ...ksOut, index: paths[0].index, leftSnapshot: paths[0].leftSnapshot, depositBlock: spRec.blockNumber };
  const recipient = ethers.Wallet.createRandom().address;
  const w2 = await ksWithdrawProof(outRec, recipient, BUCKET);
  const sw2 = await post("C", "/shield-withdraw", {
    pA: w2.pA, pB: w2.pB, pC: w2.pC, pubSignals: w2.pubSignals, recipient,
  });
  await track("/shield-withdraw (spend note)", { payer: "relay C", via: "C" }, sw2.txHash);

  // ── 10. Venue takes the unsubsidised path ────────────────────────────────
  const vb = await vault.balanceOf(D0.address);
  if (vb > 0n) {
    const vw = await vault.withdraw(await est(vault.withdraw, []));
    await receiptOf(vw.hash);
    await track("vault.withdraw (venue, own gas)", { payer: "venue" }, vw.hash);
  }

  // ── 11. Rate limiting still works without holding addresses ──────────────
  console.log("\n5. relay hardening checks");
  let limited = false;
  for (let i = 0; i < 30; i++) {
    const res = await fetch(`${url("A")}/bidbox?orderId=1`);
    if (res.status === 429) { limited = true; break; }
  }
  console.log(`   ${limited ? "✓" : "·"} rate limit ${limited ? "enforced" : "not reached"} — keyed on a rotating hash, no address table`);

  // ── report ───────────────────────────────────────────────────────────────
  const report = ledger.report({
    ranAt: new Date().toISOString(), chain: "paseo-assethub", gasPriceGwei: "1000",
    orders: BOOK.orders, vault: BOOK.vault, orderId: orderId.toString(),
    relays: RELAYS.map((r) => ({ id: r.id, address: r.address })),
    // Read the live fee rather than hardcoding it: a stale "0" here silently
    // understates what a delivery costs the customer by the whole service fee.
    fees: { protocolFeeBps: 250, relayRebateBps: 0, relayServiceFeePAS: ethers.formatEther(svcFee), withdrawFeeBps: 100 },
  });
  fs.writeFileSync(path.join(OUT, "costs.json"), JSON.stringify(report, null, 2));

  console.log(`\n── totals ──`);
  for (const [k, v] of Object.entries(report.byPayer)) {
    console.log(`   ${k.padEnd(10)} ${String(v.txs).padStart(2)} tx  cost ${v.costPAS.padStart(10)}  revenue ${v.revenuePAS.padStart(8)}  net ${v.netPAS}`);
  }
  console.log(`\n   report e2e-runs/relay-lab/costs.json\n`);
}

// Leave when the work is done. ethers' provider keeps a block poller running, so
// a finished run would otherwise sit there looking unfinished — in CI, until the
// job timed out. Reports above are written synchronously, so there is nothing
// pending to lose. (e2e-lib's runScript does the same for the shield scripts.)
main().then(() => process.exit(0)).catch((e) => {
  console.error("\n❌", e?.shortMessage ?? e?.reason ?? e?.message ?? e);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "costs-partial.json"), JSON.stringify({ error: String(e?.message ?? e), ledger: ledger?.report?.() ?? null }, null, 2));
  process.exit(1);
});
