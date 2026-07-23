#!/usr/bin/env node
// PROVE deposit-ahead / withdraw-later (the robust KS Issue-1 workaround).
//
// Instead of recovering the undocumented genesis leaf or scanning all history
// (both unreliable on the public RPC), we SNAPSHOT the note's immutable
// left-path at deposit time and reconstruct only the right side later:
//
//   deposit A → record { index, leftSiblings = sideNodes[lv] for bit(index,lv)=1 }
//   deposit B → now A is NOT the last leaf
//   withdraw A → rebuild A's auth path (left = snapshot, right = leaves after A
//                from a bounded post-deposit event scan) → proxy_withdraw
//
// If A (a non-last leaf) withdraws, the workaround holds: any note is spendable
// at any later time without the genesis value and without full-history logs.
import { ethers } from "ethers";
import { poseidon1, poseidon2 } from "poseidon-lite";
import * as snarkjs from "snarkjs";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");
const RPC = process.env.TESTNET_RPC ?? "https://eth-rpc-testnet.polkadot.io/";
const POOL = process.env.SHIELD_POOL ?? "0x7d5a496bD61b631025A828d9049f6A68e007e0dC";
const WASM = path.join(ROOT, "web/public/shield/withdraw_v7.wasm");
const ZKEY = path.join(ROOT, "web/public/shield/withdraw_v7.zkey");
const BN254_R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const AMOUNT = ethers.parseEther("0.5");

const env = (k) => (fs.readFileSync(path.join(ROOT, ".env"), "utf8").match(new RegExp("^" + k + "=(.+)$", "m")) || [])[1]?.trim();
const p = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
const wallet = new ethers.Wallet(env("DEPLOYER_PRIVATE_KEY"), p);
const POOL_ABI = [
  "function depositNative(bytes32 commitment) payable",
  "function proxy_withdraw(uint[2] pA, uint[2][2] pB, uint[2] pC, uint[8] pubSignals, address recipient)",
  "function currentRoot() view returns (uint256)",
  "function treeSize() view returns (uint256)",
  "function sideNodes(uint256) view returns (uint256)",
];
const pool = new ethers.Contract(POOL, POOL_ABI, wallet);

const bit = (n, lv) => ((BigInt(n) >> BigInt(lv)) & 1n) === 1n;
const b32 = (x) => ethers.zeroPadValue(ethers.toBeHex(x), 32);
const rand = () => ethers.toBigInt(ethers.randomBytes(31)) % BN254_R;
const makeNote = (value) => ({ nullifier: rand(), secret: rand(), value });
const commitmentOf = (n) => poseidon2([poseidon2([n.value, 0n]), poseidon2([n.nullifier, n.secret])]);

async function getLogsSafe(filter, from, to, out) {
  try { out.push(...await p.getLogs({ ...filter, fromBlock: from, toBlock: to })); }
  catch (e) { if (to <= from) throw e; const m = (from + to) >> 1; await getLogsSafe(filter, from, m, out); await getLogsSafe(filter, m + 1, to, out); }
}

async function deposit(note, label) {
  const sizeBefore = Number(await pool.treeSize());
  const nonce = await p.getTransactionCount(wallet.address);
  const tx = await pool.depositNative(b32(commitmentOf(note)), { value: note.value, gasLimit: 3_000_000n, nonce });
  const rc = await tx.wait();
  console.log(`   ${label}: deposited at leaf index ${sizeBefore} (tx ${tx.hash.slice(0, 12)}…, block ${rc.blockNumber})`);
  return { index: sizeBefore, block: rc.blockNumber };
}

// Snapshot the immutable LEFT siblings of `index`: sideNodes[lv] for bit(index,lv)=1.
// These are set by leaves to the LEFT and never change once `index` is inserted,
// so reading them right after our deposit captures the whole left context —
// genesis included — with no historical read.
async function snapshotLeftPath(index) {
  const left = {};
  for (let lv = 0; lv < 128; lv++) if (bit(index, lv)) left[lv] = (await pool.sideNodes(lv)).toString();
  return left;
}

// Compute the root of the LeanIMT subtree covering [start, start+2^lv) from a
// sparse map of known leaves (absolute index → value). Lone nodes promote.
// BigInt indices + a short-circuit on ranges entirely beyond the known leaves,
// so empty high-level ranges return instantly (no exponential recursion, no
// 32-bit `>>` wrap).
function subtreeRoot(leaves, lv, startBig, maxIdx) {
  if (startBig > BigInt(maxIdx)) return null; // whole range is past the last leaf
  if (lv === 0) { const s = Number(startBig); return leaves.has(s) ? leaves.get(s) : null; }
  const half = 1n << BigInt(lv - 1);
  const l = subtreeRoot(leaves, lv - 1, startBig, maxIdx);
  const r = subtreeRoot(leaves, lv - 1, startBig + half, maxIdx);
  if (l != null && r != null) return poseidon2([l, r]);
  return l != null ? l : null; // lone promotion (or empty)
}

// Rebuild `index`'s 128-sibling auth path: left from snapshot, right from the
// leaves inserted AFTER index (scanned from depositBlock onward — bounded).
function authPath(index, leftSnapshot, rightLeaves, maxIdx) {
  const siblings = [];
  const idxB = BigInt(index);
  for (let lv = 0; lv < 128; lv++) {
    if (bit(index, lv)) {
      siblings.push(leftSnapshot[lv] ?? "0"); // immutable left sibling
    } else {
      const start = ((idxB >> BigInt(lv)) + 1n) << BigInt(lv); // first index of the right sibling subtree
      const r = subtreeRoot(rightLeaves, lv, start, maxIdx); // right subtree from post-deposit leaves
      siblings.push(r == null ? "0" : r.toString());
    }
  }
  return siblings;
}

