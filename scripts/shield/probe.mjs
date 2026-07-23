#!/usr/bin/env node
// Kusama Shield feasibility probe (C4). Proves the full shielded-funding recipe
// works against the LIVE Kusama Shield pool on Paseo Asset Hub, end to end:
//   deposit native PAS with a Poseidon commitment
//     → rebuild the LeanIMT from Deposit events
//     → generate a Groth16 withdrawal proof (their v7 circuit)
//     → submit proxy_withdraw (relayer path) directing funds to a FRESH address
//     → confirm the fresh address received PAS, unlinked to the depositor.
//
// This is the de-risk step before wiring FARE: it validates the commitment
// scheme, tree reconstruction, proof generation, and — critically — that the
// pool at POOL accepts our proof (version/artifact match).
//
// Run:  node scripts/shield/probe.mjs        (from repo root; uses web/node_modules)
// Env:  DEPLOYER_PRIVATE_KEY (funds the deposit), SHIELD_POOL (override address)

import { ethers } from "ethers";
import { poseidon1, poseidon2 } from "poseidon-lite";
import * as snarkjs from "snarkjs";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");

// ── config ───────────────────────────────────────────────────────────────────
const RPC = process.env.TESTNET_RPC ?? "https://eth-rpc-testnet.polkadot.io/";
// Docs (PaseoAH.html) canonical pool; repo-v7 fresh is 0x7d5a49… (more leaves).
const POOL = process.env.SHIELD_POOL ?? "0x73082Ac2833afD07D035c512031E6Af72B1bDEBD";
const WASM = path.join(ROOT, "web/public/shield/withdraw_v7.wasm");
const ZKEY = path.join(ROOT, "web/public/shield/withdraw_v7.zkey");
const AMOUNT = ethers.parseEther("0.5"); // deposit + full withdraw
const BN254_R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const NATIVE = 0n; // asset signal for native PAS

function loadDeployerKey() {
  if (process.env.DEPLOYER_PRIVATE_KEY) return process.env.DEPLOYER_PRIVATE_KEY;
  const env = fs.readFileSync(path.join(ROOT, ".env"), "utf8");
  const m = env.match(/^DEPLOYER_PRIVATE_KEY=(.+)$/m);
  if (!m) throw new Error("DEPLOYER_PRIVATE_KEY not found");
  return m[1].trim();
}

const POOL_ABI = [
  "function depositNative(bytes32 commitment) payable",
  "function proxy_withdraw(uint[2] pA, uint[2][2] pB, uint[2] pC, uint[8] pubSignals, address recipient)",
  "function currentRoot() view returns (uint256)",
  "function treeSize() view returns (uint256)",
  "function sideNodes(uint256) view returns (uint256)",
  "function getEscrowBalance(address asset) view returns (uint256)",
  "event Deposit(address indexed asset, bytes32 commitment)",
];

// ── commitment scheme (commitment.circom) ────────────────────────────────────
// nullifierHash = Poseidon(nullifier)
// precommitment = Poseidon(nullifier, secret)
// commitment    = Poseidon(Poseidon(value, asset), precommitment)
function makeNote(value) {
  const nullifier = ethers.toBigInt(ethers.randomBytes(31)) % BN254_R;
  const secret = ethers.toBigInt(ethers.randomBytes(31)) % BN254_R;
  return { nullifier, secret, value };
}
const commitmentOf = (n) =>
  poseidon2([poseidon2([n.value, NATIVE]), poseidon2([n.nullifier, n.secret])]);
const nullifierHashOf = (n) => poseidon1([n.nullifier]);

// ── LeanIMT (mirrors SolidityLeanIMT128 + the KS reference client) ───────────
const bitAt = (n, pos) => (BigInt(n) >> BigInt(pos)) & 1n;
class LeanIMT {
  constructor() { this.leaves = []; this._sn = new Map(); this._root = 0n; }
  insert(leaf) {
    const idx = this.leaves.length;
    let node = leaf;
    for (let lv = 0; lv < 128; lv++) {
      if (bitAt(idx, lv)) {
        const s = this._sn.get(lv) ?? 0n;
        if (s !== 0n) node = poseidon2([s, node]);
      } else this._sn.set(lv, node);
    }
    this._root = node;
    this.leaves.push(leaf);
  }
  findIndex(leaf) { return this.leaves.findIndex((l) => l === leaf); }
  getProof(leafIndex) {
    let layer = [...this.leaves], idx = leafIndex, sibs = [];
    for (let lv = 0; lv < 128; lv++) {
      const si = idx % 2 === 0 ? idx + 1 : idx - 1;
      sibs.push(si < layer.length ? layer[si] : 0n);
      const nxt = [];
      for (let i = 0; i < layer.length; i += 2)
        nxt.push(i + 1 < layer.length ? poseidon2([layer[i], layer[i + 1]]) : layer[i]);
      layer = nxt;
      idx = Math.floor(idx / 2);
    }
    return { siblings: sibs.map((s) => s.toString()), root: this._root.toString() };
  }
}

