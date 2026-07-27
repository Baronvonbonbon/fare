// Kusama Shield pool client (C4 shielded burner funding).
//
// The engine behind web/src/shield.ts's ShieldedFunder. It implements the
// ROBUST deposit-ahead / withdraw-later flow — validated live in
// scripts/shield/validate-general-withdraw.mjs — that works AROUND two KS-side
// issues without waiting for upstream fixes:
//
//   • Issue 1 (undocumented genesis leaf): we never need the genesis value. At
//     deposit time we SNAPSHOT the note's immutable left-path (sideNodes[lv] at
//     the bit-set levels of its index). Those siblings are complete left-subtree
//     roots — genesis included — and never change once the leaf is inserted.
//   • Full-history log gaps: at withdraw time we reconstruct only the RIGHT side
//     of the path, from a BOUNDED scan of Deposit+NewCommitment events since the
//     deposit block. No genesis, no full replay.
//
// Poseidon is poseidon-lite (circom-compatible; the same lib zk.ts uses).
// Groth16 proofs use the published v7 artifacts served at /shield/.
import { poseidon1, poseidon2 } from "poseidon-lite";
import { Contract, keccak256, solidityPacked, zeroPadValue, toBeHex, toBigInt, randomBytes, type Provider, type Signer } from "ethers";

export const KS_POOL_ABI = [
  "function depositNative(bytes32 commitment) payable",
  "function proxy_withdraw(uint[2] pA, uint[2][2] pB, uint[2] pC, uint[8] pubSignals, address recipient)",
  "function currentRoot() view returns (uint256)",
  "function treeSize() view returns (uint256)",
  "function sideNodes(uint256) view returns (uint256)",
  "event Deposit(address indexed asset, bytes32 commitment)",
  "event NewCommitment(bytes32 commitment)",
];

const BN254_R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const SHIELD_BASE = "/shield/";
const WASM = `${SHIELD_BASE}withdraw_v7.wasm`;
const ZKEY_MANIFEST = `${SHIELD_BASE}withdraw_v7.zkey.json`;
const NATIVE = 0n;

export interface Note {
  nullifier: string; // decimal string (field element)
  secret: string;
  value: string; // wei
}
/// A spendable note plus everything needed to rebuild its Merkle path later
/// without the genesis leaf or a full-history scan. Persisted device-local.
export interface NoteRecord extends Note {
  index: number; // leaf index at deposit
  leftSnapshot: Record<number, string>; // sideNodes[lv] for bit(index,lv)==1
  depositBlock: number;
  spent?: boolean;
}

// ── commitment scheme (KS commitment.circom) ─────────────────────────────────
const b32 = (x: bigint): string => zeroPadValue(toBeHex(x), 32);
const randField = (): bigint => toBigInt(randomBytes(31)) % BN254_R;
export const makeNote = (valueWei: bigint): Note => ({
  nullifier: randField().toString(), secret: randField().toString(), value: valueWei.toString(),
});
export const commitmentOf = (n: Note): bigint =>
  poseidon2([poseidon2([BigInt(n.value), NATIVE]), poseidon2([BigInt(n.nullifier), BigInt(n.secret)])]);
export const nullifierHashOf = (n: Note): bigint => poseidon1([BigInt(n.nullifier)]);
export const contextFor = (recipient: string): bigint =>
  toBigInt(keccak256(solidityPacked(["address"], [recipient]))) % BN254_R;

const bit = (n: number | bigint, lv: number): boolean => ((BigInt(n) >> BigInt(lv)) & 1n) === 1n;

