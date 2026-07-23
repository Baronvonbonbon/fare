#!/usr/bin/env node
// Exercise the venue relay's POST /shield-withdraw end to end against the live
// KS pool: deposit + snapshot → build a withdrawal proof for a fresh burner →
// POST to the relay → confirm the burner is funded. Validates the new endpoint
// (context check, submit, sponsor mode). Run the relay first (venue-node).
import { ethers } from "ethers";
import { poseidon2 } from "poseidon-lite";
import * as snarkjs from "snarkjs";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");
const RPC = process.env.TESTNET_RPC ?? "https://eth-rpc-testnet.polkadot.io/";
const POOL = process.env.SHIELD_POOL ?? "0x7d5a496bD61b631025A828d9049f6A68e007e0dC";
const RELAY = process.env.RELAY_URL ?? "http://localhost:8788";
const WASM = path.join(ROOT, "web/public/shield/withdraw_v7.wasm");
const ZKEY = path.join(ROOT, "web/public/shield/withdraw_v7.zkey");
const BN254_R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const AMOUNT = ethers.parseEther("0.5");

const env = (k) => (fs.readFileSync(path.join(ROOT, ".env"), "utf8").match(new RegExp("^" + k + "=(.+)$", "m")) || [])[1]?.trim();
const p = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
const w = new ethers.Wallet(env("DEPLOYER_PRIVATE_KEY"), p);
const ABI = ["function depositNative(bytes32) payable", "function currentRoot() view returns(uint256)", "function treeSize() view returns(uint256)", "function sideNodes(uint256) view returns(uint256)"];
const pool = new ethers.Contract(POOL, ABI, w);
const bit = (n, lv) => ((BigInt(n) >> BigInt(lv)) & 1n) === 1n;
const b32 = (x) => ethers.zeroPadValue(ethers.toBeHex(x), 32);
const rand = () => ethers.toBigInt(ethers.randomBytes(31)) % BN254_R;
const commitmentOf = (n) => poseidon2([poseidon2([n.value, 0n]), poseidon2([n.nullifier, n.secret])]);

function subtreeRoot(leaves, lv, start, maxIdx) {
  if (start > BigInt(maxIdx)) return null;
  if (lv === 0) { const s = Number(start); return leaves.has(s) ? leaves.get(s) : null; }
  const half = 1n << BigInt(lv - 1);
  const l = subtreeRoot(leaves, lv - 1, start, maxIdx), r = subtreeRoot(leaves, lv - 1, start + half, maxIdx);
  return l != null && r != null ? poseidon2([l, r]) : (l != null ? l : null);
}
function authPath(index, left, right, maxIdx) {
  const out = [], iB = BigInt(index);
  for (let lv = 0; lv < 128; lv++) {
    if (bit(index, lv)) { out.push(left[lv] ?? "0"); continue; }
    const r = subtreeRoot(right, lv, ((iB >> BigInt(lv)) + 1n) << BigInt(lv), maxIdx);
    out.push(r == null ? "0" : r.toString());
  }
  return out;
}

async function main() {
  console.log(`relay ${RELAY}  pool ${POOL}`);
  const health = await (await fetch(`${RELAY}/health`)).json();
  console.log(`relay health: mode=${health.shieldMode} fee=${health.shieldFeePAS} relay=${health.relay}`);
  const feeMode = Number(health.shieldFeePAS) > 0;

  // 1. deposit + snapshot
  const note = { nullifier: rand(), secret: rand(), value: AMOUNT };
  const index = Number(await pool.treeSize());
  const dtx = await pool.depositNative(b32(commitmentOf(note)), { value: AMOUNT, gasLimit: 3_000_000n, nonce: await p.getTransactionCount(w.address) });
  const drc = await dtx.wait();
  const left = {};
  for (let lv = 0; lv < 128; lv++) if (bit(index, lv)) left[lv] = (await pool.sideNodes(lv)).toString();
  console.log(`1. deposited note at index ${index} (block ${drc.blockNumber}); snapshot ${Object.keys(left).length} left siblings`);

  // 2. reconstruct path (right = leaves from our deposit block onward)
  const cur = await p.getBlockNumber();
  const logs = [];
  for (const ev of ["Deposit(address,bytes32)", "NewCommitment(bytes32)"]) {
    try { logs.push(...await p.getLogs({ address: POOL, topics: [ethers.id(ev)], fromBlock: drc.blockNumber, toBlock: cur })); } catch {}
  }
  logs.sort((a, b) => (a.blockNumber - b.blockNumber) || (a.index - b.index));
  const commit = commitmentOf(note); const right = new Map(); let idx = index, anchored = false;
  for (const l of logs) { const leaf = ethers.toBigInt(l.data.slice(0, 66)); if (!anchored) { if (leaf === commit) anchored = true; else continue; } right.set(idx, leaf); idx++; }
  const siblings = authPath(index, left, right, idx - 1);
  // 3. build withdrawal proof for a fresh burner (sponsor mode) or relay (fee mode)
  const burner = ethers.Wallet.createRandom().address;
  const recipient = feeMode ? health.relay : burner;
  const context = ethers.toBigInt(ethers.keccak256(ethers.solidityPacked(["address"], [recipient]))) % BN254_R;
  const change = { nullifier: rand(), secret: rand(), value: 0n };
  const input = { withdrawnValue: AMOUNT.toString(), treeDepth: "128", context: context.toString(), root: (await pool.currentRoot()).toString(), asset: "0", existingValue: AMOUNT.toString(), existingNullifier: note.nullifier.toString(), existingSecret: note.secret.toString(), newNullifier: change.nullifier.toString(), newSecret: change.secret.toString(), siblings, leafIndex: index.toString() };
  console.log(`2. building withdrawal proof (recipient ${recipient.slice(0, 10)}…, ${feeMode ? "fee" : "sponsor"} mode)`);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
  const pB = [[proof.pi_b[0][1], proof.pi_b[0][0]], [proof.pi_b[1][1], proof.pi_b[1][0]]];

  // 4. POST to the relay endpoint
  const before = await p.getBalance(burner);
  console.log(`3. POST /shield-withdraw → funding burner ${burner.slice(0, 10)}…`);
  const res = await fetch(`${RELAY}/shield-withdraw`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pA: [proof.pi_a[0], proof.pi_a[1]], pB, pC: [proof.pi_c[0], proof.pi_c[1]], pubSignals: publicSignals, recipient, burner }) });
  const j = await res.json();
  console.log(`   relay responded ${res.status}: ${JSON.stringify(j)}`);
  if (!res.ok) throw new Error("relay rejected the withdrawal");

  // 5. confirm by effect (balance rise)
  for (let i = 0; i < 15; i++) { await new Promise((r) => setTimeout(r, 2000)); if ((await p.getBalance(burner)) > before) break; }
  const after = await p.getBalance(burner);
  console.log(`4. burner balance ${ethers.formatEther(before)} → ${ethers.formatEther(after)} PAS`);
  if (after <= before) throw new Error("burner not funded");
  console.log(`\n✅ RELAY /shield-withdraw WORKS (${feeMode ? "fee" : "sponsor"} mode): fresh burner funded via the venue node.`);
  process.exit(0);
}
main().catch((e) => { console.error("\n❌ FAILED:", e?.shortMessage ?? e?.message ?? e); process.exit(1); });
