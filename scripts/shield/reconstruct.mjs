#!/usr/bin/env node
// Validate the GENERAL-CASE Kusama Shield tree reconstruction — the client-side
// workaround for KS Issue 1 (the undocumented genesis leaf). If this holds, FARE
// can withdraw ANY note at ANY later time (deposit-ahead / withdraw-later),
// instead of the weak last-leaf deposit-then-immediately-withdraw pattern.
//
// Recipe:
//   1. scan Deposit + NewCommitment events (ordered by block, logIndex)
//   2. recover the genesis leaf (index 0) = currentRoot() read at a block AFTER
//      construction but BEFORE the first deposit (a 1-leaf LeanIMT's root == the
//      leaf). Recoverable from any archive node.
//   3. rebuild the full tree (genesis first, then events) with BigInt bit tests
//   4. assert leafCount == treeSize AND recomputed root == currentRoot()
//   5. prove an ARBITRARY (non-last) leaf's Merkle path reproduces the root
import { ethers } from "ethers";
import { poseidon2 } from "poseidon-lite";

const RPC = process.env.TESTNET_RPC ?? "https://eth-rpc-testnet.polkadot.io/";
const POOL = process.env.SHIELD_POOL ?? "0x7d5a496bD61b631025A828d9049f6A68e007e0dC";
const p = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
const POOL_C = new ethers.Contract(POOL, [
  "function currentRoot() view returns (uint256)",
  "function treeSize() view returns (uint256)",
], p);

const bitAt = (n, pos) => (BigInt(n) >> BigInt(pos)) & 1n;

// LeanIMT mirroring SolidityLeanIMT128: parent = Poseidon(left,right), a lone
// node promotes unchanged; root = last inserted node.
class LeanIMT {
  constructor() { this.leaves = []; this._sn = new Map(); this._root = 0n; }
  insert(leaf) {
    const idx = this.leaves.length;
    let node = leaf;
    for (let lv = 0; lv < 128; lv++) {
      if (bitAt(idx, lv)) { const s = this._sn.get(lv) ?? 0n; if (s !== 0n) node = poseidon2([s, node]); }
      else this._sn.set(lv, node);
    }
    this._root = node; this.leaves.push(leaf);
  }
  get root() { return this._root; }
  proof(leafIndex) {
    let layer = [...this.leaves], idx = leafIndex, sibs = [];
    for (let lv = 0; lv < 128 && layer.length > 1; lv++) {
      const si = idx % 2 === 0 ? idx + 1 : idx - 1;
      sibs.push({ lv, value: si < layer.length ? layer[si] : null, right: idx % 2 === 0 });
      const nxt = [];
      for (let i = 0; i < layer.length; i += 2) nxt.push(i + 1 < layer.length ? poseidon2([layer[i], layer[i + 1]]) : layer[i]);
      layer = nxt; idx = Math.floor(idx / 2);
    }
    return sibs;
  }
}

// Recompute a root from a leaf + its sibling list (verifies a path).
function rootFromProof(leaf, sibs) {
  let node = leaf;
  for (const s of sibs) {
    if (s.value == null) continue; // lone promotion
    node = s.right ? poseidon2([node, s.value]) : poseidon2([s.value, node]);
  }
  return node;
}

async function getLogsSafe(filter, from, to, out) {
  try { out.push(...await p.getLogs({ ...filter, fromBlock: from, toBlock: to })); }
  catch (e) { if (to <= from) throw e; const m = (from + to) >> 1; await getLogsSafe(filter, from, m, out); await getLogsSafe(filter, m + 1, to, out); }
}

async function scanInserts() {
  const cur = await p.getBlockNumber();
  const STEP = Number(process.env.SCAN_STEP ?? 20000);
  const all = [];
  for (const ev of ["Deposit(address,bytes32)", "NewCommitment(bytes32)"]) {
    const filter = { address: POOL, topics: [ethers.id(ev)] };
    for (let s = 0; s <= cur; s += STEP) await getLogsSafe(filter, s, Math.min(s + STEP - 1, cur), all);
  }
  all.sort((a, b) => (a.blockNumber - b.blockNumber) || (a.index - b.index));
  return all;
}

// Recover the genesis leaf: read currentRoot() at a historical block strictly
// before the first insert event (tree has only the genesis leaf → root == leaf).
async function recoverGenesis(firstInsertBlock) {
  for (const bn of [firstInsertBlock - 1, firstInsertBlock - 2, Math.max(0, firstInsertBlock - 10)]) {
    try {
      const size = await POOL_C.treeSize({ blockTag: bn });
      const root = await POOL_C.currentRoot({ blockTag: bn });
      if (size === 1n) { console.log(`   genesis recovered at block ${bn}: treeSize=1, root=leaf`); return root; }
      console.log(`   block ${bn}: treeSize=${size} (need 1) — trying earlier`);
    } catch (e) { console.log(`   block ${bn}: historical read failed (${e.shortMessage ?? e.message})`); }
  }
  return null;
}

async function main() {
  const treeSize = Number(await POOL_C.treeSize());
  const onchainRoot = await POOL_C.currentRoot();
  console.log(`pool ${POOL}\n  treeSize ${treeSize}  currentRoot ${ethers.toBeHex(onchainRoot).slice(0, 18)}…`);

  const events = await scanInserts();
  console.log(`\n1. insert events: ${events.length}  (treeSize ${treeSize} ⇒ ${treeSize - events.length} unemitted → genesis)`);
  const firstBlk = events[0].blockNumber;

  console.log(`\n2. recover genesis leaf (Issue 1 workaround)`);
  const genesis = await recoverGenesis(firstBlk);
  if (genesis == null) { console.log("   ✗ could not recover genesis via historical reads (archive node needed)"); process.exit(2); }

  console.log(`\n3. rebuild full tree (genesis + ${events.length} events)`);
  const tree = new LeanIMT();
  tree.insert(genesis);
  for (const e of events) tree.insert(BigInt(e.data.slice(0, 66)));

  const countOk = tree.leaves.length === treeSize;
  const rootOk = tree.root === onchainRoot;
  console.log(`   leafCount ${tree.leaves.length} == treeSize ${treeSize}: ${countOk ? "YES ✓" : "NO ✗"}`);
  console.log(`   recomputed root == currentRoot: ${rootOk ? "YES ✓" : "NO ✗"}`);

  console.log(`\n4. prove an ARBITRARY (non-last) leaf's path reproduces the root`);
  const idx = Math.floor(treeSize / 3); // some interior leaf
  const sibs = tree.proof(idx);
  const recomputed = rootFromProof(tree.leaves[idx], sibs);
  console.log(`   leaf #${idx} path → root matches: ${recomputed === onchainRoot ? "YES ✓" : "NO ✗"}`);

  if (countOk && rootOk && recomputed === onchainRoot) {
    console.log(`\n✅ GENERAL RECONSTRUCTION WORKS — any note is withdrawable at any later time.`);
    console.log(`   genesis leaf = ${ethers.toBeHex(genesis)}`);
    process.exit(0);
  }
  console.log(`\n❌ reconstruction mismatch`); process.exit(1);
}
main().catch((e) => { console.error("FAILED:", e?.shortMessage ?? e?.message ?? e); process.exit(1); });