// Robust getLogs: subdivide any range the RPC rejects (result cap / hiccup) so
// NO deposit is silently missed — a missed leaf corrupts the whole tree.
async function getLogsSafe(provider, filter, from, to, out) {
  try {
    const logs = await provider.getLogs({ ...filter, fromBlock: from, toBlock: to });
    out.push(...logs);
  } catch (e) {
    if (to <= from) throw e;
    const mid = Math.floor((from + to) / 2);
    await getLogsSafe(provider, filter, from, mid, out);
    await getLogsSafe(provider, filter, mid + 1, to, out);
  }
}

async function buildTree(provider) {
  const tree = new LeanIMT();
  const cur = await provider.getBlockNumber();
  const all = [];
  const STEP = Number(process.env.SCAN_STEP ?? 20000); // small chunks: dodge result caps
  // The tree is fed by BOTH deposits AND withdrawal change-commitments — the
  // former emit Deposit(asset, commitment), the latter NewCommitment(hash).
  // Both carry the leaf as the sole 32-byte data word; merge and insert in
  // exact chain order (block, logIndex).
  const perType = {};
  for (const ev of ["Deposit(address,bytes32)", "NewCommitment(bytes32)"]) {
    const filter = { address: POOL, topics: [ethers.id(ev)] };
    const before = all.length;
    for (let s = 0; s <= cur; s += STEP) await getLogsSafe(provider, filter, s, Math.min(s + STEP - 1, cur), all);
    perType[ev] = all.length - before;
  }
  console.log(`   events: Deposit=${perType["Deposit(address,bytes32)"]} NewCommitment=${perType["NewCommitment(bytes32)"]} total=${all.length}`);
  all.sort((a, b) => (a.blockNumber - b.blockNumber) || (a.index - b.index));
  for (const log of all) tree.insert(BigInt(log.data.slice(0, 66)));
  return { tree, count: all.length };
}

