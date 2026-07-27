# FARE — Test Plan (costs, privacy, security, function)

A gap analysis of the current suite and the tests that would close it. Written
2026-07-26, against the post-migration tree ([PRIVACY-STATUS.md](PRIVACY-STATUS.md)).

The contracts are well tested. This document is mostly about **everything
around them** — the relay, the ops consoles, the client core, and the CI that
would make any of it run.

What this work has already turned up — defects, open items, and four assertions
that passed for the wrong reason — is in [TEST-FINDINGS.md](TEST-FINDINGS.md).

Legend: ☐ not started · 🟡 partial · 🔒 mainnet gate.

---

## 1. Baseline — what exists

All three tiers pass today.

| Tier | Runner | Tests | Covers |
|---|---|---|---|
| `test/*.ts` | `npx hardhat test` | 218 | contracts, ZK verifiers, invariant fuzz, upgradability, **chain-backed relay endpoints** |
| `web/src/*.test.ts` | `cd web && npx vitest run` | 117 | 15 of 34 client modules, incl. **all four ops consoles' logic** |
| `venue-node/*.test.mjs` | `cd venue-node && node --test` | 94 | economics + **break-even**, scorer, swap, treasury, agent, shieldkeeper + **decorrelation**, **relay HTTP surface + metadata** |

**429 tests, all green**, and all of them now run in CI (§7 E1). The contract tier is the strong part and deserves
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
| ~~`web/src/ops/`~~ — four consoles + shell | 1,385 lines | ✅ 29 (all decision logic extracted — §5 C5) |
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

**~~There is no deterministic cost measurement.~~** 🟡 Partly fixed. §3 A1 pins
18 paths in `gas-snapshot.json` behind a ±5% CI gate, so gas regressions now
surface in review.

What is still missing is a *per-role cost ledger* that runs unattended.
`scripts/privacy/measure-costs.mjs` is the right work — the per-payer accounting
and the phase-3b split assertion in particular — but it needs three live relay
processes and a funded Paseo deployer, and emits a one-shot report, so it cannot
gate a pull request (A3). There is also still no `solidity-coverage` (E2).

---

## 3. Costs

✅ **A1 — Gas snapshot, committed and CI-diffed** (`test/gas-snapshot.test.ts`
→ `gas-snapshot.json`, 18 paths). Drift beyond ±5% fails. Regenerate
deliberately with `UPDATE_GAS_SNAPSHOT=1 npx hardhat test
test/gas-snapshot.test.ts` and commit the diff — the review is the point. No CI
change was needed: the contracts job already runs `npx hardhat test`.

Determinism comes from running every measurement out of `loadFixture`, so each
path starts from an identical chain state and warm/cold storage costs cannot
depend on what an earlier test touched. Verified by running the comparison
twice, and by mutating the baseline: a 10% shift and a stale entry both fail
with the path named and the delta shown. The numbers are solc- and
EVM-version-specific, deliberately — a compiler bump that moves gas should
surface here and be recorded rather than pass silently.

Two numbers worth knowing now that they are pinned:

| Path | Gas |
|---|---|
| `vault.insertShieldNote` | **730,615** — a depth-16 Poseidon tree insert, by far the most expensive path in the protocol |
| `FareLocationVerifier.verifyProximity` | **305,627** — the Groth16 pairing check |
| `orders.createOrderERC20` | 256,597 |
| `settlement.confirmPickup` / `confirmDropoffZK` | ~214,000 each |
| `orders.createOrder` | 196,833 |
| `vault.withdraw` | 55,350 |

`confirmDropoffZK` is measured against the mock verifier, so it is settlement
overhead only; the real proof cost is the separate verifier row, and the two
move independently. The note *spend* is not yet measured — it needs a real
Groth16 proof against a live tree root, which is covered functionally in
`shieldnote-vault.test.ts` but is slow to reproduce here.

✅ **A2 — Relay break-even table** (`venue-node/breakeven.test.mjs`, 6 tests).
Adds `breakEvenFareWei` to `economics.mjs` — the exact inverse of the guard: the
least fare at which settling an order pays for itself. The guard answers "is
this one worth relaying?"; this answers "from what fare up is relaying worth
doing at all?", which is the question an operator setting `relayRebateBps` or
`relayServiceFee` actually has.

