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
| `test/*.ts` | `npx hardhat test` | 255 | contracts, ZK verifiers, invariant fuzz, upgradability, **chain-backed relay endpoints**, **per-payer cost ledger**, **relay key custody**, **full-lifecycle e2e**, **order state machine** |
| `web/src/*.test.ts` | `cd web && npx vitest run` | 249 | 28 of 36 client modules, incl. **all four ops consoles (logic + rendered)**, **burner wallets**, **ZK commitments**, **relay client + router resolution** |
| `venue-node/*.test.mjs` | `cd venue-node && node --test` | 94 | economics + **break-even**, scorer, swap, treasury, agent, shieldkeeper + **decorrelation**, **relay HTTP surface + metadata** |

**598 tests, all green**, and all of them now run in CI (§7 E1). The contract tier is the strong part and deserves
saying so: a seeded-PRNG invariant campaign (`test/invariant.test.ts`) asserts
escrow conservation and vault solvency after *every* operation and reproduces
failures from a printed seed; the verifier tests pin fail-safe-before-VK and
lock-once; and the privacy tests already assert on raw calldata
(`expect(blob).to.not.include(commitment)`) rather than on events alone.
Slither is in CI with zero high-severity findings ([SECURITY-REVIEW.md](SECURITY-REVIEW.md)).

## 2. Baseline — what is missing

| Surface | Size | Tests |
|---|---|---|
| ~~`venue-node/relay.mjs`~~ — 16 HTTP endpoints, holds `RELAY_PRIVATE_KEY` | 953 lines | ✅ 58 across two tiers (§5 C1, C2) |
| ~~`web/src/ops/`~~ — four consoles + shell | 1,385 lines | ✅ 82 (logic §5 C5 + rendering §6 D1) |
| `web/src/App.tsx` | 2,689 lines | **0** |
| `shieldnote.ts`, `shield.ts` | ~520 lines | **0** |
| ~~`wallets.ts`~~ · ~~`zk.ts`~~ · ~~`token.ts`~~ · ~~`chain.ts`~~ · ~~`relay.ts`~~ | ~1,180 lines | ✅ 71 (§6 D2) |

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

**~~There is no deterministic cost measurement.~~** ✅ Fixed, in two halves. §3 A1
pins 18 paths in `gas-snapshot.json` behind a ±5% CI gate, so gas regressions
surface in review; §3 A3 adds the *per-role cost ledger* that runs unattended.

The accounting `scripts/privacy/measure-costs.mjs` did — per-payer attribution in
particular — is now a shared module, so the half that needs three live relay
processes and a funded Paseo deployer stays nightly while the same lifecycle,
the same ledger and the same report shape gate every pull request against
hardhat. Coverage now has committed floors on both tiers (E2).

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

✅ **A3 — Per-payer cost ledger, running unattended**
(`scripts/privacy/ledger.mjs` + `test/cost-ledger.test.ts`, 7 tests).

The accounting came out of `measure-costs.mjs` into a pure module — no chain, no
I/O, callers hand it gas, price and revenue — and both modes now use it: the live
Paseo run through three real relays, and a local-chain run that gates per-PR. The
report shape is identical from either, so the two can be diffed against each
other.

**The numbers are not what this pins** — A1's snapshot owns those, and the
hardhat figures are not comparable to Paseo's anyway. **Who pays** is the claim.
A change that moves a cost from the relay onto the customer does not alter the
total, and a single aggregate would hide it completely, so every step is asserted
against the party that should have footed it:

| Payer | Tx | Steps |
|---|---|---|
| relay | 4 | `/fund`, `/submit confirmPickup`, `/submit confirmDropoffZK`, `/withdraw` |
| customer | 2 | `createOrder`, `acceptBid` — and *only* these |
| driver | 1 | `placeBid` |
| venue | 1 | `vault.withdraw`, the unsubsidised path |

That table is the F8 bargain stated as a test: the relay foots every gasless
step and **never fronts escrow**, the customer pays only for the two actions that
move their own money, and the driver needs gas for the bid alone. The relay earns
on exactly one endpoint (`/withdraw`, 1%) and still nets negative — the A2
economics visible as a balance, with the test naming `breakeven.test.mjs` in its
failure message if that ever flips.