// ── deposit + left-path snapshot ─────────────────────────────────────────────
/// Deposit `valueWei` into the pool and capture the note's immutable left path.
/// Returns a fully-spendable NoteRecord to persist. `signer` funds the deposit.
///
/// `gasLimit` is REQUIRED, not defaulted: Paseo reserves gasLimit × gasPrice at
/// submission, so the right limit differs by an order of magnitude between a
/// funded operator and a 5 PAS burner. Callers budget it — see
/// web/src/gasbudget.ts. (This module is also imported by node in the hardhat
/// tests, so it deliberately has no relative imports of its own.)
export async function depositAndSnapshot(
  poolAddr: string, signer: Signer, provider: Provider, valueWei: bigint, gasLimit: bigint
): Promise<{ record: NoteRecord; txHash: string }> {
  const poolW = new Contract(poolAddr, KS_POOL_ABI, signer);
  const poolR = new Contract(poolAddr, KS_POOL_ABI, provider);
  const index = Number(await poolR.treeSize()); // our leaf will land here
  const note = makeNote(valueWei);
  const tx = await poolW.depositNative(b32(commitmentOf(note)), { value: valueWei, gasLimit });
  const receipt = await tx.wait();
  // sideNodes[lv] at bit-set levels are UNCHANGED by our insert and never change
  // afterwards → snapshot them now as the permanent left path.
  const leftSnapshot: Record<number, string> = {};
  for (let lv = 0; lv < 128; lv++) if (bit(index, lv)) leftSnapshot[lv] = (await poolR.sideNodes(lv)).toString();
  // The RECEIPT's block, not the current one: `tx.blockNumber` can still be null
  // after `wait()`, and falling back to `getBlockNumber()` puts depositBlock
  // AHEAD of the deposit whenever a block lands in between — the later scan then
  // starts past its own commitment and the note looks lost. Step back one block
  // for good measure, since the scan is bounded either way.
  const minedAt = receipt?.blockNumber ?? tx.blockNumber ?? (await provider.getBlockNumber());
  return { record: { ...note, index, leftSnapshot, depositBlock: Math.max(0, Number(minedAt) - 1) }, txHash: tx.hash };
}

// ── batched deposits: deriving a note's left path after the fact ─────────────
/// Left paths for every commitment in a vault batch (docs/PRIVACY-TIERS.md §4).
///
/// `depositAndSnapshot` works because the depositor reads `sideNodes` the instant
/// their leaf lands. A batch payout can't do that: the recipient isn't the
/// depositor, and N leaves are inserted inside ONE transaction, so by the time
/// anyone reads `sideNodes` the later inserts have overwritten the levels the
/// earlier leaves needed.
///
/// What IS sufficient is the tree state from just BEFORE the batch plus the
/// ordered commitments: every left sibling of a batch member either lies wholly
/// before the batch (captured by `preSideNodes`) or is built from batch members
/// (computable here). So the keeper publishes only public chain state and each
/// recipient replays the insertions locally — secrets never leave the device.
export function batchNotePaths(
  startIndex: number, preSideNodes: Record<number, string>, commitments: bigint[]
): { index: number; leftSnapshot: Record<number, string> }[] {
  const side: Record<number, bigint> = {};
  for (let lv = 0; lv < 128; lv++) side[lv] = BigInt(preSideNodes[lv] ?? "0");

  return commitments.map((leaf, k) => {
    const index = startIndex + k;
    // Capture before inserting: the insert only writes at bit-CLEAR levels, but
    // reading first keeps the snapshot obviously independent of the update.
    const leftSnapshot: Record<number, string> = {};
    for (let lv = 0; lv < 128; lv++) if (bit(index, lv)) leftSnapshot[lv] = side[lv].toString();

    let node = leaf;
    for (let lv = 0; lv < 128; lv++) {
      if (bit(index, lv)) { if (side[lv] !== 0n) node = poseidon2([side[lv], node]); }
      else side[lv] = node;
    }
    return { index, leftSnapshot };
  });
}

// ── right-side reconstruction (bounded, genesis-free) ────────────────────────
async function getLogsSafe(provider: Provider, filter: any, from: number, to: number, out: any[]): Promise<void> {
  try { out.push(...(await provider.getLogs({ ...filter, fromBlock: from, toBlock: to }))); }
  catch (e) { if (to <= from) throw e; const m = (from + to) >> 1; await getLogsSafe(provider, filter, from, m, out); await getLogsSafe(provider, filter, m + 1, to, out); }
}

