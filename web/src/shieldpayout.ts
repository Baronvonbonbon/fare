// Shielded PAYOUTS — the driver/venue side of privacy phase 1.
// Design: docs/PRIVACY-TIERS.md §4. Contract: FareVault. Keeper:
// venue-node/shieldkeeper.mjs.
//
// Earnings land in FareVault at a persistent address, so every withdrawal
// publishes a line in that party's revenue graph. This module moves earnings
// into the shielded pool WITHOUT ever putting the account and the note's
// commitment in the same transaction:
//
//   queue()  — the note is generated HERE, kept here, and only its commitment is
//              handed to the keeper over the relay body. The transaction the
//              relay submits carries the account and a bucket, nothing else.
//   claim()  — after the keeper's batch mines, replay the batch locally to learn
//              where the note landed. The keeper only ever supplies public chain
//              state; the nullifier and secret never leave the device.
//
// Once claimed, the note is an ordinary spendable note in the same store the
// customer-side shielded funding uses — a driver can fund a burner with their
// earnings and the two are indistinguishable in the pool.
import { Contract, type Signer } from "ethers";
import { ADDRESSES, CHAIN_ID, readProvider } from "./chain";
import { VAULT_ABI } from "./abi";
import { makeNote, commitmentOf, type Note, type NoteRecord, batchNotePaths } from "./shieldpool";
import { adoptShieldedNote } from "./shield";

const PENDING_KEY = "fare.shield.payouts"; // notes queued but not yet deposited (SECRETS)

/// A note whose value is committed to the vault queue but not yet in the pool.
/// Persisted before the request goes out: losing this loses the earnings, since
/// the ticket is spent on-chain and only this device knows the note.
interface PendingPayout extends Note {
  commitment: string; // 0x-prefixed 32-byte, as handed to the keeper
  bucketWei: string;
  queuedAt: number;
}

const loadPending = (): PendingPayout[] => {
  try { return JSON.parse(localStorage.getItem(PENDING_KEY) || "[]"); } catch { return []; }
};
const savePending = (p: PendingPayout[]) => localStorage.setItem(PENDING_KEY, JSON.stringify(p));

const b32 = (x: bigint): string => "0x" + x.toString(16).padStart(64, "0");

const SHIELD_CREDIT_TYPES = {
  ShieldCredit: [
    { name: "account", type: "address" },
    { name: "bucket", type: "uint96" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

/// Denominations the vault accepts. Fixed sizes are what make a batch worth
/// anything — variable amounts would re-identify each entry inside it.
export async function shieldBuckets(): Promise<bigint[]> {
  const vault = new Contract(ADDRESSES.vault, VAULT_ABI, readProvider as any);
  const n = Number(await vault.shieldBucketCount());
  const out: bigint[] = [];
  for (let i = 0; i < n; i++) out.push(await vault.shieldBuckets(i));
  return out;
}

/// The largest combination of buckets `balanceWei` covers, biggest first. The
/// remainder stays an ordinary balance — shielding it would need a denomination
/// nobody else is using, which is a fingerprint, not privacy.
export function planShielding(balanceWei: bigint, buckets: bigint[]): bigint[] {
  const plan: bigint[] = [];
  let left = balanceWei;
  for (const b of [...buckets].sort((x, y) => (x > y ? -1 : 1))) {
    while (left >= b) { plan.push(b); left -= b; }
  }
  return plan;
}

/// Queue one bucket of vault earnings for shielding. Returns the commitment the
/// keeper will deposit — poll `claimShieldedPayouts` afterwards to make the note
/// spendable.
export async function queueShieldedPayout(
  signer: Signer, relayUrl: string, bucketWei: bigint
): Promise<{ commitment: string; txHash: string }> {
  const account = await signer.getAddress();
  const vault = new Contract(ADDRESSES.vault, VAULT_ABI, readProvider as any);

  const note = makeNote(bucketWei);
  const commitment = b32(commitmentOf(note));

  // Persist BEFORE the request. If the queue transaction lands and this device
  // has forgotten the note, the earnings are gone: the ticket is spent and only
  // the (nullifier, secret) pair here can ever spend the resulting note.
  savePending([...loadPending(), { ...note, commitment, bucketWei: bucketWei.toString(), queuedAt: Date.now() }]);

  const nonce: bigint = await vault.shieldNonce(account);
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const signature = await signer.signTypedData(
    { name: "FareVault", version: "1", chainId: CHAIN_ID, verifyingContract: ADDRESSES.vault },
    SHIELD_CREDIT_TYPES,
    { account, bucket: bucketWei, nonce, deadline }
  );

  const res = await fetch(`${relayUrl}/shield-queue`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ account, bucket: bucketWei.toString(), deadline, signature, commitment }),
  });
  const j = await res.json();
  if (!res.ok || !j.txHash) {
    // The authorization was never consumed, so drop the note rather than leave a
    // phantom pending entry that will never resolve.
    savePending(loadPending().filter((p) => p.commitment !== commitment));
    throw new Error(`shield-queue failed: ${JSON.stringify(j)}`);
  }
  return { commitment, txHash: j.txHash };
}

/// Turn deposited payouts into spendable notes. Safe to call repeatedly (on app
/// start, after a queue, on a timer) — entries the keeper hasn't batched yet are
/// simply left pending.
export async function claimShieldedPayouts(relayUrl: string): Promise<number> {
  const pending = loadPending();
  if (pending.length === 0) return 0;
  let claimed = 0;
  const remaining: PendingPayout[] = [];

  for (const p of pending) {
    let receipt: any;
    try {
      const res = await fetch(`${relayUrl}/shield-claim?commitment=${p.commitment}`);
      receipt = await res.json();
      if (!res.ok || !receipt.deposited) { remaining.push(p); continue; }
    } catch { remaining.push(p); continue; } // relay down — try again later

    // Replay the batch from the keeper's pre-batch snapshot. `commitments` is
    // every leaf inserted from `startIndex` on, which can lead with leaves that
    // are not ours, so find our own position rather than assuming index 0.
    const leaves: bigint[] = receipt.commitments.map((c: string) => BigInt(c));
    const mine = receipt.commitments.findIndex(
      (c: string) => c.toLowerCase() === p.commitment.toLowerCase()
    );
    if (mine < 0) { remaining.push(p); continue; } // keeper's receipt doesn't contain us

    const paths = batchNotePaths(Number(receipt.startIndex), receipt.preSideNodes, leaves);
    const { index, leftSnapshot } = paths[mine];
    const record: NoteRecord = {
      nullifier: p.nullifier, secret: p.secret, value: p.value,
      index, leftSnapshot, depositBlock: Number(receipt.blockNumber),
    };
    adoptShieldedNote(record);
    claimed++;
  }

  savePending(remaining);
  return claimed;
}

/// Payouts queued on this device that the keeper has not deposited yet.
export function pendingShieldedPayouts(): { commitment: string; bucketWei: string; queuedAt: number }[] {
  return loadPending().map(({ commitment, bucketWei, queuedAt }) => ({ commitment, bucketWei, queuedAt }));
}