The delivery is driven end to end against the real `relay.mjs` over a JSON-RPC
bridge to hardhat's in-process chain (the C1 arrangement), from a **genuine fresh
burner** rather than a funded signer — `/fund` declines an address that already
holds gas, so only a real burner exercises the sponsorship path at all.

Three properties of the ledger itself are checked separately from the delivery:
the per-payer totals reconstruct from the rows and the whole from the payers (an
off-by-one in the grouping would survive a spot check), the report's keys are
pinned in both shapes, and a row without a payer is **refused** — an
unattributed cost is precisely the failure this file exists to prevent.

Mutation-checked in both directions. Dropping the payer filter from `stepsFor`
fails all three attribution tests — including by name, `the relay paid for
createOrder — it must never front escrow`. And reverting the gas-limit fix below
fails **every** test in the file at the fixture, which is the check that matters
most here: it proves the delivery really is driven through the live relay's
settlement path rather than quietly skipping it.

Turned up [TEST-FINDINGS.md](TEST-FINDINGS.md) #18: the relay's 500 M settlement
gas limit is a Paseo weight-scale number that exceeds hardhat's 2^24 per-tx cap,
so the relay could not settle on a local chain at all. Now overridable, default
unchanged.

The live mode still needs a funded deployer and three relay processes; it stays
nightly (§7 E3). Both it and `_relaykeys.mjs` are committed.

✅ **A4 — Proof-cost snapshot** (`test/proof-cost.test.ts` → `proof-cost.json`,
4 tests). Regenerate with `UPDATE_PROOF_SNAPSHOT=1`.

