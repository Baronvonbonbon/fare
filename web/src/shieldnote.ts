// Shield notes — the client half of privacy phase 3 (docs/PRIVACY-TIERS.md §7).
// Circuit: circuits/shieldnote.circom. Contract: FareVault's note pool.
//
// Phase 1 and 2 left two things unsolved: a seal still named its accounts, so
// the anonymity set was the seal size; and the keeper held the
// account↔commitment pairing, so it could substitute its own commitments.
//
// A note closes both. Converting balance into a note is linked — like any pool
// deposit — but SPENDING it reveals only a nullifier, so the anonymity set is
// every unspent note in the tree. And because the proof binds the shielded-pool
// commitment, the spend is permissionless: anyone can pay the gas, nobody can
// redirect the deposit.
//
// Secrets never leave the device. The relay sees a commitment on the way in and
// a proof on the way out, and can link neither to the other.
import { Contract, ZeroAddress, toBeHex, toBigInt, randomBytes, type Provider, type Signer } from "ethers";
import { poseidon1, poseidon2 } from "poseidon-lite";
import { ADDRESSES, CHAIN_ID, readProvider } from "./chain";
import { VAULT_ABI } from "./abi";
import { postPadded } from "./relaypick";

const BN254_R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const NOTE_DEPTH = 16; // must match the circuit and FareVault.NOTE_DEPTH

const WASM = "/shield/shieldnote.wasm";
const ZKEY = "/shield/shieldnote.zkey";
const PENDING_KEY = "fare.shield.notes.zk"; // unspent notes (SECRETS)

export interface ShieldNote {
  nullifier: string; // decimal field element
  secret: string;
  bucketWei: string;
  commitment: string; // decimal, as stored in the tree
  createdAt: number;
  /// Which relay submitted the INSERT. The spend deliberately avoids it: that
  /// relay already knows the account, and letting it see the proof too would
  /// hand it the pairing (relaypick.ts).
  insertedVia?: string;
}

const randField = (): bigint => toBigInt(randomBytes(31)) % BN254_R;

/// leaf = Poseidon(Poseidon(nullifier, secret), bucket) — the denomination is
/// bound in, so a 1 PAS note cannot be spent as 25.
export const noteCommitment = (nullifier: bigint, secret: bigint, bucket: bigint): bigint =>
  poseidon2([poseidon2([nullifier, secret]), bucket]);
export const nullifierHashOf = (nullifier: bigint): bigint => poseidon1([nullifier]);

export function makeShieldNote(bucketWei: bigint): ShieldNote {
  const nullifier = randField();
  const secret = randField();
  return {
    nullifier: nullifier.toString(),
    secret: secret.toString(),
    bucketWei: bucketWei.toString(),
    commitment: noteCommitment(nullifier, secret, bucketWei).toString(),
    createdAt: Date.now(),
  };
}

// ── device-local note store ──────────────────────────────────────────────────
const load = (): ShieldNote[] => {
  try { return JSON.parse(localStorage.getItem(PENDING_KEY) || "[]"); } catch { return []; }
};
const save = (n: ShieldNote[]) => localStorage.setItem(PENDING_KEY, JSON.stringify(n));
export const pendingShieldNotes = (): ShieldNote[] => load();
export const rememberShieldNote = (n: ShieldNote) => save([...load(), n]);
export const forgetShieldNote = (commitment: string) =>
  save(load().filter((n) => n.commitment !== commitment));

// ── the tree, rebuilt from chain events ──────────────────────────────────────

/// Empty-subtree roots. These must match `FareVault.noteZeros` exactly, or every
/// path built here proves against a root the vault has never held.
export const zeroHashes = (depth = NOTE_DEPTH): bigint[] => {
  const z = [0n];
  for (let i = 1; i <= depth; i++) z.push(poseidon2([z[i - 1], z[i - 1]]));
  return z;
};

/// A sparse mirror of the vault's incremental tree. Empty subtrees short-circuit
/// to a precomputed zero, so building a root is O(leaves), not O(2^depth).
export class NoteTree {
  private memo = new Map<string, bigint>();
  private zeros = zeroHashes();
  constructor(public leaves: bigint[] = []) {}