async function main() {
  console.log(`pool ${POOL}  depositor ${wallet.address}`);
  console.log(`balance ${ethers.formatEther(await p.getBalance(wallet.address))} PAS  treeSize ${await pool.treeSize()}\n`);

  // 1. Deposit A and snapshot its left path.
  console.log("1. Deposit note A (the note we'll withdraw LATER, as a non-last leaf)");
  const noteA = makeNote(AMOUNT);
  const A = await deposit(noteA, "A");
  const leftA = await snapshotLeftPath(A.index);
  console.log(`   snapshot: ${Object.keys(leftA).length} left siblings at bit-set levels of index ${A.index}`);

  // 2. Deposit B so A is no longer the rightmost leaf.
  console.log("\n2. Deposit note B (pushes A into the interior)");
  const noteB = makeNote(AMOUNT);
  await deposit(noteB, "B");

  // 3. Rebuild A's path from snapshot(left) + post-deposit events(right).
  console.log("\n3. Reconstruct A's Merkle path (left = snapshot, right = leaves after A)");
  const cur = await p.getBlockNumber();
  const logs = [];
  for (const ev of ["Deposit(address,bytes32)", "NewCommitment(bytes32)"])
    await getLogsSafe({ address: POOL, topics: [ethers.id(ev)] }, A.block, cur, logs);
  logs.sort((a, b) => (a.blockNumber - b.blockNumber) || (a.index - b.index));
  // Map post-A leaves to absolute indices. A is at A.index; leaves in `logs`
  // starting from A occupy A.index, A.index+1, … Identify A's own commitment to
  // anchor, then assign the rest sequentially.
  const commitA = commitmentOf(noteA);
  const rightLeaves = new Map();
  let assigned = A.index, anchored = false;
  for (const l of logs) {
    const leaf = BigInt(l.data.slice(0, 66));
    if (!anchored) { if (leaf === commitA) { anchored = true; } else continue; }
    rightLeaves.set(assigned, leaf);
    assigned++;
  }
  const maxIdx = assigned - 1;
  console.log(`   anchored A at index ${A.index}; have ${rightLeaves.size} leaves from A onward (up to index ${maxIdx}, treeSize ${await pool.treeSize()})`);
  const siblings = authPath(A.index, leftA, rightLeaves, maxIdx);

  // verify locally against currentRoot
  let node = commitA;
  for (let lv = 0; lv < 128; lv++) {
    const s = BigInt(siblings[lv]);
    node = bit(A.index, lv) ? (s === 0n ? node : poseidon2([s, node])) : (s === 0n ? node : poseidon2([node, s]));
  }
  const onchainRoot = await pool.currentRoot();
  const ok = node === onchainRoot;
  console.log(`   local root == currentRoot: ${ok ? "YES ✓" : "NO ✗ (" + ethers.toBeHex(node).slice(0,18) + " vs " + ethers.toBeHex(onchainRoot).slice(0,18) + ")"}`);
  if (!ok) throw new Error("reconstructed path does not match on-chain root");

  // 4. Build a withdrawal proof for the interior leaf A and withdraw it.
  console.log("\n4. Withdraw the interior leaf A (proves the reconstructed path is circuit-valid)");
  const recipient = ethers.Wallet.createRandom().address;
  const change = makeNote(0n);
  const context = ethers.toBigInt(ethers.keccak256(ethers.solidityPacked(["address"], [recipient]))) % BN254_R;
  const input = {
    withdrawnValue: noteA.value.toString(), treeDepth: "128", context: context.toString(),
    root: onchainRoot.toString(), asset: "0", existingValue: noteA.value.toString(),
    existingNullifier: noteA.nullifier.toString(), existingSecret: noteA.secret.toString(),
    newNullifier: change.nullifier.toString(), newSecret: change.secret.toString(),
    siblings, leafIndex: A.index.toString(),
  };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
  const nh = poseidon1([noteA.nullifier]).toString();
  console.log(`   proof ok; nullifierHash ${publicSignals[1].slice(0,14)}… (expect ${nh.slice(0,14)}…)`);
  const pB = [[proof.pi_b[0][1], proof.pi_b[0][0]], [proof.pi_b[1][1], proof.pi_b[1][0]]];
  const before = await p.getBalance(recipient);
  const nonce = await p.getTransactionCount(wallet.address);
  const wtx = await pool.proxy_withdraw([proof.pi_a[0], proof.pi_a[1]], pB, [proof.pi_c[0], proof.pi_c[1]], publicSignals, recipient, { gasLimit: 8_000_000n, nonce });
  await wtx.wait();
  const after = await p.getBalance(recipient);
  console.log(`   recipient ${recipient.slice(0,10)}… ${ethers.formatEther(before)} → ${ethers.formatEther(after)} PAS`);
  if (after - before <= 0n) throw new Error("interior-leaf withdrawal did not deliver funds");

  console.log(`\n✅ DEPOSIT-AHEAD / WITHDRAW-LATER PROVEN: an interior (non-last) note withdrew via the snapshot+right-scan reconstruction — no genesis value, no full-history logs. Note B (index ${A.index + 1}) remains for a future withdrawal.`);
  fs.writeFileSync(path.join(__dirname, "validate-noteB.json"), JSON.stringify({ nullifier: noteB.nullifier.toString(), secret: noteB.secret.toString(), value: noteB.value.toString(), index: A.index + 1 }, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error("\n❌ FAILED:", e?.shortMessage ?? e?.message ?? e); process.exit(1); });