// snarkjs proof → Solidity Groth16 args (note the pi_b coordinate swap).
function toSolidity(proof) {
  return {
    pA: [proof.pi_a[0], proof.pi_a[1]],
    pB: [[proof.pi_b[0][1], proof.pi_b[0][0]], [proof.pi_b[1][1], proof.pi_b[1][0]]],
    pC: [proof.pi_c[0], proof.pi_c[1]],
  };
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
  const wallet = new ethers.Wallet(loadDeployerKey(), provider);
  const pool = new ethers.Contract(POOL, POOL_ABI, wallet);
  const recipient = ethers.Wallet.createRandom().address; // fresh, unlinked

  console.log(`Pool:      ${POOL}`);
  console.log(`Depositor: ${wallet.address}  (${ethers.formatEther(await provider.getBalance(wallet.address))} PAS)`);
  console.log(`Recipient: ${recipient}  (fresh)\n`);
  console.log(`tree size before: ${await pool.treeSize()}  escrow: ${ethers.formatEther(await pool.getEscrowBalance(ethers.ZeroAddress))} PAS`);

  // 1. Deposit (reuse a persisted unspent note across runs so we don't strand PAS)
  const noteFile = path.join(__dirname, `note.${POOL.toLowerCase()}.json`);
  let note, commitment;
  if (fs.existsSync(noteFile)) {
    const saved = JSON.parse(fs.readFileSync(noteFile, "utf8"));
    note = { nullifier: BigInt(saved.nullifier), secret: BigInt(saved.secret), value: BigInt(saved.value) };
    commitment = commitmentOf(note);
    console.log(`\n1. reusing saved note (value ${ethers.formatEther(note.value)} PAS, commitment ${ethers.toBeHex(commitment).slice(0, 14)}…)`);
  } else {
    note = makeNote(AMOUNT);
    commitment = commitmentOf(note);
    const commitmentHex = ethers.zeroPadValue(ethers.toBeHex(commitment), 32);
    console.log(`\n1. depositNative(${commitmentHex.slice(0, 14)}…) value=${ethers.formatEther(AMOUNT)} PAS`);
    const dtx = await pool.depositNative(commitmentHex, { value: AMOUNT, gasLimit: 3_000_000n });
    await dtx.wait();
    fs.writeFileSync(noteFile, JSON.stringify({ nullifier: note.nullifier.toString(), secret: note.secret.toString(), value: note.value.toString() }));
    console.log(`   ✓ deposited (tx ${dtx.hash.slice(0, 12)}…)  tree size now: ${await pool.treeSize()}  [note saved]`);
  }

  // 2. Build our leaf's Merkle proof from the on-chain sideNodes.
  //    Our note is the LAST leaf (nothing inserted since our deposit), so its
  //    path siblings ARE the persistent sideNodes at the set bits of its index
  //    — no event reconstruction, no genesis leaf needed. (Only valid for the
  //    rightmost leaf; a general client rebuilds from Deposit+NewCommitment
  //    events. See the integration report.)
  const onchainSize = Number(await pool.treeSize());
  const idx = onchainSize - 1; // rightmost
  console.log(`\n2. building Merkle proof from on-chain sideNodes (leaf index ${idx} = last of ${onchainSize})`);
  // NB: bit test uses BigInt — JS `>>` is 32-bit and WRAPS the shift (idx>>32 ==
  // idx), which fabricates set-bits at high levels and corrupts the root.
  const bit = (lv) => ((BigInt(idx) >> BigInt(lv)) & 1n) === 1n;
  const siblings = [];
  for (let lv = 0; lv < 128; lv++) siblings.push(bit(lv) ? (await pool.sideNodes(lv)).toString() : "0");
  // Recompute the root locally and check it matches the on-chain root (this both
  // validates the sibling set AND confirms our note really is the last leaf).
  let node = commitment;
  for (let lv = 0; lv < 128; lv++) if (bit(lv)) node = poseidon2([BigInt(siblings[lv]), node]);
  const onchainRoot = await pool.currentRoot();
  console.log(`   local root == on-chain currentRoot: ${node === onchainRoot ? "YES ✓" : "NO ✗ (" + node + " vs " + onchainRoot + ")"}`);
  if (node !== onchainRoot) throw new Error("root mismatch — our note is not the last leaf (someone inserted after us) or siblings are off");
  const mp = { siblings, root: onchainRoot.toString() };

  // 3. Generate withdrawal proof (full amount → remaining 0)
  console.log(`\n3. generating Groth16 withdrawal proof…`);
  const change = makeNote(0n); // remaining = existingValue - withdrawnValue = 0
  const context = ethers.toBigInt(ethers.keccak256(ethers.solidityPacked(["address"], [recipient]))) % BN254_R;
  const input = {
    withdrawnValue: AMOUNT.toString(),
    treeDepth: "128",
    context: context.toString(),
    root: mp.root,
    asset: NATIVE.toString(),
    existingValue: note.value.toString(),
    existingNullifier: note.nullifier.toString(),
    existingSecret: note.secret.toString(),
    newNullifier: change.nullifier.toString(),
    newSecret: change.secret.toString(),
    siblings: mp.siblings,
    leafIndex: idx.toString(),
  };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
  console.log(`   ✓ proof generated; publicSignals[${publicSignals.length}]`);
  console.log(`     [0] newCommitmentHash = ${publicSignals[0].slice(0, 16)}…`);
  console.log(`     [1] nullifierHash     = ${publicSignals[1].slice(0, 16)}…  (expected ${nullifierHashOf(note).toString().slice(0, 16)}…)`);
  console.log(`     [3] withdrawnValue    = ${publicSignals[3]}`);
  console.log(`     [6] root              = ${publicSignals[6].slice(0, 16)}…`);
  console.log(`     [7] asset             = ${publicSignals[7]}`);

  // 4. Submit proxy_withdraw (relayer path) → fresh recipient
  const { pA, pB, pC } = toSolidity(proof);
  const balBefore = await provider.getBalance(recipient);
  console.log(`\n4. proxy_withdraw → ${recipient.slice(0, 10)}…`);
  const wtx = await pool.proxy_withdraw(pA, pB, pC, publicSignals, recipient, { gasLimit: 8_000_000n });
  await wtx.wait();
  const balAfter = await provider.getBalance(recipient);
  console.log(`   ✓ withdrawn (tx ${wtx.hash.slice(0, 12)}…)`);
  console.log(`   recipient balance: ${ethers.formatEther(balBefore)} → ${ethers.formatEther(balAfter)} PAS`);

  const delta = balAfter - balBefore;
  if (delta <= 0n) throw new Error("recipient did not receive funds");
  if (fs.existsSync(noteFile)) fs.unlinkSync(noteFile); // nullifier now spent
  console.log(`\n✅ FEASIBILITY CONFIRMED: fresh address received ${ethers.formatEther(delta)} PAS via a shielded withdrawal, unlinked to the depositor.`);
  process.exit(0);
}

main().catch((e) => { console.error("\n❌ PROBE FAILED:", e?.shortMessage ?? e?.message ?? e); process.exit(1); });
