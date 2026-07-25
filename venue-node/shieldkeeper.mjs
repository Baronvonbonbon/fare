// Shielded-payout keeper (docs/PRIVACY-TIERS.md §4).
//
// The vault splits a shielded payout into two transactions so no single one ever
// carries both an account and a pool commitment:
//
//   T1  queueShieldCreditFor  — the relay submits the driver's EIP-712
//       authorization. On-chain: (account, bucket, ticket#). The commitment is
//       handed to this keeper OFF-CHAIN and must never reach that calldata.
//   T2  executeShieldBatch    — this keeper deposits N >= minBatch commitments in
//       one transaction. On-chain: N commitments, no account.
//
// So the keeper is the only party holding the pairing. That is a real trust
// concession, stated plainly in §4: an authorized keeper can substitute its own
// commitments and keep the notes. Governance gates who may execute; phase 3's ZK
// authorization is what removes the concession.
//
// The pending set is PERSISTED. A keeper that forgets a commitment after its
// ticket is consumed has destroyed a payout — the ticket is spent, no note
// exists, and the vault has no record of who was owed what.

import { randomInt } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";

// ── pure planning ────────────────────────────────────────────────────────────

/// Unbiased Fisher-Yates over a crypto RNG. Queue order must not survive into
/// the batch: the contract consumes tickets FIFO, so an unshuffled batch would
/// line commitments up against ticket ages and hand the correlation back.
export function shuffle(items) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/// Decide whether a bucket can be batched now.
///   held  — commitments this keeper is holding for the bucket
///   live  — tickets queued on-chain and not yet deposited or reclaimed
/// Returns the commitments to submit, or null to wait.
///
/// `live` can be lower than `held` when another keeper batched first, and higher
/// when drivers queued through a different relay — so the batch size is the
/// smaller of the two, and it must still clear minBatch on its own.
export function planBatch({ held, live, minBatch }) {
  const n = Math.min(held.length, live);
  if (n < minBatch) return null;
  return shuffle(held).slice(0, n);
}

/// Per-commitment tree positions for a mined batch. The keeper publishes only
/// public chain state (the pre-batch sideNodes and the ordered commitments);
/// recipients replay the insertions locally to get their own left path, so no
/// note secret ever reaches the keeper. See shieldpool.ts `batchNotePaths`.
/// `commitments` is the REPLAY list: every leaf inserted from `startIndex`
/// onward, which may lead with leaves that are not ours (see runOnce). A
/// recipient simply looks up its own commitment in the list, so it never needs
/// to know which entries were the keeper's. `mine` records the batch proper for
/// operators reading the store.
export function batchReceipt({ bucket, txHash, blockNumber, startIndex, preSideNodes, commitments, mine }) {
  return { bucket: String(bucket), txHash, blockNumber, startIndex, preSideNodes, commitments, mine: mine ?? commitments };
}

// ── persistence ──────────────────────────────────────────────────────────────