/// Root of the LeanIMT subtree covering [start, start+2^lv) from a sparse map of
/// known leaves. BigInt indices + short-circuit past the last leaf ⇒ no
/// exponential recursion on empty high-level ranges, no 32-bit `>>` wrap.
export function subtreeRoot(leaves: Map<number, bigint>, lv: number, start: bigint, maxIdx: number): bigint | null {
  if (start > BigInt(maxIdx)) return null;
  if (lv === 0) { const s = Number(start); return leaves.has(s) ? leaves.get(s)! : null; }
  const half = 1n << BigInt(lv - 1);
  const l = subtreeRoot(leaves, lv - 1, start, maxIdx);
  const r = subtreeRoot(leaves, lv - 1, start + half, maxIdx);
  if (l != null && r != null) return poseidon2([l, r]);
  return l != null ? l : null; // lone promotion / empty
}

/// Rebuild `index`'s 128-sibling path: left = snapshot, right = leaves after it.
export function authPath(index: number, leftSnapshot: Record<number, string>, rightLeaves: Map<number, bigint>, maxIdx: number): string[] {
  const siblings: string[] = [];
  const idxB = BigInt(index);
  for (let lv = 0; lv < 128; lv++) {
    if (bit(index, lv)) { siblings.push(leftSnapshot[lv] ?? "0"); continue; }
    const start = ((idxB >> BigInt(lv)) + 1n) << BigInt(lv);
    const r = subtreeRoot(rightLeaves, lv, start, maxIdx);
    siblings.push(r == null ? "0" : r.toString());
  }
  return siblings;
}

/// Reconstruct the note's current Merkle path + on-chain root. Scans inserts
/// from depositBlock onward (bounded) and anchors on the note's own commitment.
export async function reconstructPath(
  provider: Provider, poolAddr: string, record: NoteRecord
): Promise<{ siblings: string[]; root: string }> {
  const poolR = new Contract(poolAddr, KS_POOL_ABI, provider);
  const cur = await provider.getBlockNumber();
  const logs: any[] = [];
  for (const ev of ["Deposit(address,bytes32)", "NewCommitment(bytes32)"])
    await getLogsSafe(provider, { address: poolAddr, topics: [keccak256(solidityPacked(["string"], [ev]))] }, record.depositBlock, cur, logs);
  // NB: topic0 = keccak of the canonical signature; ethers.id would do the same.
  logs.sort((a, b) => (a.blockNumber - b.blockNumber) || (a.index - b.index));
  const commit = commitmentOf(record);
  const rightLeaves = new Map<number, bigint>();
  let idx = record.index, anchored = false;
  for (const l of logs) {
    const leaf = toBigInt((l.data as string).slice(0, 66));
    if (!anchored) { if (leaf === commit) anchored = true; else continue; }
    rightLeaves.set(idx, leaf); idx++;
  }
  if (!anchored) throw new Error("note commitment not found from depositBlock — wrong pool or pruned logs");
  const maxIdx = idx - 1;
  const siblings = authPath(record.index, record.leftSnapshot, rightLeaves, maxIdx);
  // Self-check: the reconstructed path must reproduce the live root.
  let node = commit;
  for (let lv = 0; lv < 128; lv++) {
    const s = BigInt(siblings[lv]);
    node = bit(record.index, lv) ? (s === 0n ? node : poseidon2([s, node])) : (s === 0n ? node : poseidon2([node, s]));
  }
  const onchainRoot = (await poolR.currentRoot()) as bigint;
  if (node !== onchainRoot) throw new Error("reconstructed root != currentRoot (incomplete event scan?)");
  return { siblings, root: onchainRoot.toString() };
}

// ── withdrawal proof ─────────────────────────────────────────────────────────
export interface WithdrawalProof {
  pA: [string, string]; pB: [[string, string], [string, string]]; pC: [string, string];
  pubSignals: string[]; recipient: string; root: string;
  change: Note; // remainder note (value = existing − withdrawn); persist if > 0
}

