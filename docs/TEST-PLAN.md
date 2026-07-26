# FARE — Test Plan (costs, privacy, security, function)

A gap analysis of the current suite and the tests that would close it. Written
2026-07-26, against the post-migration tree ([PRIVACY-STATUS.md](PRIVACY-STATUS.md)).

The contracts are well tested. This document is mostly about **everything
around them** — the relay, the ops consoles, the client core, and the CI that
would make any of it run.

Legend: ☐ not started · 🟡 partial · 🔒 mainnet gate.

---

## 1. Baseline — what exists

All three tiers pass today.

| Tier | Runner | Tests | Covers |
|---|---|---|---|
| `test/*.ts` | `npx hardhat test` | 179 | contracts, ZK verifiers, invariant fuzz, upgradability, **chain-backed relay endpoints** |
| `web/src/*.test.ts` | `cd web && npx vitest run` | 86 | 11 of 31 client modules |
| `venue-node/*.test.mjs` | `cd venue-node && node --test` | 73 | economics, scorer, swap, treasury, agent, shieldkeeper, **relay HTTP surface** |

**338 tests, all green**, and all of them now run in CI (§7 E1). The contract tier is the strong part and deserves
saying so: a seeded-PRNG invariant campaign (`test/invariant.test.ts`) asserts
escrow conservation and vault solvency after *every* operation and reproduces
failures from a printed seed; the verifier tests pin fail-safe-before-VK and
lock-once; and the privacy tests already assert on raw calldata
(`expect(blob).to.not.include(commitment)`) rather than on events alone.
Slither is in CI with zero high-severity findings ([SECURITY-REVIEW.md](SECURITY-REVIEW.md)).

## 2. Baseline — what is missing

| Surface | Size | Tests |
|---|---|---|
| ~~`venue-node/relay.mjs`~~ — 16 HTTP endpoints, holds `RELAY_PRIVATE_KEY` | 953 lines | ✅ 49 across two tiers (§5 C1) |
| `web/src/ops/` — four consoles + shell (dispute resolve/slash, governance, pause, upgrade) | 1,385 lines | **0** |
| `web/src/App.tsx` | 2,689 lines | **0** |
| `chain.ts`, `shieldnote.ts`, `relay.ts`, `shield.ts`, `token.ts`, `wallets.ts`, `zk.ts` | ~1,700 lines | **0** |

Three structural facts behind that table:

**~~All 281 tests run only when a human types the command.~~** ✅ Fixed by
`.github/workflows/test.yml` — three jobs, no path filter, real gates. The
original problem: CI was a single Slither job, path-filtered to `contracts/**`,
so a change to `relay.mjs` or `web/src/` triggered nothing at all.

**~~The relay cannot be unit-tested as written.~~** ✅ Fixed. `relay.mjs` bound
its port at import and called `process.exit` on a missing key, so importing it
from a test was impossible. Both side effects are now gated on an `IS_MAIN`
check and the module exports `{ server, handler, relay, provider }` — a
17-line change with no logic touched, deliberately minimal because this file is
deployed live. Full dependency injection (provider, wallet, config) is still
*not* done: config is read once at module scope, so a test needing different
settings re-imports under a fresh query string (`./relay.mjs?rate-limit`). That
works and is used, but a proper factory would be cleaner if this file grows.

**There is no deterministic cost measurement.** No `hardhat-gas-reporter`, no
`solidity-coverage`. `scripts/privacy/measure-costs.mjs` is the right work —
the per-payer ledger and the phase-3b split assertion in particular — but it is
uncommitted, needs three live relay processes plus a funded Paseo deployer, and
emits a one-shot report. It cannot gate a pull request.

---

## 3. Costs

☐ **A1 — Gas snapshot, committed and CI-diffed.** Every user-facing path
measured on a local chain into `gas-snapshot.json`; fail the build on >5%
regression. Paths: `createOrder` (native + ERC-20), `commitBid`,
`acceptSealedBid`, `confirmPickup`, `confirmDropoffZK`, `insertShieldNote`,
note spend, `withdraw` / `withdrawFor`, shield queue + batch, driver/venue
register, `openDispute` / `resolve`.