/// Pending commitments + mined batch receipts, written through to disk on every
/// mutation. Small by construction (a batch clears it), so rewriting the whole
/// file is cheaper than being clever about it.
export function createStore(file) {
  let state = { pending: [], receipts: [] };
  if (file && existsSync(file)) {
    try { state = JSON.parse(readFileSync(file, "utf8")); }
    catch { /* corrupt file: start clean rather than refuse to run */ }
  }
  const flush = () => {
    if (!file) return;
    // Write-then-rename so a crash mid-write can't truncate the pending set.
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, file);
  };

  return {
    /// Record a commitment awaiting deposit. Idempotent per commitment so a
    /// client retry can't consume two tickets for one note.
    addPending(bucket, commitment) {
      const b = String(bucket);
      if (state.pending.some((p) => p.commitment === commitment)) return false;
      state.pending.push({ bucket: b, commitment, queuedAt: Date.now() });
      flush();
      return true;
    },
    /// Forget a commitment whose queue transaction never landed — no ticket was
    /// spent, so holding it would leave the keeper owing a note it can't fill.
    dropPending(commitment) {
      const before = state.pending.length;
      state.pending = state.pending.filter((p) => p.commitment !== commitment);
      if (state.pending.length !== before) flush();
      return state.pending.length !== before;
    },
    heldFor(bucket) {
      const b = String(bucket);
      return state.pending.filter((p) => p.bucket === b).map((p) => p.commitment);
    },
    buckets() {
      return [...new Set(state.pending.map((p) => p.bucket))];
    },
    /// Clear the commitments a batch consumed and record where they landed.
    settle(receipt) {
      const done = new Set(receipt.commitments);
      state.pending = state.pending.filter((p) => !done.has(p.commitment));
      state.receipts.push(receipt);
      flush();
    },
    /// The batch a commitment landed in — what a recipient polls for.
    receiptFor(commitment) {
      return state.receipts.find((r) => r.commitments.includes(commitment)) ?? null;
    },
    isPending(commitment) {
      return state.pending.some((p) => p.commitment === commitment);
    },
    stats() {
      return { pending: state.pending.length, batches: state.receipts.length };
    },
  };
}

// ── chain interaction ────────────────────────────────────────────────────────

/// Read the tree state a recipient needs to reconstruct paths for this batch.
/// Must be taken BEFORE the batch: inside one transaction the later inserts
/// overwrite the levels the earlier leaves depended on, so there is no
/// after-the-fact read that works.
export async function snapshotTree(pool, provider) {
  const snapBlock = await provider.getBlockNumber();
  const startIndex = Number(await pool.treeSize());
  const preSideNodes = {};
  for (let lv = 0; lv < 128; lv++) preSideNodes[lv] = (await pool.sideNodes(lv)).toString();
  return { snapBlock, startIndex, preSideNodes };
}

/// Insert-event leaves in log order over a block range. The tree is fed by BOTH
/// Deposit and NewCommitment (withdrawal change notes); scanning only Deposit
/// misses ~20% of leaves — KUSAMA-SHIELD-FINDINGS §2.
async function insertsBetween(pool, provider, fromBlock, toBlock) {
  const addr = String(pool.target ?? pool.address).toLowerCase();
  const logs = [];
  for (const name of ["Deposit", "NewCommitment"]) {
    logs.push(...(await provider.getLogs({
      address: addr, topics: [pool.interface.getEvent(name).topicHash], fromBlock, toBlock,
    })));
  }
  logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
  return logs;
}

/// Has the oldest unconsumed ticket aged past the contract's dwell? Checking
/// first turns a guaranteed revert into a no-op — the contract enforces this
/// regardless, so the keeper only saves itself the gas.
export async function dwellReady(vault, bucket, now = Math.floor(Date.now() / 1000)) {
  const cursor = await vault.shieldScanned(bucket);
  const ticket = await vault.shieldTicket(bucket, cursor);
  if (ticket.owner === "0x0000000000000000000000000000000000000000") return false;
  const dwell = Number(await vault.shieldMinDwell());
  return Number(ticket.queuedAt) + dwell <= now;
}