let snarkjsP: Promise<any> | null = null;
const loadSnarkjs = () => (snarkjsP ??= import("snarkjs"));

// The 32.8 MiB proving key is served as chunks (see scripts/shield/split-zkey.mjs)
// because Cloudflare Pages refuses any single asset over 25 MiB. Fetch the parts
// in parallel and hand snarkjs the reassembled bytes — fastfile takes a
// Uint8Array anywhere it takes a URL.
let zkeyP: Promise<Uint8Array> | null = null;
/// The withdraw proving key, reassembled from its published parts. Cached for
/// the page's lifetime; a failed fetch clears the cache so the next proof retries.
export const loadZkey = () => (zkeyP ??= fetchZkey().catch((e) => { zkeyP = null; throw e; }));

interface ZkeyManifest { bytes: number; sha256: string; parts: { name: string; bytes: number }[] }

async function fetchZkey(): Promise<Uint8Array> {
  const get = async (url: string) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res;
  };
  const manifest: ZkeyManifest = await (await get(ZKEY_MANIFEST)).json();
  const parts = await Promise.all(
    manifest.parts.map(async (p) => new Uint8Array(await (await get(`${SHIELD_BASE}${p.name}`)).arrayBuffer()))
  );
  const key = new Uint8Array(manifest.bytes);
  let off = 0;
  for (const part of parts) { key.set(part, off); off += part.length; }
  // A truncated part (flaky network, half-written SW cache entry) would otherwise
  // surface much later as an inexplicably invalid proof.
  if (off !== manifest.bytes) throw new Error(`zkey: got ${off} bytes, expected ${manifest.bytes}`);
  if (crypto?.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", key);
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (hex !== manifest.sha256) throw new Error(`zkey: sha256 ${hex} != ${manifest.sha256}`);
  }
  return key;
}

/// Build a Groth16 withdrawal proof directing `withdrawnValueWei` to `recipient`
/// (the recipient is bound into the proof's context). Produces a change note for
/// the remainder — persist it (via recordChangeNote) to spend later.
export async function buildWithdrawal(
  provider: Provider, poolAddr: string, record: NoteRecord, recipient: string, withdrawnValueWei: bigint
): Promise<WithdrawalProof> {
  if (withdrawnValueWei > BigInt(record.value)) throw new Error("withdraw exceeds note value");
  const { siblings, root } = await reconstructPath(provider, poolAddr, record);
  const change = makeNote(BigInt(record.value) - withdrawnValueWei);
  const input = {
    withdrawnValue: withdrawnValueWei.toString(), treeDepth: "128", context: contextFor(recipient).toString(),
    root, asset: NATIVE.toString(), existingValue: record.value,
    existingNullifier: record.nullifier, existingSecret: record.secret,
    newNullifier: change.nullifier, newSecret: change.secret,
    siblings, leafIndex: record.index.toString(),
  };
  const [snarkjs, zkey] = await Promise.all([loadSnarkjs(), loadZkey()]);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, zkey);
  return {
    pA: [proof.pi_a[0], proof.pi_a[1]],
    pB: [[proof.pi_b[0][1], proof.pi_b[0][0]], [proof.pi_b[1][1], proof.pi_b[1][0]]],
    pC: [proof.pi_c[0], proof.pi_c[1]],
    pubSignals: publicSignals, recipient, root, change,
  };
}

/// After a partial withdrawal mines, the change note is the new rightmost leaf —
/// snapshot ITS left path so it too becomes a spendable NoteRecord.
export async function recordChangeNote(
  provider: Provider, poolAddr: string, change: Note, atBlock: number
): Promise<NoteRecord> {
  const poolR = new Contract(poolAddr, KS_POOL_ABI, provider);
  const index = Number(await poolR.treeSize()) - 1; // change note is the last leaf
  const leftSnapshot: Record<number, string> = {};
  for (let lv = 0; lv < 128; lv++) if (bit(index, lv)) leftSnapshot[lv] = (await poolR.sideNodes(lv)).toString();
  return { ...change, index, leftSnapshot, depositBlock: atBlock };
}