☐ **A2 — Relay break-even table.** A pure-function test over
`venue-node/economics.mjs`: at what fare does the relay actually profit, given
`relayRebateBps`, `withdrawFeeBps` and the flat service fee? The profitability
*guard* is tested today; the economics it encodes are not. Deterministic, no
chain, no relay.

☐ **A3 — Promote `measure-costs.mjs`.** Split it into a local-chain mode (CI,
stubbed relays) and a live-Paseo mode (nightly), both emitting the same ledger
schema. Commit it, alongside `_relaykeys.mjs`.

☐ **A4 — Proof-cost snapshot.** Circuit constraint counts, proving time, and
zkey/wasm byte sizes. This is a real cost with real consequences — the 32.8 MiB
withdraw zkey already forced a split so Pages could serve it (PR #6). Snapshot
it so a circuit edit that blows the budget fails in review rather than at deploy.

☐ **A5 — Paseo gas-reservation regression.** Paseo reserves
`gasLimit × gasPrice` at submission, so the 500 M weight limit reserves ~500
PAS — fine for a funded relay, impossible for a fresh driver. This already bit a
real run ([PRIVACY-STATUS.md](PRIVACY-STATUS.md) §"What is actually live").
Assert every client-side call sizes its own gas.

---

## 4. Privacy

✅ **B1 — Leak-sweep harness** (`test/helpers/leaksweep.ts` +
`test/leak-sweep.test.ts`, 8 tests). Runs a full delivery — order, sealed
auction, accept, pickup, ZK dropoff — then scans *every block it produced*:
each transaction's calldata and each log's data and topics. Secrets are a table;
adding one is a line.

The matcher searches every encoding a value plausibly takes. The load-bearing
trick is that the **minimal-width** form is a substring of the padded form, so
searching for it also catches wider and packed encodings; negatives get
two's-complement forms at int32 and int256 width, since they are sign-extended
rather than zero-padded.

Claims pinned: no drop coordinate in any encoding (raw or Poseidon-offset)
reaches the chain; the drop salt never leaves the device; the driver's exact
pickup position is genuinely coarsened rather than merely unemitted; and a
losing bid names neither its driver nor its price.

Two design points worth keeping:

- **Sweeps must be closed.** A live sweep runs to the current head every time it
  is queried, so a later control that plants one of the same secrets would
  retroactively fail an earlier absence claim. `stop()` freezes the window.
- **Scope the claim to what is actually being claimed.** The losing-bidder sweep
  covers only the auction window, because that driver's address is legitimately
  on-chain from registration. The honest claim is that *bidding and losing adds
  nothing*, not that they are invisible.

✅ **B2 — Positive controls.** Three, ordered so the matcher proves it can see
before anything trusts what it cannot:

1. Values the protocol publishes on purpose — a `uint256` in a log, an address
   in calldata, a **negative** int32 (the encoding the drop longitude would use),
   the venue's public coordinates.
2. A planted value, in calldata and in a log.
3. **The sharpest one:** replay the calldata shape the dropoff had *before* the
   ZK path — a `LocationAttestation` carrying the real coordinates — and require
   the sweep to flag the very values it reports absent from the real run. Same
   secrets, same encoding, opposite verdict. Plus a salt-reveal variant.

Verified by mutating the protocol path, not just the harness: feeding
`confirmPickup` the exact coordinates instead of the coarsened ones fails the
absence test (both values, both encodings) *and* the presence control. Both
sides fire.

Fixture note: the drop must share no coordinate with the venue. The first run
reported a longitude "leak" that was the venue's own published longitude,
because the fixture reused the value.

☐ **B3 — Codify the Open list as expected-leak tests.** Assert that order value,
tip, delivery timing, and `orders(orderId).venueId` *are* currently public.
Deliberately backwards, and the point is the coupling: it makes
[PRIVACY-STATUS.md](PRIVACY-STATUS.md)'s Open columns executable, so closing one
breaks a test and forces the doc to be updated in the same commit. Adopt only if
you want the privacy posture pinned by tests — it is a real maintenance
commitment, not a free win.

☐ **B4 — Anonymity-set assertions.** The ZK path's set is every unspent note in
the tree; the batch path refuses to seal below `minBatch` (partly covered
today). Assert the *measured* set size, not merely that the mechanism is
present — "anonymity is only as large as usage" is currently a prose claim.

☐ **B5 — Relay metadata.** Request padding is block-aligned (asserted inline in
`measure-costs.mjs` — promote to a unit test); the rotating-salt client key
retains no raw IP or address; a note's insert and spend route to *different*
relays (phase 3b). Testable in-process against fake relays.

☐ **B6 — Timing decorrelation.** Given N deposits, assert the seal ordering does
not preserve insertion order. The dwell/batch mechanism is tested for
correctness but never as a *decorrelator*, which is its actual purpose.

---

## 5. Security

✅ **C1 — Relay endpoint suite.** *Was the largest single gap.* All 16 endpoints —
`/health` `/msg` `/photo` `/fund` `/onboard` `/submit` `/forward` `/withdraw`
`/shield-queue` `/commit-bid` `/bidbox` `/revoke-bid` `/shield-note`
`/shield-note-spend` `/shield-claim` `/shield-withdraw` — against a matrix of:
authorization bound to the correct account, replay (nonce/deadline reuse
rejected), malformed input returning 4xx rather than crashing, oversized bodies,
rate limiting, and injection on the `/msg` and `/photo` topic parameters.

**First chunk done** (`venue-node/relay.test.mjs`, 22 tests): everything
reachable without a chain — routing, CORS origin handling, the `/msg` and
`/photo` in-memory stores, the rate limiter, malformed transport, and the
pre-chain validation branches of `/fund`, `/submit` and `/onboard`. The suite
points the relay at an unroutable RPC, so every passing assertion also proves
the path under test never reached for the chain.

Two things that chunk turned up:

- **An oversized body returns 500, not 413.** `readJson` throws past the
  endpoint's own limit check, and the catch-all maps it to 500. The `/msg` and
  `/photo` handlers do return a proper 413 for bodies within the 256 KiB
  transport cap. Cosmetic, but it means a client cannot distinguish "too big"
  from "relay broke". Not changed here — behavioral fix, not a test.
- **A leak test of mine was vacuous** and only a positive control caught it: it
  asserted `_pad` never lands in a stored message, but `_pad` is a body-level
  key that never had a path into `msg`, so it passed against a deliberately
  broken relay too. Rewritten to pin what is actually observable — that padded
  and unpadded bodies behave identically, which is the property the client's
  metadata defense depends on. This is B2 justifying itself on the first use.

**Second chunk done** (`test/relay-endpoints.test.ts`, 13 tests): the
authorization and replay matrix, in the hardhat tier rather than the venue-node
one. These assertions are about what the *contracts* let the relay do, and the
contracts already exist here — wiring hardhat into a suite whose only dependency
is `ethers` purely to redeploy them would have cost more than the tests. The
real `relay.mjs` runs unmodified against hardhat's in-process chain through a
small JSON-RPC bridge.

What it pins: `/withdraw` pays only on the account's own signature, cannot be
re-pointed at an unsigned recipient, rejects a replayed signature (with the
balance refilled first, so the guard under test is the nonce and not an empty
balance) and an expired deadline; `/forward` enforces the target allowlist,
refuses to carry value, and cannot forge a sender; `/fund` will not double-fund;
and the profitability guard declines a withdrawal it cannot cover (C2).

**A defect this surfaced, since fixed —** the relay picked its transaction
nonce with `getTransactionCount(relay, "latest")`. That excludes a
submitted-but-unmined transaction, and ethers caches the read for ~250 ms on
top, so two submissions inside that window drew the same nonce and the node
rejected the second. `serialize()` ordered the sends but did not give them
distinct nonces. On a chain with multi-second blocks that was not a narrow race
— any two users arriving together could trigger it, and at least one got a 500.

Fixed by allocating nonces locally: seeded once from the chain at `"pending"`,
handed out as increments, and dropped on any failure so a send that never
landed cannot leave a gap that stalls every later transaction. Safe without a
lock precisely because every allocation happens inside `serialize()`. The
characterization test was inverted into `submits concurrent requests on
distinct nonces` (five unspaced concurrent `/fund` calls, all of which must
land) plus `recovers its nonce after a failed submission`. Mutation-checked:
restoring the old one-line behaviour fails the first of those.

**A second, separate read-freshness property** turned up when the spacing came
out, and is *not* fixed: ethers also caches `eth_getBalance` / `eth_call` for
~250 ms, so two `/fund` calls for the same address inside that window both
observe a zero balance and both pay out. Bounded by the rate limiter and the
subsidy budget, so it is a small leak rather than a drain, but it means
`/fund`'s "already funded" check is not authoritative under bursts. The relay
tests space their calls past it deliberately, and say so.

One consequence for anyone writing more of these: `relay.mjs` prefers
`PINE_RPC` over `RELAY_RPC_URL`, and `hardhat.config.ts` calls `dotenv.config()`,
so a `PINE_RPC` in `.env` silently wins and the relay under test talks to a real
node. Both relay suites now delete it explicitly.

**Third chunk done** (`test/relay-shield-endpoints.test.ts`, 13 tests): the four
shielded endpoints, where the relay is most trusted and least authorized.

- `/shield-queue` — validation, the duplicate-commitment 409, and the rollback
  that releases a held commitment when the chain rejects the authorization.
  That rollback matters more than it looks: the commitment is recorded *before*
  the ticket is spent, so without it a failed submission would 409 that
  commitment forever and the payee could never queue it again.
- **The pairing invariant, asserted against real calldata.** PRIVACY-TIERS §3
  depends on the account and its commitment never sharing a transaction. The
  test reads the mined queue transaction and requires the commitment absent —
  with a positive control in the same assertion (the account *is* present), so
  a broken matcher fails rather than passes.
- `/shield-note` — inserts what the payee signed, and **cannot substitute a
  commitment they did not**. Paired with the success case on the same path so
  the two differ only in the commitment.
- `/shield-note-spend` — input validation, and the retryable 409 for a stale
  root (the tree moves while a payee proves, so that has to be recoverable
  rather than a burned revert).
- `/shield-withdraw` — refuses a proof whose `context` names a different
  recipient, i.e. the relay will not submit a withdrawal whose destination it
  cannot verify. Mutation-checked: disabling the context comparison in
  `relay.mjs` fails exactly this test.

Groth16 proving is not repeated at this layer — the real-proof paths are in
`shieldnote-vault.test.ts`. What these add is the HTTP boundary in front of
them.

`/submit` is left at the method-allowlist level: the attestation signatures it
forwards are already covered by `fare.test.ts`.

☐ **C2 — Relay key custody.** `/fund` cannot be drained as an unbounded faucet
(the budget window holds under concurrency), and the profitability guard
declines with 402 rather than burning the key.

☐ **C3 — Access-control matrix.** 94 external/public functions ×
{owner, router, arbiter, guardian, keeper, stranger} → assert the exact set that
succeeds. Individually covered in places today, but not systematically; a matrix
catches a modifier dropped during the next upgrade.

☐ 🔒 **C4 — Deployed-VK ↔ committed-zkey hash check.** `setVerifyingKey` is
lock-once and both setups are still single-party, which makes a swapped zkey
both undetectable and unrecoverable. Assert the deployed VK hashes to the
committed artifact. Extend to transcript verification when the real MPC ceremony
runs — that ceremony remains the top mainnet gate.

☐ **C5 — Ops-console calldata tests.** The consoles issue
`resolve(customerShareBps, openerWins, driverAtFault, slash)` and
`upgradeContract`. Assert form input → exact calldata, and that the console's
escrow-split *preview* agrees with the contract's real split. A wrong bps here
slashes a real driver; 1,385 lines of it are untested.

☐ **C6 — Mythril nightly.** Currently documented as an on-demand deep-dive,
which in practice means it never runs. Schedule it against `FareVault`,
`FareOrders` and `FareForwarder`.

---

## 6. Function

☐ **D1 — Ops console component tests.** Four consoles, zero coverage.

☐ **D2 — Client core units.** `wallets.ts` burner derivation especially — a
determinism bug there silently re-links orders, defeating the customer's primary
protection. Then `chain.ts` (519 lines, runtime router resolution), `relay.ts`,
`token.ts`, `zk.ts`.

☐ **D3 — Degradation matrix.** KV unbound, no relay reachable, no IPFS, no
faucet secret, no VAPID key. [REMAINING-ACTIONS.md](REMAINING-ACTIONS.md) §1
claims each of these degrades gracefully; nothing tests it.

☐ **D4 — Local-chain full-lifecycle e2e.** A hardhat-node variant of
`scripts/privacy/live-order-e2e.mjs`, so the same lifecycle coverage runs per-PR
at zero cost. The live Paseo runs stay, as the nightly.

☐ **D5 — Order state machine.** Exhaustive: assert every invalid transition
reverts. The fuzz campaign reaches some of these incidentally; an explicit
matrix is cheap and complete.

---

## 7. Harness

This is the multiplier — it converts 281 existing tests from decorative to
load-bearing.

✅ **E1** — CI runs all three suites on every PR
(`.github/workflows/test.yml`). Validated against a clean checkout, which
caught that `test/shieldnote-vault.test.ts` needs proving artifacts that are
gitignored; the job restores them from the byte-identical tracked copies under
`web/public/shield/`.
☐ **E2** — `solidity-coverage` + `vitest --coverage`, with a floor.
☐ **E3** — Nightly: live Paseo e2e, cost ledger, Mythril, wide fuzz seeds
(`for s in $(seq 1 50); do FUZZ_SEED=$s npx hardhat test test/invariant.test.ts; done`).
☐ **E4** — Gas and constraint snapshots committed and diffed.

---

## 8. Priority

1. ✅ **E1 — wire CI.** Cheapest item here and it makes every other test real.
2. ✅ **C1 — relay endpoints.** Done across both tiers (49 tests): handler
   extraction, the no-chain surface, the authorization/replay matrix, and the
   shielded endpoints. Turned up a nonce-collision defect in the live relay,
   now fixed and regression-tested.
   🟡 **C2** has its first case (the withdraw decline); the remaining budget and
   fee-recovery guards are not covered.
3. ✅ **B1 / B2 — leak sweep + positive controls.** Done (8 tests). The privacy claims are the
   product; today they are asserted per-test and never negatively controlled.
4. **A1 / A3 — gas snapshot + committed cost ledger.**
5. **C5 / D1 — ops consoles.** Small surface, worst blast radius.
6. **C3 — access-control matrix**, then **D3**, then the remainder.

B3 is deliberately left as a decision rather than a recommendation: it is worth
adopting only if the privacy posture should be pinned by tests.

## See also

- [PRIVACY-STATUS.md](PRIVACY-STATUS.md) — what is actually protected today, by role
- [SECURITY-REVIEW.md](SECURITY-REVIEW.md) — the Slither triage this extends
- [REMAINING-ACTIONS.md](REMAINING-ACTIONS.md) — E2/E3 mainnet gates, ops prerequisites
- [PRIVACY-TIERS.md](PRIVACY-TIERS.md) — the designs the §4 tests would pin
- [E2E-PRIVACY-LIVE.md](E2E-PRIVACY-LIVE.md) · [E2E-PRIVACY-ZK.md](E2E-PRIVACY-ZK.md) — the live runs the nightly would automate