/// One keeper pass over every bucket that has commitments waiting.
/// `submit` runs the transaction (the relay passes its nonce-serializing wrapper).
export async function runOnce({ vault, pool, provider, store, submit, log = () => {} }) {
  const minBatch = Number(await vault.shieldMinBatch());
  const executed = [];

  for (const bucket of store.buckets()) {
    const held = store.heldFor(bucket);
    const live = Number(await vault.shieldPending(bucket));
    const batch = planBatch({ held, live, minBatch });
    if (!batch) continue;
    if (!(await dwellReady(vault, bucket))) {
      log(`shield-keeper: bucket ${bucket} has ${batch.length} ready but the oldest ticket is still dwelling`);
      continue;
    }

    // Snapshot BEFORE submitting — inside the batch transaction the later
    // inserts overwrite the levels the earlier leaves needed, so there is no
    // after-the-fact read that reconstructs this.
    const { snapBlock, startIndex, preSideNodes } = await snapshotTree(pool, provider);
    const tx = await submit((overrides = {}) => vault.executeShieldBatch(bucket, batch, overrides));
    const rec = await tx.wait();

    // Anyone may deposit between the snapshot and inclusion, which shifts both
    // the indices and the tree state the snapshot describes. Recover by
    // replaying: find where we actually landed, then prepend whatever leaves
    // slipped in ahead of us so the recipients' replay starts from a state the
    // snapshot really does describe.
    const landed = await resolveStartIndex({ pool, provider, receipt: rec, batch });
    if (landed == null) {
      log(`shield-keeper: batch ${tx.hash} mined but its deposits were not found in the receipt`);
      continue;
    }
    const jumped = landed - startIndex;
    let replay = batch;
    if (jumped > 0) {
      const before = await insertsBetween(pool, provider, snapBlock, rec.blockNumber);
      const ourFirst = Math.min(...rec.logs.filter((l) => l.transactionHash === tx.hash).map((l) => l.index));
      const preceding = before
        .filter((l) => l.blockNumber < rec.blockNumber || l.index < ourFirst)
        .slice(-jumped)
        .map((l) => BigInt(l.data.slice(0, 66)).toString());
      if (preceding.length !== jumped) {
        // Can't describe the gap → a derived path would be silently wrong.
        // Leave the commitments pending: the tickets are spent either way, but a
        // flagged failure is recoverable and a bad note is not.
        log(`shield-keeper: batch ${tx.hash} landed at ${landed}, expected ${startIndex}, and the ${jumped}-leaf gap could not be reconstructed — MANUAL RECOVERY NEEDED`);
        continue;
      }
      replay = [...preceding, ...batch];
    }

    store.settle(batchReceipt({
      bucket, txHash: tx.hash, blockNumber: rec.blockNumber,
      startIndex, preSideNodes, commitments: replay, mine: batch,
    }));
    executed.push({ bucket, count: batch.length, txHash: tx.hash });
    log(`shield-keeper: deposited ${batch.length} × ${bucket} at leaf ${landed} (${tx.hash})`);
  }
  return executed;
}

/// Where the batch's first leaf actually landed.
///
/// The pre-batch `treeSize` read is only a prediction — anyone can deposit
/// between the read and inclusion, which shifts every index. An off-by-one here
/// yields notes that look fine and prove nothing, so derive the true position
/// from logs instead of trusting the prediction:
///
///   start = treeSize now
///         − inserts from our block onward   (rewind to the start of our block)
///         + inserts in our block before us  (fast-forward to our own position)
///
/// The tree is fed by BOTH Deposit and NewCommitment (withdrawal change notes) —
/// counting only Deposit misses ~20% of leaves, per KUSAMA-SHIELD-FINDINGS §2.
async function resolveStartIndex({ pool, provider, receipt, batch }) {
  const addr = String(pool.target ?? pool.address).toLowerCase();
  const topics = ["Deposit", "NewCommitment"].map((n) => pool.interface.getEvent(n).topicHash);

  const ours = receipt.logs.filter((l) => l.address.toLowerCase() === addr && topics.includes(l.topics[0]));
  if (ours.length !== batch.length) return null; // not our batch's shape — refuse to guess
  const firstLogIndex = Math.min(...ours.map((l) => l.index));

  const since = [];
  for (const topic of topics) {
    since.push(...(await provider.getLogs({
      address: addr, topics: [topic], fromBlock: receipt.blockNumber, toBlock: "latest",
    })));
  }
  const insertsSinceOurBlock = since.length;
  const insertsBeforeUs = since.filter(
    (l) => l.blockNumber === receipt.blockNumber && l.index < firstLogIndex
  ).length;

  const start = Number(await pool.treeSize()) - insertsSinceOurBlock + insertsBeforeUs;
  return start >= 0 ? start : null;
}