  private node(level: number, index: number): bigint {
    if (index * 2 ** level >= this.leaves.length) return this.zeros[level];
    if (level === 0) return this.leaves[index];
    const key = `${level}:${index}`;
    const hit = this.memo.get(key);
    if (hit !== undefined) return hit;
    const v = poseidon2([this.node(level - 1, index * 2), this.node(level - 1, index * 2 + 1)]);
    this.memo.set(key, v);
    return v;
  }

  root(): bigint {
    return this.node(NOTE_DEPTH, 0);
  }

  /// Authentication path for a leaf: siblings bottom-up, plus the left/right bit
  /// at each level.
  path(index: number): { elements: bigint[]; indices: number[] } {
    const elements: bigint[] = [];
    const indices: number[] = [];
    let idx = index;
    for (let lv = 0; lv < NOTE_DEPTH; lv++) {
      elements.push(this.node(lv, idx % 2 === 0 ? idx + 1 : idx - 1));
      indices.push(idx % 2);
      idx = Math.floor(idx / 2);
    }
    return { elements, indices };
  }
}

/// Every note leaf the vault holds, in insertion order, from its own events.
/// The leaves are public — only which one is yours is not.
export async function fetchNoteLeaves(provider: Provider = readProvider as any): Promise<bigint[]> {
  const vault = new Contract(ADDRESSES.vault, VAULT_ABI, provider as any);
  const logs = await vault.queryFilter(vault.filters.ShieldNoteInserted(), 0, "latest");
  return logs
    .map((l: any) => ({ index: Number(l.args.index), commitment: toBigInt(l.args.commitment) }))
    .sort((a, b) => a.index - b.index)
    .map((x) => x.commitment);
}

// ── proving ─────────────────────────────────────────────────────────────────
let snarkjsP: Promise<any> | null = null;
const loadSnarkjs = () => (snarkjsP ??= import("snarkjs"));

export interface SpendProof {
  proof: string; // ABI-encoded (uint256[2], uint256[4], uint256[2])
  root: string;
  nullifierHash: string;
  bucketWei: string;
  ksCommitment: string; // 0x-padded 32 bytes
}

/// Prove ownership of `note` and bind the deposit to `ksCommitment`.
///
/// `ksCommitment` is the Kusama Shield commitment the resulting deposit funds —
/// generate it from a fresh KS note you keep locally, because that note is what
/// you will actually spend out of the pool later.
export async function proveSpend(
  note: ShieldNote, leaves: bigint[], ksCommitment: bigint
): Promise<SpendProof> {
  const commitment = BigInt(note.commitment);
  const index = leaves.findIndex((l) => l === commitment);
  if (index < 0) throw new Error("note not found on-chain — has it been inserted yet?");

  const tree = new NoteTree(leaves);
  const { elements, indices } = tree.path(index);
  const snarkjs = await loadSnarkjs();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    {
      root: tree.root().toString(),
      nullifierHash: nullifierHashOf(BigInt(note.nullifier)).toString(),
      bucket: note.bucketWei,
      ksCommitment: ksCommitment.toString(),
      nullifier: note.nullifier,
      secret: note.secret,
      pathElements: elements.map(String),
      pathIndices: indices,
    },
    WASM,
    ZKEY
  );

  const { AbiCoder } = await import("ethers");
  const encoded = AbiCoder.defaultAbiCoder().encode(
    ["uint256[2]", "uint256[4]", "uint256[2]"],
    [
      [proof.pi_a[0], proof.pi_a[1]],
      // EIP-197 order, as FareShieldVerifier expects.
      [proof.pi_b[0][1], proof.pi_b[0][0], proof.pi_b[1][1], proof.pi_b[1][0]],
      [proof.pi_c[0], proof.pi_c[1]],
    ]
  );
  return {
    proof: encoded,
    root: publicSignals[0],
    nullifierHash: publicSignals[1],
    bucketWei: note.bucketWei,
    ksCommitment: toBeHex(ksCommitment, 32),
  };
}

/// Is the ZK path wired on-chain? Both the verifier and the Poseidon hasher must
/// be set; without either, callers fall back to the ticket path.
export async function zkShieldAvailable(provider: Provider = readProvider as any): Promise<boolean> {
  try {
    const vault = new Contract(ADDRESSES.vault, VAULT_ABI, provider as any);
    const [verifier, poseidon] = await Promise.all([vault.shieldVerifier(), vault.shieldPoseidon()]);
    return verifier !== ZeroAddress && poseidon !== ZeroAddress;
  } catch {
    return false; // old vault without the note pool
  }
}

