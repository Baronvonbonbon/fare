# Live e2e — ZK-authorized shielded payouts on Paseo (privacy phase 3)

Run date: 2026-07-25. Script: `scripts/privacy/live-zk.mjs`.
Design: [PRIVACY-TIERS.md](PRIVACY-TIERS.md) §7. Circuit: `circuits/shieldnote.circom`.

**Verdict: it works end to end on the live pool, and it dissolves the constraint
that shaped phases 1 and 2.** The two residual risks are closed — the anonymity
set is no longer a batch, and no keeper can substitute a commitment — and the
per-transaction deposit ceiling that capped batching at 2 stops mattering,
because a ZK spend is one deposit by construction.

Deployed standalone (`FareVault` `0xf55034371B82d246DA99CD741A5feCCB8b45EDBE`,
`FareShieldVerifier` `0x09cbBCA441F2171aAB64De0A6ee2eD56fBE89086`). The demo
deployment was not touched.

---

## 1. What only the real chain could answer

The local suite proves the cryptography against a mocked pool and a Solidity
Poseidon. Three things needed Paseo itself, all of the same class of surprise
that capped phase 1 at 2-anonymity:

| Question | Result |
|---|---|
| Does Paseo's PoseidonT3 precompile agree with `poseidon-lite`? | **Yes** — `hash(1,2)` identical. Had it differed, no proof could ever verify and every note would be stranded. |
| Does a note insert fit? (16 precompile calls) | **Yes** — 45,357 gas for the first insert, 37,418 thereafter. |
| Does a spend fit? (Groth16 pairing **and** a pool deposit in one transaction) | **Yes** — **26,985 gas**. |

Tree agreement was checked after *every* insert, not just at the end: on-chain
`noteRoot()` equalled the client's reconstruction each time.

## 2. The run

| | |
|---|---|
| Notes inserted | 4 (anonymity set = 4 here; in production, every unspent note **of the same bucket** — the spend reveals the denomination) |
| Spent | leaf **1** — deliberately not the first, to exercise a real path |
| Spend | `0xe1a721b7…` — proof + pool deposit, one transaction |
| Pool tree | 271 → **272** |
| Withdrawal | `0x4a6145bb…` → fresh `0x0B50a1aa…`, **1.0 PAS** |

The final withdrawal matters as much as the spend: it proves the note the vault
deposited *on the payee's behalf, authorized only by a proof* is a normal
spendable Kusama Shield note. Balance → note → ZK spend → pool → fresh address,
with no step naming the payee alongside their commitment.

## 3. Why the Paseo ceiling stops applying

[E2E-PRIVACY-LIVE.md](E2E-PRIVACY-LIVE.md) §2 found that Paseo rejects more than
**two** pool deposits per transaction — a proof-size bound EVM gas does not
express. Because phase 1 consumed tickets and deposited in the same transaction,
that ceiling *was* the anonymity set.

Phase 2 split them so the ceiling only decided how many deposit transactions
followed. Phase 3 removes the question entirely: **each spend is its own
transaction with exactly one deposit**, and its anonymity comes from the note
tree, not from how many deposits share a transaction. Nothing in the design
batches, so nothing is capped.

At 26,985 gas a spend is *cheaper* than the phase-1 two-deposit batch (39,612),
while providing an anonymity set bounded by the tree (65,536 notes) rather than
by a batch.

## 4. What this closes

- **Keeper custody.** Phases 1 and 2 could only bound it: an authorized keeper
  held the account↔commitment pairing and could deposit its own commitments
  instead. `ksCommitment` is now a public input, so the deposit target is baked
  into the proof. `depositShieldNoteZK` is therefore **permissionless** — anyone
  may pay the gas, nobody can redirect it, and there is no keeper role left to
  trust. Verified negatively in the suite: altering `ksCommitment` fails
  `bad-proof`.
- **The seal-size anonymity bound.** A seal named its accounts. A spend names
  only a nullifier — not the leaf, not the index, not the account — so the set is
  every unspent note of the same bucket (the denomination is public in a spend).

## 5. Not covered

- **The trusted setup is single-party**, exactly as `scripts/setup-zk.mjs` warns
  for the proximity circuit. Mainnet needs a real ceremony with a published
  transcript before `setVerifyingKey`, which is lock-once.
- **Anonymity is only as large as the tree is used.** Four notes is a set of
  four. The mechanism is right; the privacy is whatever adoption provides.
- The relay's `/shield-note` and `/shield-note-spend` endpoints were not
  exercised — the script drives the vault directly. The HTTP layer is unit-tested
  only.
- No PWA path yet: `web/src/shieldnote.ts` provides proving and the tree, but
  nothing in the app calls it.
- Partial spends (change notes) are not implemented; a note is spent whole.
- Depth 16 caps the tree at 65,536 notes. Beyond that the vault needs a new tree
  or a deeper circuit.

## See also

- [PRIVACY-TIERS.md](PRIVACY-TIERS.md) — design and threat model
- [E2E-PRIVACY-LIVE.md](E2E-PRIVACY-LIVE.md) — phases 1–2 live, and the ceiling
  that motivated this
