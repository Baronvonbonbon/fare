# Live e2e — batched shielded payouts on Paseo (privacy phase 1)

Run date: 2026-07-25. Script: `scripts/privacy/live-e2e.mjs`.
Design: [PRIVACY-TIERS.md](PRIVACY-TIERS.md) §4.

**Verdict: the design works on the live pool — and Paseo caps a batch at 2
deposits per transaction, which caps the per-batch anonymity set at 2.** The
mechanism is sound; the anonymity it delivers on *this* chain is much weaker than
the `minBatch = 8` default implies. That is the finding.

Deployed a **standalone** `FareVault` (`0x2dFc1730fc233F0A45FCC1490f65bA102FC10306`).
The demo deployment was not touched — no migration, no re-pointing.

---

## 1. What the local e2e could not answer

`test/privacy-e2e.test.ts` mocks the pool. Two questions needed the real one:

1. **Does the Kusama Shield pool accept a deposit made by a CONTRACT?** Every
   prior deposit came from an EOA. If it refused, the batching design is dead.
2. **Can a batched note actually be spent?** The recipient never deposited it and
   never snapshotted the tree — their path is derived after the fact from the
   keeper's pre-batch snapshot. A wrong path proves nothing.

Both answered **yes**:

| | |
|---|---|
| Pool tree | 257 → **261** (4 contract-originated deposits accepted) |
| Batches | 2 × 2 deposits — `0x90067a97…`, `0xa71ef3d3…` |
| Derived leaf index | **258**, from the keeper's snapshot alone |
| Withdrawal | `0x8be8c112…` → fresh `0x1FbAD727…`, **1.0 PAS received** |

The withdrawal is the load-bearing result: a Groth16 proof built from a
client-derived path verified against the live pool's root. The note was deposited
by a contract on the payee's behalf, and the payee still spent it.

## 2. The finding: 2 deposits per transaction, and what it costs

`executeShieldBatch` with 8 commitments reverts. So does 3. Two succeeds.

This is **not gas**: a 2-deposit batch estimates **39,612 gas**, and raising the
limit to 500 M changes nothing. The revert carries no reason data. That is the
signature of a **proof-size (PoV) bound** — a parachain resource EVM gas does not
express, so `eth_estimateGas` cannot warn you and the failure looks like a bare
`require(false)`.

The privacy consequence is the important part, and it is worse than a throughput
problem. **The contract consumes tickets FIFO, and ticket owners are public.** An
observer reads `shieldScanned` before and after a batch, learns exactly which
tickets it consumed, and therefore which accounts the batch's commitments belong
to. So:

> **the per-transaction batch size *is* the anonymity set.**

At the ceiling of 2, a batched payout is 2-anonymous. Splitting one logical batch
across several transactions does not help — each transaction's consumed range is
independently derivable.

### The fix (phase 2)

Stop publishing the ticket→owner alignment. Store `keccak256(owner, salt)` on the
ticket and drop the owner from the queue event; the owner reveals the preimage
only when reclaiming a stalled ticket, which is the one case where linking costs
nothing (no deposit was made against it). Batches then consume positions nobody
can attribute, and the anonymity set becomes **all live tickets in the queue**
rather than the few that fit in one transaction.

This supersedes the reasoning in `FareVault`'s ticket comment, which argued that
storing the owner "leaks nothing the T1 event doesn't already". True in
isolation, wrong in combination: it is FIFO consumption *plus* public owners that
creates the alignment.

## 3. Also learned

- **`"Leaf too large"`** — the pool rejects any commitment ≥ the BN254 scalar
  field. Real Poseidon commitments always pass; a keccak-derived test value
  usually does not. Worth knowing before debugging the wrong thing.
- **Keeper clock vs chain clock.** `dwellReady` compared the on-chain `queuedAt`
  against the keeper's wall clock while the contract compares against
  `block.timestamp`. A keeper whose clock trails the chain sits on a ready queue
  forever, looking like "the keeper just isn't batching". Found by the local e2e,
  fixed before this run.
- **Queue-transaction invariant held on-chain**: every `queueShieldCreditFor`
  receipt was checked for the commitment in calldata and logs. None leaked.

## 4. What this run cost, including a mistake

The first attempt kept payee keys and note secrets **in memory only**. The batch
reverted (the ceiling above), the process exited, and 8 PAS is now stranded in
the first standalone vault (`0x6f27aF98…`): the tickets are queued, the notes are
unrecoverable, and the vault has no admin drain **by design** — `reclaimShieldTicket`
requires the ticket's owner, whose key is gone.

Testnet funds, and the deployer holds ~12.4 k PAS, so the cost is nil. The lesson
is not: `live-e2e.mjs` now writes `artifacts/privacy-live/notes.json` **before**
any transaction can spend a ticket against a commitment. On mainnet that ordering
is the difference between a recoverable retry and destroyed earnings.

## 5. Not covered

- Only `withdrawnValue == bucket` (full spend). Partial spends re-insert a change
  note whose path the payee must track — untested here.
- One payee spent; the other three notes remain unspent in the pool.
- The relay's `/shield-queue` and `/shield-claim` endpoints were not exercised —
  the script calls the vault and keeper module directly. The HTTP layer between
  them is still only unit-tested.
- No concurrent keeper, and no foreign deposit landed mid-run, so the log-derived
  index recovery ran only on its happy path here (the race is covered locally).

## See also

- [PRIVACY-TIERS.md](PRIVACY-TIERS.md) — the design and threat model
- [KUSAMA-SHIELD-FINDINGS.md](KUSAMA-SHIELD-FINDINGS.md) — pool constraints (Issues 1–4)