/// EIP-712 payload for a relay-submitted insertion. The signature covers the
/// COMMITMENT, so a relay cannot swap in a note of its own.
export const NOTE_TYPES = {
  ShieldNote: [
    { name: "account", type: "address" },
    { name: "bucket", type: "uint96" },
    { name: "commitment", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

/// Convert `bucketWei` of vault balance into a shielded note. Returns the note —
/// persisted locally first, because the chain holds only its commitment and the
/// secrets exist nowhere else.
export async function insertShieldNote(
  signer: Signer, relayUrl: string, bucketWei: bigint
): Promise<{ note: ShieldNote; txHash: string }> {
  const account = await signer.getAddress();
  const vault = new Contract(ADDRESSES.vault, VAULT_ABI, readProvider as any);
  const note = { ...makeShieldNote(bucketWei), insertedVia: relayUrl };
  rememberShieldNote(note);

  const nonce: bigint = await vault.shieldNonce(account);
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const signature = await signer.signTypedData(
    { name: "FareVault", version: "1", chainId: CHAIN_ID, verifyingContract: ADDRESSES.vault },
    NOTE_TYPES,
    { account, bucket: bucketWei, commitment: BigInt(note.commitment), nonce, deadline }
  );

  const res = await postPadded(`${relayUrl}/shield-note`, {
    account, bucket: bucketWei.toString(), commitment: note.commitment, deadline, signature,
  });
  const j = await res.json();
  if (!res.ok || !j.txHash) {
    forgetShieldNote(note.commitment); // nothing was consumed
    throw new Error(`shield-note insert failed: ${JSON.stringify(j)}`);
  }
  return { note, txHash: j.txHash };
}

/// Spend a note into the shielded pool and adopt the resulting pool note.
///
/// Use a DIFFERENT relay than the insert went through where one is available:
/// the insert names the account, the spend names the commitment, and a relay
/// that sees both learns the pairing the proof exists to hide. The chain cannot
/// link them; the transport can, if you let it.
export async function spendShieldNote(
  note: ShieldNote, relayUrl: string, poolAddr: string, provider: Provider = readProvider as any
): Promise<{ txHash: string; ksNote: any }> {
  const { makeNote, commitmentOf, batchNotePaths } = await import("./shieldpool");
  const { adoptShieldedNote } = await import("./shield");

  const bucket = BigInt(note.bucketWei);
  const ksNote = makeNote(bucket); // the pool note this deposit will fund
  const ksCommitment = commitmentOf(ksNote);

  const leaves = await fetchNoteLeaves(provider);
  const spend = await proveSpend(note, leaves, ksCommitment);

  // Snapshot the pool's tree BEFORE the deposit: inside the transaction the
  // insert overwrites the levels this leaf needs, and there is no after-the-fact
  // read that recovers them (the same constraint phase 1 hit).
  const pool = new Contract(
    poolAddr,
    ["function treeSize() view returns (uint256)", "function sideNodes(uint256) view returns (uint256)"],
    provider as any
  );
  const startIndex = Number(await pool.treeSize());
  const preSideNodes: Record<number, string> = {};
  for (let lv = 0; lv < 128; lv++) preSideNodes[lv] = (await pool.sideNodes(lv)).toString();

  const res = await postPadded(`${relayUrl}/shield-note-spend`, {
    proof: spend.proof, root: spend.root, nullifierHash: spend.nullifierHash,
    bucket: spend.bucketWei, ksCommitment: spend.ksCommitment,
  });
  const j = await res.json();
  // 409 = the note tree moved past our root while we were proving. Recoverable:
  // rebuild against a current root.
  if (res.status === 409) throw new Error("note root went stale — retry the spend");
  if (!res.ok || !j.txHash) throw new Error(`shield-note spend failed: ${JSON.stringify(j)}`);

  // The vault's note is spent; the pool note is what we hold now.
  forgetShieldNote(note.commitment);
  const receipt = await (provider as any).waitForTransaction(j.txHash).catch(() => null);
  const { index, leftSnapshot } = batchNotePaths(startIndex, preSideNodes, [ksCommitment])[0];
  adoptShieldedNote({
    ...ksNote, index, leftSnapshot,
    depositBlock: receipt?.blockNumber ?? (await provider.getBlockNumber()),
  });
  return { txHash: j.txHash, ksNote };
}