The cost gas measurement never sees: bytes a user downloads, and Cloudflare
Pages' hard **25 MiB per-asset ceiling**. That ceiling already bit once — the
32.8 MiB withdraw proving key could not be published and had to be split across
three parts (PR #6), discovered at deploy time.

| Served artifact | Size |
|---|---|
| `withdraw_v7.zkey` (3 parts + manifest) | **32.8 MiB** total, 12 / 12 / 8.82 |
| `withdraw_v7.wasm` | 2.20 MiB |
| `shieldnote.zkey` | 4.38 MiB |
| `shieldnote.wasm` | 1.92 MiB |
| `proximity.wasm` / `.zkey` | 2.08 / 0.75 MiB |

Four guards: the Pages ceiling asserted **absolutely** (a limit imposed from
outside, not a snapshot); the split manifest checked in both directions — parts
match their declared sizes and sum, the sha256 of the concatenation matches, the
shipped loader agrees, *and* the whole still exceeds the ceiling, so if a circuit
change ever brings it under, the now-pointless split gets removed deliberately;
exact byte sizes against the snapshot; and each circuit's `nPublic` — its ABI,
which a lock-once VK makes expensive to change unnoticed — cross-checked between
`vk.json` and the deployed `setVK-calldata.json`.

Mutation-checked: a 25.75 MiB file dropped into `web/public/zk/` fails the
ceiling and the snapshot; a 4 KB size drift and an `nPublic` change each fail
their own test.

**Proving time is deliberately not gated.** It varies several-fold across
machines, so a CI threshold loose enough not to flake would catch nothing. The
live e2e runs measure it on real hardware instead
([E2E-PRIVACY-ZK.md](E2E-PRIVACY-ZK.md)).

✅ **A5 — Paseo gas-reservation regression** (`web/src/gasbudget.ts` +
`gasbudget.test.ts`, 7 tests).

Paseo reserves `gasLimit × gasPrice` at **submission**, not execution, so a
generous limit demands the sender already hold that much whatever the call
burns. The operator scripts and the relay use 500 M — ~500 PAS reserved at 1000
gwei, fine from a funded deployer and impossible for a 5 PAS burner. This
already cost a live run.

The good news from auditing it: **500 M appears only in `scripts/` and
`venue-node/`**, never in `web/src`. That separation is the design, and it now
has a test.

Client limits moved into one budgeted module and are asserted against what a
burner actually holds. Two things are pinned that were previously implicit:

- **`shieldedReturn`'s hold-back must cover its own gas limit.** The reserve and
  the limit are two numbers that have to agree; raising the limit without the
  reserve makes every shielded return fail at submission, on a path that only
  runs when a user cashes out. Now `RETURN_RESERVE_WEI = reservationFor(RETURN_GAS) + margin`,
  so the relationship is structural rather than a coincidence of two literals.
- **No gas-limit literal in `web/src` may reserve more than a burner holds.** A
  source scan with a control that plants a 500 M literal and requires it to be
  caught — necessary because zero matches is the healthy state, and an empty
  result would look identical to a broken regex.

`depositAndSnapshot`'s gas limit became a **required** parameter in the process:
every caller now budgets deliberately, and it keeps `shieldpool.ts` free of
relative imports, which the hardhat tier needs
([TEST-FINDINGS.md](TEST-FINDINGS.md) #17).

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

✅ **C2 — Relay key custody** (`test/relay-custody.test.ts`, 9 tests). C1 asked
whether the relay can move value nobody authorized — the contracts answer that.
C2 asks the question no contract can: **can the hot key be drained through
endpoints working exactly as designed?**

Everything here runs with `RELAY_PROFIT_GUARD=on`, the deployed default and the
opposite of the C1 files, because the guard is the subject and cannot be the
thing that is switched off.

What holds: the rolling window stops sponsoring once spent; a 402 decline spends
**nothing** (no transaction, not a failed one — otherwise the budget would
throttle a leak rather than stop it); the window rolls forward and not early; the
balance floor still reports 503 for an operator refill rather than submitting a
transaction it cannot pay for; and the profitability guard declines an
unprofitable withdrawal with the balance left where it was.

**Two defects, both measured rather than argued, both now fixed.**

**The budget did not bound `/fund`** ([TEST-FINDINGS.md](TEST-FINDINGS.md) #19).
It recorded the *gas of a transfer* and never the `FUND_AMOUNT` it sent, while
`/onboard` recorded `cost + ONBOARD_SEED` and commented that the seed *is* the
subsidy. Eight `/fund` calls moved **40 PAS against a declared 1 PAS window**,
which was still not exhausted — so the faucet was bounded by the relay's balance
and the rate limiter, not by the budget. An attacker generates fresh addresses,
which makes the per-address "already funded" check no defense at all.

Fixed, with the resizing that has to accompany it: the default window went from
50 PAS to **250 PAS**, which at a 5 PAS sponsorship is 50 burners a day. That is
the real change — a budget counting only gas could not be reasoned about (50 PAS
of gas is on the order of a million sponsorships), and the knob now means
"burners per window". The two defaults are consequently pinned as a pair, so
changing either alone fails instead of silently rescaling capacity.

**The budget overshot under concurrency** ([TEST-FINDINGS.md](TEST-FINDINGS.md)
#20). Check, `await` the send, record afterwards: every request in flight tested
the same pre-spend total and all passed. Three concurrent `/onboard` calls seeded
against a budget that fits one, spending 6 PAS of a 3 PAS window. Now
`reserveBudget()` checks and takes in one synchronous step across all nine
guarded handlers — no lock needed, since the check and the `+=` are adjacent with
no await between them — with a `release()` for sends that never land, tested by
forcing a rejected submission, since a reservation never returned would deny
service without spending anything.

Mutation-checked, each against exactly one test: restoring `reserveBudget(cost)`
in `/fund`; a default budget that is not a whole number of sponsorships;
deferring the reservation past the send; dropping the refund in `release()`.

What is still **not** authoritative is `/fund`'s "already funded" check under
bursts ([TEST-FINDINGS.md](TEST-FINDINGS.md) #2, open): ethers caches
`eth_getBalance` for ~250 ms, so two calls for the same address inside that
window both see zero. Each now takes its own reservation, so the window bounds
the damage — it is a duplicate sponsorship, not a drain.

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

✅ **C6 — Mythril nightly** (`scripts/mythril.sh`, run by §7 E3's nightly against
`FareVault`, `FareOrders` and `FareForwarder`). It was documented as an
on-demand deep-dive, which in practice meant it never ran.

**It reports rather than gates, and that is deliberate.** Mythril's findings are
a function of its exploration budget: measured while wiring this up, at
`--execution-timeout 240` all three contracts come back clean, and at 300
`FareVault` additionally reports SWC-116 (block.timestamp control flow) inside
`withdrawFor` — which is the EIP-712 deadline doing exactly what a deadline
does, and which Mythril itself flags as compiler-generated code. A strict
pass/fail on "any finding" would therefore be red or green depending on how much
CPU the runner happened to get, and the first few false alarms would get the job
muted. So **high severity fails the build; everything else is reported and
uploaded**, and a run that cannot finish is a warning rather than a failure —
an infrastructure timeout is not a finding.

Two toolchain facts worth keeping, because both fail in ways that look like a
broken install rather than a config problem:

- **`setuptools<81` is required.** Mythril 0.24.8 pulls py-evm, which still
  imports `pkg_resources`; on setuptools 81+ every invocation dies at import
  time, before it reads a contract.
- **The solc settings must carry `viaIR` and `evmVersion: cancun`**, matching
  `hardhat.config.ts`. OpenZeppelin's `Bytes.sol` uses `mcopy`, so a default
  `evmVersion` fails to *compile* with "Function mcopy not found".

---

## 6. Function

✅ **D1 — Ops console component tests** (53 tests across five files). All four
consoles plus the shell, rendered.

**This required the decision C5 deferred**: the web tier had no DOM testing
dependency. It now has `jsdom` + `@testing-library/react`, applied *per file*
via `// @vitest-environment jsdom`, so the other 195 tests keep running in plain
node and pay nothing for it.

What component tests reach that C5's logic tests could not: **C5 proved the
model, this proves the operator sees it.** Every control in these consoles is
enabled by a boolean computed inside the component, and a wrong one is invisible
to `ruling.ts` or `govparams.ts` because it does not live there.

- **`PauseConsole` (100%)** — the fast-brake / slow-release split as *rendered*.
  A guardian can click Pause and **cannot** click Resume: an enabled Resume
  would promise a guardian something the registry refuses, during an incident.
- **`GovernanceConsole` (83%)** — [TEST-FINDINGS.md](TEST-FINDINGS.md) #13's
  regression, at the DOM. `toInt` returning `NaN` for a blank field is only half
  the fix; a component that computed the error and rendered `disabled={false}`
  anyway would pass every unit test and lose the protocol fee again. Also
  per-domain authority: owning `orders` must not unlock the vault's card.
- **`DisputesConsole` (59%)** — the escrow preview the arbiter signs against
  tracks the slider and keeps summing to the escrow, and the slash warning fires
  because `FareDrivers.slash` *clamps* rather than reverting.
- **`UpgradeConsole` (94%)** — `pauseRegistry` gets `register()` and never
  `upgradeContract()`, and re-registering the live address is **blocked**, not
  warned about: a no-op promotion burns a version bump and, with `freezeOld`,
  freezes the contract it just promoted.
- **`OpsApp` (88%)** — the shell that actually sets `busy`. Worth its own file
  because all four console suites assert "controls die while busy" while
  *passing `busy` in as a prop*; without this they describe a flag nobody sets.
  Also pins that `busy` is released after a **failure** (otherwise one revert
  locks the console until a reload) and that the receipt is awaited *before* the
  reload (otherwise the refresh reads pre-transaction state).

Web coverage 22.25% → **30.42%** of statements, and branches 14.35% → **28.39%**.

**One deliberate non-fix, recorded rather than changed:** `toInt` admits
`\d+(\.\d+)?` and truncates, so typing `1.5` into a bps field submits `1`. That
is what the source says today and the test pins it — but it sits awkwardly
beside #13's own rule that setting the fee to zero should take typing a zero. If
that reasoning holds, setting it to 1 should take typing 1. Left as a decision.

✅ **D2 — Client core units.** Six modules covered (71 tests):
`wallets.test.ts` (10), `zk.test.ts` (11), `token.test.ts` (10),
`chainglue.test.ts` (15), `relay.test.ts` (16), `router.test.ts` (9). Web
coverage 17.40% → **22.25%** of statements, with the floors raised twice to
match.

✅ **`wallets.ts` — 95%.** The burner registry is the customer's primary
protection, and its failure is silent: if two orders ever came from one address
nothing breaks, nothing errors, and the exact linkage the design exists to
prevent is permanent and public. So the first assertion is a **number** — mint
100, count distinct addresses and distinct keys — and the second is that every
stored key actually derives the address filed beside it, since a record where
those disagree is unrecoverable and only shows up later as an inexplicable
`not-customer` revert. The sweep's Paseo micro-PAS flooring, its gas reserve,
its refusal to sweep the main address into itself, and its per-wallet error
isolation are all pinned.

✅ **`zk.ts` — differentially, against the real circuit.** The expected values
come from `test/fixtures/zk-proximity.json`, the same real proof the contract
tier feeds to `FareLocationVerifier`. So the client's Poseidon and offsets are
checked against the circuit's own output rather than against themselves: the
drop commitment, driver commitment and nullifier are all reproduced exactly.
Also pinned: `positionCommit` uses a **three-input** hash rather than nested
pairs (both are plausible readings and only one matches), and the proof encoding
**swaps the G2 halves** — with a control proving the swapped and unswapped forms
are actually distinguishable for this proof.

✅ **`token.ts` — the 6-vs-18 decimal boundary**, where being wrong renders a
plausible number and escrows the wrong amount. Casing-insensitive stablecoin
resolution matters more than it looks: a case-sensitive compare falls through to
the unknown-token default of 18 decimals, i.e. a million-fold error.

✅ **`chain.ts`'s pure half** — the QR hand-off codec (including the plaintext
`pos` the ZK dropoff depends on, and its salt surviving as a *string* rather
than a rounded JSON number), the region cover, the salt, the formatters.

**This found a defect** ([TEST-FINDINGS.md](TEST-FINDINGS.md) #24):
`regionsCovering` returned **3,593,252 cells** within a degree of a pole, where
San Francisco gets 9 — the clamp that avoids a divide-by-zero produced an
898,313-cell longitude span, and `orderIdsInRegions` fires a `queryFilter` at
every one. The test announced it by hanging the suite. Capped at a half-turn of
longitude, which is definitional rather than a tuning choice.

✅ **`relay.ts` — the relay being *present*.** `degradation.test.ts` already
covered its absence; what was untested was the decline protocol. Three things
there are load-bearing and each fails quietly:

- **A 402 is a decline, not an error.** The relay's profitability guard refuses
  work it cannot afford; treating that as a failure strands the user instead of
  offering the direct path. A genuine 500, by contrast, must *not* raise the
  fallback prompt — training people to click through transport faults is how a
  real error gets ignored.
- **Refusing the prompt must submit nothing.** A fallback that fires anyway
  spends gas the user just declined to spend.
- **Bodies carry BigInts.** ZK public signals are bigints and `JSON.stringify`
  throws on them, so the replacer is the only reason a dropoff proof can be
  posted at all — pinned at 2²⁰⁰ so nothing is lost to scientific notation.

✅ **`chain.ts`'s runtime router resolution.** The shipped address book is a
*snapshot*; contracts move through the freeze-and-drain router, so a client
trusting its build-time addresses talks to a frozen v1 — stale reads, reverting
writes. Every failure mode of the sync is quiet, and all four are pinned: a
zero answer must **not** blank a live address (the router returns `address(0)`
for a name it does not know); an RPC failure at boot must fall back to the
shipped book rather than take the app down; a *failed* sync must retry while a
*successful* one must latch, or every render re-reads seven registry entries;
and a pre-router deployment must touch nothing. Plus log decoding, including the
block number the incremental scan resumes from.

**D2 is complete.** Web coverage 17.40% → **22.25%** of statements across the
two passes; `chain.ts` reached 53%, `relay.ts` 43%, `wallets.ts` 95%.

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

✅ **D4 — Local-chain full-lifecycle e2e** (`test/lifecycle-e2e.test.ts`,
12 tests). One delivery, end to end, per-PR. The live Paseo run stays as the
nightly (§7 E3).

**Not a duplicate of the phase suites, and the reason matters.** Every phase is
already tested — `privacy-e2e` (vault → keeper → note), `shieldnote-vault`,
`sealed-bids`, `shielded-payouts`, `leak-sweep` — and every one builds its *own*
fixture. That is right for testing a phase, and it is exactly what leaves the
gap: nothing asserted that one phase's real output is a valid input to the next.
So this is one continuous run where each stage consumes what the previous stage
actually produced, and the assertions are the **seams**:

- **The proof opens the commitment the *order* stored.** The public signal is
  read back off the chain, not from a local variable. This required generating
  the Groth16 proof live rather than replaying `test/fixtures/zk-proximity.json`
  — a canned proof carries a canned `dropCommit`, so the handoff would have been
  checked against a value the order never produced. Verified by the **real**
  `FareLocationVerifier`, not the mock.
- **The note is funded by settlement earnings**, not a fixture `credit()`. Every
  other suite starts the note story with a hand-placed balance, so until now
  nothing showed that a real delivery pays enough, in the right denomination, to
  be shielded at all.
- **The account that accepts is the account that ordered** — a burner-derivation
  bug would surface as a revert rather than a silent privacy loss.
- **Escrow in equals payouts out**, and the vault's closing balance equals what
  it still owes plus the shield buffer, summed over every holder including the
  crowd.

**The most instructive stage is the one that fails on purpose.** A complete,
correct delivery produces a note the contract *refuses to deposit*:
`shieldMinBatch` is 8, so sealing a batch of one reverts `batch-too-small`. B4
established that a lone note has an anonymity set of 1; this shows the chain
enforcing it, and that a single delivery cannot shield itself — it waits for
seven strangers. Only then does the note reach the pool, among 8.

Mutation-checked: proving against a commitment the order never stored fails five
tests; funding the note from a `credit()` instead of earnings fails the earnings
seam and everything downstream.

**Marked where a local chain cannot go.** The live script's shielded *funding*
(stage 1) and pool *withdrawal* (stage 9) are the Kusama Shield pool's own
Groth16 withdraw circuit — not FARE code — and `MockShieldPool` has no
`proxy_withdraw`. Mocking it would assert nothing about either system, so the
burner is funded plainly and the boundary is stated in the file. Shielded
**payout** is FARE code and is covered.

✅ **D5 — Order state machine** (`test/order-state-machine.test.ts`, 5 tests over
**104 cells** — 13 status-gated actions × 8 statuses). The invariant campaign
reaches some of these incidentally, but "eventually, on some seeds" is a
different claim from "never, on any path".

Both directions are asserted: no action succeeds from a status that does not
permit it (86 cells), and every action *is* permitted from each status it
declares legal (18) — the second half being what stops a contract that simply
reverted everything from satisfying the first.

What makes it more than a table:

- **Every call is valid apart from its status**, so a cell proves the *status*
  rejected it. Calling `cancelAssigned` as a stranger would pass on
  `not-customer` and prove nothing — the failure that makes most such matrices
  decorative, and the same problem C3 had to solve for authorization.
- **Statuses are reached through real transitions**, never by writing storage,
  so the rows test the machine rather than a fixture.
- **The table is checked against the contract source, twice**: every
  `bad-status` guard must appear in the table, *and* each action's declared
  legal set must equal the statuses its guard actually names. Widening a
  `require` to admit one more status is a one-word diff that no cell would
  otherwise notice — the new cell would simply stop being tested as illegal.

Mutation-checked, two ways against the contract: widening `cancelOpen` to accept
`Assigned` fails the matrix *and* the source comparison; deleting
`cancelAssigned`'s guard fails two tests. Branch coverage rose 75.45% → **77.53%**,
which is this suite reaching revert paths nothing else did.

**Two rows would have been vacuous, and only building them carefully showed it**
([TEST-FINDINGS.md](TEST-FINDINGS.md) #23) — `increaseTipERC20` on a native
order is refused by a token check before the status is ever read, and `Cancelled`
reached via `cancelOpen` leaves no driver, so `abandonOrder` answers on identity
instead. Which *path* reaches a status decides which guard replies.

---

## 7. Harness

This is the multiplier — it converts 281 existing tests from decorative to
load-bearing.

✅ **E1** — CI runs all three suites on every PR
(`.github/workflows/test.yml`). Validated against a clean checkout, which
caught that `test/shieldnote-vault.test.ts` needs proving artifacts that are
gitignored; the job restores them from the byte-identical tracked copies under
`web/public/shield/`.
✅ **E2 — Coverage, with committed floors on both tiers.** `npm run coverage`
(contracts) and `cd web && npm run coverage`. Both run per-PR.

| Tier | Statements | Branches | Functions | Lines |
|---|---|---|---|---|
| contracts | **95.26%** | 75.19% | 92.63% | **97.39%** |
| web (`src/**`) | **17.40%** | 10.69% | 13.84% | 18.72% |

Those two numbers describe the same repo, and the gap is the honest version of
§2's table: the contracts are thoroughly tested and the client is not.

**The web figure is the one that took work to make true.** v8 reports only the
files a test imported, which gave a comfortable-looking **47%** — with `App.tsx`,
the four console components and seven client-core modules simply absent from the
denominator. A floor on that number would have *risen* when someone added
untested code ([TEST-FINDINGS.md](TEST-FINDINGS.md) #22). Naming the sources
instead (`include: ["src/**/*.{ts,tsx}"]`) counts an untested file as the zero it
is, and 47% became 17%.

Floors are set one point under what was measured, to absorb run-to-run drift
without leaving slack — they exist to stop the number sliding, not to describe an
ambition. Vitest enforces its own (`web/vite.config.ts`); solidity-coverage has
no threshold option at all, so `scripts/ci/coverage-floor.mjs` reads the Istanbul
summary against the committed `coverage-floor.json`. Both were controlled: an
unreachable floor fails, and a missing summary reports why rather than passing
vacuously.

Two things the contract run needed:

- **`--max-old-space-size=6144`.** Instrumentation emits a marker per branch and
  the suite then exceeds node's 2 GB default, dying with "Reached heap limit"
  *partway through the report* — which looks like a hung run rather than an OOM.
- **The gas snapshot skips under coverage.** Instrumentation inflates gas far
  past A1's ±5% gate, so all 18 paths failed at once. The guard has to read
  `hre.__SOLIDITY_COVERAGE_RUNNING`: there is no `SOLIDITY_COVERAGE` env var to
  test, because the plugin *reads* one of that name rather than setting it, so
  the obvious guard is silently inert.

Mocks are excluded from the contract denominator — they exist to make the real
contracts testable, so counting them measures the scaffolding, and an unused mock
branch would read as a regression.

✅ **E3 — Nightly** (`.github/workflows/nightly.yml`, four jobs). The things too
slow, too expensive or too secret-dependent to run per-PR — and which stop being
real if nobody ever runs them.

| Job | Needs | What it does |
|---|---|---|
| `fuzz` | — | The invariant campaign at **50 seeds** |
| `mythril` | — | Symbolic execution over vault, orders, forwarder (C6) |
| `live-e2e` | `DEPLOYER_PRIVATE_KEY` | Full lifecycle against live Paseo |
| `cost-ledger` | `DEPLOYER_PRIVATE_KEY` | A3's live half, through three real relays |

**Failures here are not a merge gate** — nothing is blocked at 3am. They are a
signal, and every job uploads its reports so a red run can be read without
reproducing it.

Four things this needed that were not obvious:

- **The Paseo jobs skip rather than fail without the secret.** A workflow that is
  permanently red on a fork teaches people to ignore it. `secrets` cannot be read
  in a job-level `if`, so a tiny gate job lifts it into an output.
- **Every seed runs even after one fails.** The campaign's value is breadth; a
  loop that stops at the first failure hides how many of the 50 are broken. The
  failing seeds are collected and reported together, with the reproduce command
  for the first one — the invariant test reproduces from a printed seed.
- **Three relays had to become one command.** `measure-costs.mjs` needs them
  running, and "three terminals and a README" is precisely why the live ledger
  never ran unattended. `scripts/privacy/relay-lab.mjs` funds them, launches
  them, waits on `/health` (a relay that cannot reach the RPC binds its port and
  then fails every request, so an open port is not readiness), runs the
  measurement and tears them down.
- **The obvious artifact upload would have published private keys** —
  [TEST-FINDINGS.md](TEST-FINDINGS.md) #21.

🟡 **E4** — Gas and constraint snapshots committed and diffed. **The gas half is
done** (§3 A1: 18 paths in `gas-snapshot.json` behind a ±5% gate). The
**constraint** half is not: `proof-cost.json` (§3 A4) pins each circuit's served
artifact sizes and its `nPublic`, which is its ABI — but not its R1CS constraint
count, so a circuit change that leaves the interface alone and doubles the
proving work would pass. Cheap to add next to A4 (`snarkjs r1cs info`), and it is
what actually predicts proving time on a user's phone.

---

## 8. Priority

1. ✅ **E1 — wire CI.** Cheapest item here and it makes every other test real.
2. ✅ **C1 — relay endpoints.** Done across both tiers (49 tests): handler
   extraction, the no-chain surface, the authorization/replay matrix, and the
   shielded endpoints. Turned up a nonce-collision defect in the live relay,
   now fixed and regression-tested.
   ✅ **C2 — key custody.** Done (9 tests). Turned up two defects in the
   subsidy budget — it counted none of what `/fund` gives away, and it
   overshot under concurrency — both fixed, and the default window resized so
   the knob means "burners per window" ([TEST-FINDINGS.md](TEST-FINDINGS.md)
   #19, #20).
3. ✅ **B1 / B2 — leak sweep + positive controls.** Done (8 tests). The privacy claims are the
   product; today they are asserted per-test and never negatively controlled.
4. ✅ **A1 / A3 — gas snapshot + committed cost ledger.** Both done: 18 paths
   behind a ±5% gate, and a per-payer ledger shared by the local and live modes
   that pins who pays for each step of a delivery.
5. ✅ **C5 / D1 — ops consoles.** Done (29 tests); found and fixed a defect
   that set governance parameters to zero.
6. ✅ **C3 — access-control matrix.** Done (530 denial checks, self-maintaining).
   Then **D3**, then the remainder.
7. ✅ **E3 / C6 — the nightly.** Four jobs: 50 fuzz seeds, Mythril over the
   money-handling contracts, and the two Paseo runs (live e2e + the cost
   ledger) that skip cleanly without a deployer secret.

8. ✅ **E2 — coverage floors.** Both tiers, committed and enforced per-PR.
   The web number had to be corrected from 47% to 17% first
   ([TEST-FINDINGS.md](TEST-FINDINGS.md) #22).

**The harness is effectively done** — E1, E2 and E3 complete, E4 half complete
(gas pinned, circuit constraints not). From here every remaining item is
coverage of product code rather than plumbing.

9. ✅ **D4 — local-chain lifecycle e2e.** One delivery per-PR, asserting the
   seams between phases that per-phase fixtures cannot reach.

10. ✅ **D5 — order state machine.** 104 cells, both directions, checked
    against the contract source so the table cannot fall behind it.

11. ✅ **D2 — client core.** Six modules (71 tests), web coverage 17.40% →
    22.25%; found and fixed a polar blow-up in the region cover.

12. ✅ **D1 — ops consoles, rendered.** All four plus the shell (53 tests); web
    coverage 22.25% → 30.42%, branches 14.35% → 28.39%.

**What is left is `App.tsx`** — 2,689 lines, no tests, and now by far the single
largest reason the web floor sits at 30% rather than higher. The jsdom
dependency D1 added makes it reachable; it is a big enough job to be its own
item rather than a footnote. Also open: `shieldnote.ts` and `shield.ts` (~520
lines), **E4**'s circuit-constraint snapshot (small, worth doing alongside any
circuit work), **C4** behind the MPC ceremony, and **B3** as a decision rather
than a recommendation.

B3 is deliberately left as a decision rather than a recommendation: it is worth
adopting only if the privacy posture should be pinned by tests.

## See also

- [PRIVACY-STATUS.md](PRIVACY-STATUS.md) — what is actually protected today, by role
- [TEST-FINDINGS.md](TEST-FINDINGS.md) — what this work found, with status
- [SECURITY-REVIEW.md](SECURITY-REVIEW.md) — the Slither triage this extends
- [REMAINING-ACTIONS.md](REMAINING-ACTIONS.md) — E2/E3 mainnet gates, ops prerequisites
- [PRIVACY-TIERS.md](PRIVACY-TIERS.md) — the designs the §4 tests would pin
- [E2E-PRIVACY-LIVE.md](E2E-PRIVACY-LIVE.md) · [E2E-PRIVACY-ZK.md](E2E-PRIVACY-ZK.md) — the live runs the nightly would automate