Costs come from `gas-snapshot.json` (measured, §3 A1) at Paseo's 1000 gwei, not
from an estimate. **The answer, at deployed parameters:**

| | |
|---|---|
| Relayed gas per delivery (pickup + ZK dropoff incl. the real verify) | **0.7335 PAS** |
| Break-even fare, `relayRebateBps=2000` rebate **alone** | **183.37 PAS** |
| Flat service fee that removes fare-dependence entirely | **0.9168 PAS / order** |
| Cash-out at which the 1% withdraw fee covers its own gas | **11.24 PAS** |

The rebate is `fare × feeBps × relayRebateBps / 1e8` = **0.5% of the fare** at
the deployed 250/2000 — half a percent of one order to cover that order's entire
gas. A 183 PAS break-even fare is two orders of magnitude above any real food
delivery, which is the quantified version of the warning already in
[REMAINING-ACTIONS.md](REMAINING-ACTIONS.md) §1. **The flat service fee is not a
tuning knob, it is the mechanism** — it is what makes a relay viable at all, and
it needs to be ≈0.92 PAS at these gas prices.

Correctness rests on an exactness property checked over 640 parameter
combinations: at the returned fare the guard passes, and at one wei less it
fails. Mutation-checked — and the first version of that property was vacuous
(see [TEST-FINDINGS.md](TEST-FINDINGS.md) #8–11, sixth instance).

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

✅ **B4 — Anonymity-set assertions** (`test/anonymity-set.test.ts`, 7 tests).
Every test produces a **number** and asserts it, including the uncomfortably
small ones. The existing suites prove the batching and note mechanisms work,
which is a different claim: a mechanism can run perfectly and deliver a set of
one.

Pinned: a lone note has a set of **1**; the batch set is the seal size with
`minBatch` as its floor; sealing 8 gives 8 even though deposits go out two at a
time (the per-transaction ceiling is not the set); and a quiet bucket cannot
borrow a busy one's crowd — 8 pending in one denomination does nothing for the 2
in another, so the batch never forms.

**This corrected a privacy claim.** `bucket` is a public signal of a ZK spend
(`FareVault.depositShieldNoteZK` passes it to the verifier), so a 25 PAS spend
is publicly a 25 PAS spend and hides only among other 25 PAS notes.
[PRIVACY-STATUS.md](PRIVACY-STATUS.md) said the set was "every unspent note in
the tree", which overstates it whenever more than one of the three deployed
buckets is in use — in the test fixture, a lone 25 PAS note sits in a tree of
nine with a set of one. Both that doc and
[E2E-PRIVACY-ZK.md](E2E-PRIVACY-ZK.md) now say "of the same bucket"
([TEST-FINDINGS.md](TEST-FINDINGS.md) #16).

✅ **B5 — Relay metadata.** Split across the tier that can actually test each
half.

*Client side* was already covered by `web/src/relaypick.test.ts`: deterministic
relay selection (a retry does not widen who saw the request), spread across the
pool, `pickRelayAvoiding` keeping a note's insert and spend on **different**
relays, honest degradation to one relay, and `padBody` making a note insert and
a proof submission the same size to the byte.

*Relay side* is new (`venue-node/relaymeta.test.mjs`, 7 tests), and targets the
claim in [PRIVACY-STATUS.md](PRIVACY-STATUS.md) that "client addresses are
hashed under a rotating salt so no table of callers is kept". That is a
statement about what is **in memory**, so the test looks: it drives real
requests through the real handler and then inspects the limiter's keys. To make
that possible `relay.mjs` exports `clientKey` and a read-only `rateLimitKeys()`.

Pinned: the key is a fixed-width digest that neither equals, contains, nor
partially embeds the address (so an IPv6 caller is not even distinguishable from
an IPv4 one by key length); callers are still told apart; a salt rotation
changes the digest and drops the old table; and throttling one caller leaves
another unaffected.

Mutation-checked: returning the raw address instead of a digest fails three
tests; disabling salt rotation fails one. That second mutation also exposed a
test of mine that passed for the wrong reason — it advanced the clock 11 minutes
and so tripped the per-caller counter reset as well as the rotation, proving
neither in particular. Now split: rotation is asserted directly, and the counter
reset is asserted at 61 s, one window on and nine short of a rotation.

Not attempted: the client's real `padBody` posted through the real relay. `node`
cannot import `relaypick.ts` (its `./pool` import has no extension), and the
only cross-tier contract is the `_pad` field **name** — which is pinned on both
sides independently.

✅ **B6 — Batch decorrelation** (`venue-node/decorrelation.test.mjs`, 8 tests).

The stakes: an observer sees `ShieldQueued` in queue order and pool deposits in
deposit order. If those two orders agree, the pairing falls out **by position**
and the two-transaction split has bought nothing. The contract consumes tickets
FIFO, so the keeper's shuffle is the only thing between the two lists.

`shieldkeeper.test.mjs` already asserted that batches differ across runs. That
shows randomness exists; it does not show the ordering is *decorrelated*.

Measured instead: positional uniformity at 5σ over 20k trials, mean Pearson r
between queue index and batch position, the fixed-point rate (~1 per batch, as
for any random permutation), the same through `planBatch` rather than `shuffle`
in isolation, and that chunking for the chain ceiling does not re-sort.

**The instructive part.** A first draft passed a mutation that replaced the
Fisher-Yates with a *random rotation* — and so did the pre-existing test. A
rotation has identical **marginals** to a fair shuffle: uniform positions, ~1
fixed point, mean correlation ≈ 0. What it preserves is the **joint**
structure, which is exactly the property that matters here — an attacker who
de-anonymises one pairing gets every other pairing for free. Two tests were
added for that: pairwise relative order (`i` precedes `j` half the time, for
every pair) and adjacency (a commitment's queue-neighbour must not follow it).
Under the rotation those report 0.882 and 87.5%.

Mutation-checked both ways: the rotation fails the two joint tests, and the
classic off-by-one Fisher-Yates (`randomInt(a.length)`) fails five of the
eight. Stable across repeated runs — the thresholds are ≥5σ.

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

✅ **C3 — Access-control matrix** (`test/access-control.test.ts`). All 60 gated
state-changing functions × 10 roles — **530 denial checks** plus 60 permission
checks, in ~1 s.

Three things make it worth more than the sum of its assertions:

- **Denials are matched against the specific authorization error**, decoded from
  raw revert data rather than read off Hardhat's inferred message (several of
  these come back as "couldn't infer the reason"). A call that reverts because
  the arguments were nonsense would otherwise pass as though authorization had
  held — the failure mode that makes most such matrices decorative.
- **The permitted role is checked too**, but only that it is not stopped *by the
  access check*. It may still revert on state — `disputes.resolve` as the
  arbiter hits `bad-status` because no dispute exists — and that is a different
  question, owned by the suites that drive those flows.
- **The table is checked for completeness against the contracts.** A modifier
  dropped, or a new gated function added, breaks no other test in the repo,
  because no other test calls that function as the wrong caller. It breaks this
  one. Roles are held by *different* accounts throughout, so "authorized is
  denied on an owner-gated call" is a real assertion rather than an artifact.

Contract-held roles (settlement, disputes, router) need no impersonation: the
sweep uses `eth_call` with an arbitrary `from`.

Mutation-checked in both directions: removing `onlyOwner` from
`setShieldKeeper` fails 9 of the 530 checks by name; deleting a row from the
table fails the completeness check.

☐ 🔒 **C4 — Deployed-VK ↔ committed-zkey hash check.** `setVerifyingKey` is
lock-once and both setups are still single-party, which makes a swapped zkey
both undetectable and unrecoverable. Assert the deployed VK hashes to the
committed artifact. Extend to transcript verification when the real MPC ceremony
runs — that ceremony remains the top mainnet gate.

🟡 **C5 — Ops-console tests.** The riskiest logic — the escrow-split preview an
arbiter reads before signing an irreversible `resolve()` — was inline in
`DisputesConsole.tsx` and therefore untestable. Extracted to
`web/src/ops/ruling.ts` (`splitEscrow`, `slashExceedsStake`) and covered twice:
6 unit tests (`ruling.test.ts`) and 3 **differential** tests against the real
`FareOrders.resolveDisputed` (`test/ops-ruling.test.ts`), which import the
shipped module rather than reimplementing the formula.

The preview matches the chain exactly, including the driver-takes-the-remainder
form that keeps both sides summing to the escrow. `slashExceedsStake` exists
because `FareDrivers.slash` **clamps rather than reverting**, so without the
warning the console would promise damages that never arrive.

The differential test was initially vacuous — see
[TEST-FINDINGS.md](TEST-FINDINGS.md) #11.

**Governance, pause and upgrade** are now covered the same way, via
`web/src/ops/govparams.ts` and `web/src/ops/upgrade.ts` (13 unit tests, 7
differential). Each console duplicates a `require` from Solidity so it can
disable Save instead of letting an operator broadcast a revert — which means the
two copies can drift in *either* direction, so every boundary is probed on both
sides and the verdicts compared:

- `setParams` and `setGeoParams` bounds match their contracts exactly, at every
  boundary. Mutation-checked: widening `FEE_BPS_MAX` to 2000 fails at 1001.
- The pause console's authority model matches `FarePauseRegistry` — guardians
  pause but cannot unpause, and the four listed categories are the four accepted.
- The upgrade console's router keys resolve to the entries `scripts/deploy.ts`
  registers, and its `upgradable` flag matches which entries the router accepts
  `upgradeContract` for. Drift there would not error — it would silently address
  a different registry slot.

**This found a live defect:** a cleared numeric field parsed as `0` and Save
stayed enabled, so blanking the protocol-fee box set the fee to zero. Fixed;
[TEST-FINDINGS.md](TEST-FINDINGS.md) #13.

**Out of scope:** component rendering. The web tier has no DOM testing
dependency, and adding one is a decision rather than a gap — the logic that
decides what a console *does* is now all outside the components.

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

✅ **D3 — Degradation matrix** (`web/src/degradation.test.ts`, 12 tests). Each
optional backend removed, asserting the *documented* behaviour rather than
merely "it didn't throw":

- **Channel with no KV and no relay** — `open()` resolves, `poll()` returns an
  empty thread, `sendLoc` reports `false`, and `send()` gives the friendly
  "waiting for the other party" rather than a transport crash. The topic still
  derives locally, so order identity never depends on a service.
- **IPFS unconfigured** — `publishMenu` returns a `local://` URI with
  `shared: false`, readable back on that device; an `ipfs://` menu read once
  stays readable when every gateway dies; a legacy `demo://` URI returns null
  instead of being guessed at.
- **No relay** — `relayConfigured()` and `forwarderAvailable()` both false, so
  callers take the direct gas-paying path; `sponsorGas` declines cleanly.
- **No shielded funding** — `fundBurner` throws. This is the one case that must
  *not* degrade quietly: a burner funded outside the pool carries an on-chain
  edge back to the customer, so absence has to be an error, not a fallback.
- **No VAPID key** — push reports itself off and subscribing is a no-op.

Two things this turned up. It found that the **faucet ops step was stale**
([TEST-FINDINGS.md](TEST-FINDINGS.md) #14) — `/api/drip` had no callers, so the
documented "falls back to the public faucet" degradation did not exist; the
faucet has since been deleted rather than reconnected. And a
mutation showed the menu tests were covering only *one* of two failure branches:
an unbound KV answers 503 (`res.ok`), a dead host rejects (`catch`), and
removing the catch fallback survived the suite until a case was added for it.

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
4. 🟡 **A1 / A3 — gas snapshot + committed cost ledger.** A1 done (18 paths,
   ±5% gate); A3 (splitting `measure-costs.mjs` into local + live modes) remains.
5. ✅ **C5 / D1 — ops consoles.** Done (29 tests); found and fixed a defect
   that set governance parameters to zero.
6. ✅ **C3 — access-control matrix.** Done (530 denial checks, self-maintaining).
   Then **D3**, then the remainder.

B3 is deliberately left as a decision rather than a recommendation: it is worth
adopting only if the privacy posture should be pinned by tests.

## See also

- [PRIVACY-STATUS.md](PRIVACY-STATUS.md) — what is actually protected today, by role
- [TEST-FINDINGS.md](TEST-FINDINGS.md) — what this work found, with status
- [SECURITY-REVIEW.md](SECURITY-REVIEW.md) — the Slither triage this extends
- [REMAINING-ACTIONS.md](REMAINING-ACTIONS.md) — E2/E3 mainnet gates, ops prerequisites
- [PRIVACY-TIERS.md](PRIVACY-TIERS.md) — the designs the §4 tests would pin
- [E2E-PRIVACY-LIVE.md](E2E-PRIVACY-LIVE.md) · [E2E-PRIVACY-ZK.md](E2E-PRIVACY-ZK.md) — the live runs the nightly would automate
