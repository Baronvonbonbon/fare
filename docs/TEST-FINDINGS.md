# FARE — Test Findings

Everything the [TEST-PLAN](TEST-PLAN.md) work surfaced, with status and the test
that pins it. Kept separate from the plan on purpose: the plan says what to
build, this says what building it found.

Ordered by what a reader should act on, not by discovery order.

---

## Summary

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | Relay reused transaction nonces under concurrency | **High** | ✅ Fixed |
| 13 | A cleared governance field silently wrote `0` on Save | **Medium** | ✅ Fixed |
| 14 | Ops docs required a faucet secret for a code path that no longer ran | Medium (docs) | ✅ Fixed |
| 19 | The subsidy budget did not count what `/fund` pays out | **Medium** | ✅ Fixed |
| 20 | Concurrent requests all passed the same budget check | Low | ✅ Fixed |
| 21 | The live runs write private keys where CI would have published them | **Medium** | ✅ Guarded |
| 22 | Web coverage read 47% because untested files were not counted | Medium (metric) | ✅ Fixed |
| 23 | Two state-matrix rows would have been refused before the guard they test | — | ✅ Fixed |
| 24 | `regionsCovering` returned 3.6M cells near a pole, hanging the tab | **Medium** | ✅ Fixed |
| 25 | New tests passed but broke `npm run build`, which CI gates on | Medium (process) | ✅ Fixed |
| 26 | Every order ticket was posted into the same relay slot, so any stranger could erase one | **Medium** | ✅ Fixed |
| 2 | `/fund` can double-fund inside a 250 ms window | Low → **Medium** once the relay went public | ✅ Fixed |
| 3 | Oversized request body returns 500, not 413 | Cosmetic | ✅ Fixed |
| 4 | CI ran nothing but Slither, path-filtered to `contracts/**` | **High** (process) | ✅ Fixed |
| 5 | `relay.mjs` could not be imported by a test | Medium (process) | ✅ Fixed |
| 6 | `PINE_RPC` silently overrides `RELAY_RPC_URL` | Low (footgun) | 🟡 Neutralized in tests |
| 7 | Tests need ZK artifacts that are gitignored | Medium (process) | ✅ Fixed |
| 8–11 | Four assertions that passed for the wrong reason | — | ✅ All fixed |
| 12 | `insertShieldNote` costs 730,615 gas | Informational | 📌 Pinned |
| 15 | The bps rebate cannot pay for a relay at any realistic fare | **Medium** (economics) | 📌 Quantified |
| 16 | Docs overstated the ZK anonymity set — buckets partition it | **Medium** (privacy claim) | ✅ Fixed |
| 17 | Client modules the hardhat tests import must have no relative imports | Low (footgun) | 📌 Documented |
| 18 | The relay's settlement gas limit was a hardcoded Paseo constant | Low (footgun) | ✅ Fixed |

---

## 1. The relay reused transaction nonces under concurrency — **fixed**

The relay picked each nonce with `getTransactionCount(relay, "latest")`. That
excludes a submitted-but-unmined transaction, and ethers caches the read for
~250 ms on top, so two submissions inside that window drew the **same nonce**
and the node rejected the second. `serialize()` ordered the sends but never gave
them distinct nonces.

On a chain with multi-second blocks this is not a narrow race: any two users
arriving together could trigger it, and at least one got a 500 — from the one
service whose entire job is submitting other people's transactions.

**Fixed** by allocating locally: seeded once at `"pending"`, handed out as
increments, dropped and re-seeded on failure so a send that never landed cannot
leave a gap that stalls everything behind it. Safe without a lock because every
allocation happens inside `serialize()`.

*Pinned by* `submits concurrent requests on distinct nonces` and `recovers its
nonce after a failed submission` (`test/relay-endpoints.test.ts`).
Mutation-checked: restoring the old one-line behaviour fails the first.

## 13. A cleared governance field silently wrote `0` — **fixed**

`GovernanceConsole`'s `toInt` was `Number(s.trim())` guarded by
`Number.isFinite`. `Number("")` is **0**, not `NaN`, so a blank field parsed as a
valid zero. Save stayed enabled and wrote it.

That was harmless for the fields with a non-zero floor — windows and radii
reject 0 on range — but silent for the five where zero is legal: `feeBps`,
`assignedCancelBps`, `relayRebateBps`, `withdrawFeeBps` and `unbondingSeconds`.
Clearing the protocol-fee box and pressing Save set the protocol fee to zero,
and the chain accepted it without complaint because 0 is a perfectly valid fee.
Nothing downstream could have caught it: the contract's job is to enforce
bounds, and 0 is in bounds.

The same parser also accepted `Number`'s other conveniences — `"0x10"` as 16 and
`"1e3"` as 1000 — in a field an operator types decimals into.

**Fixed** in `web/src/ops/govparams.ts`: `toInt` now requires a plain decimal and
returns `NaN` for anything else, blank included. Setting a fee to zero takes
typing a zero.

*Pinned by* `toInt refuses blank input instead of reading it as zero`
(`web/src/ops/govparams.test.ts`) and `a cleared field can no longer set a
parameter to zero` (`test/ops-governance.test.ts`), which also demonstrates the
chain *would* have taken the write.

## 14. The faucet ops step was stale — **fixed by deleting the faucet**

[REMAINING-ACTIONS.md](REMAINING-ACTIONS.md) §1 used to list, as a required
operational step (it no longer does — the entry is struck through there now):

> ☐ **Faucet secret** — set `DRIP_PRIVATE_KEY` (funded) in Cloudflare Pages env
> so `/api/drip` funds burners on demand (the "one manual secret step"). Without
> it, gas top-ups fall back to the public faucet.

Nothing called it. `web/src/chain.ts` exported `requestDrip` and
`web/functions/api/drip.ts` was deployed, but `requestDrip` had **zero
callers** — `relay.ts` `sponsorGas` says in its own comment that "the central
`/api/drip` faucet has been removed (KS-only funding)" and tries only the region
relay's `/fund`. `fundBurner` throws outright without shielded funding, by
design, so burners were never faucet-funded either.

**Operational note:** the drip account itself still exists and still holds
funds (100 PAS was sent to it from the deployer). Deleting the code does not
reclaim that — sweep it back to the deployer when convenient. Its key is in
`web/.dev.vars`, which is gitignored.

Two things follow. An operator provisioning a **funded private key** — a real
account with real value — is doing it for a path that never executes. And the
promised degradation ("falls back to the public faucet") describes behaviour
that no longer exists: with no relay, `sponsorGas` returns
`{ funded: false, reason: "no-faucet (KS-only funding)" }` and that is the end
of it.

**Resolved by deletion**, which matches the KS-only stance the code already
took: `web/functions/api/drip.ts`, `chain.ts`'s `requestDrip`, the
`DRIP_PRIVATE_KEY` entries in `web/.dev.vars.example`, and the ops step in
REMAINING-ACTIONS §1 are gone. `DEMO-LAUNCH.md`'s "add a funded drip account"
item is marked superseded — funding a burner from a shared account would re-link
it to whoever refilled that account, which is the thing C4 exists to prevent.

Deliberately kept: `DripResult` (the shape every funding path returns, including
the relay's `/fund` and the shielded withdrawal) and `DRIP_MIN` (the
low-gas threshold that drives the "Top up gas" button). `App.tsx`'s `maybeDrip`
also stays — despite the name it calls `sponsorGas`, i.e. the relay. Those names
are now archaeology and worth renaming, but that is a rename inside the largest
untested file in the repo, so it is a separate change.

*Surfaced by* the degradation matrix (`web/src/degradation.test.ts`), which
pins the behaviour that remains — `sponsorGas` declining with `no-faucet` — so
a faucet cannot quietly reappear as an unlinkability hole.

## 2. `/fund` can double-fund inside a 250 ms window — **open**

Ethers caches `eth_getBalance` and `eth_call` for ~250 ms as well. Two `/fund`
calls for the same address inside that window both observe a zero balance and
both pay out, so the "already funded" check is not authoritative under bursts.

Bounded by the rate limiter and the subsidy budget, so this is a small leak
rather than a drain — which is why it is recorded rather than patched alongside
finding 1. Fixing it means either a short-lived local record of funded addresses
or a cache-bypassing balance read.

Surfaced when the nonce fix let the relay tests drop their spacing; both relay
suites now space past it deliberately and say why.

## 3. Oversized request body returns 500, not 413 — **open**

`readJson` caps bodies at 256 KiB and throws; the handler's catch-all maps that
to 500. The `/msg` and `/photo` handlers do return a proper 413 for their own
smaller limits, so a client cannot distinguish "too big" from "relay broke".

Cosmetic, and a behavioural change rather than a test, so it was left alone. The
test asserts only that an error status comes back and the process survives —
deliberately not pinning the exact code, so fixing this will not fail the suite.

## 4. CI ran nothing but Slither — **fixed**

281 tests existed and passed; none of them ran unattended. The only workflow was
a Slither job path-filtered to `contracts/**` with `fail-on: none`, so a change
to `relay.mjs`, `web/src/`, or `venue-node/` triggered nothing at all.

**Fixed** by `.github/workflows/test.yml`: three parallel jobs, no path filter,
real gates. This was the cheapest item in the whole plan and the one that made
every other item load-bearing.

## 5. `relay.mjs` could not be imported by a test — **fixed**

It bound its port at import and called `process.exit` on a missing key, so
importing it from a test took the test process with it. The largest untested
surface in the repo was untestable by construction, and it holds a funded key.

**Fixed** with a 17-line change — both side effects gated on `IS_MAIN`, plus
exports — deliberately minimal because the file is deployed live. Full
dependency injection is still not done; config is read once at module scope, so
tests needing different settings re-import under a fresh query string.

## 6. `PINE_RPC` silently overrides `RELAY_RPC_URL` — **neutralized in tests**

`relay.mjs` prefers `PINE_RPC`, and `hardhat.config.ts` calls `dotenv.config()`.
A `PINE_RPC` in `.env` therefore wins over whatever a caller sets, and the relay
talks to a real node instead of the intended one. This cost real debugging time:
the first chain-backed relay run failed with "JsonRpcProvider failed to detect
network" while pointing at a working bridge.

The precedence is deliberate and documented, so it is not a bug — but it is
invisible at the point of use. Both relay suites now `delete process.env.PINE_RPC`
explicitly. Worth knowing before running the relay anywhere with a stale `.env`.

## 7. Tests need ZK artifacts that are gitignored — **fixed**

`test/shieldnote-vault.test.ts` proves against the real circuit and reads
`circuits/build/shieldnote.zkey` and `shieldnote_js/shieldnote.wasm`, both
gitignored as heavy regenerable intermediates. A clean checkout cannot run the
suite; rebuilding needs the circom binary and a powers-of-tau download.

Found by validating CI against an actual clean clone rather than the working
tree. **Fixed** in the workflow by restoring them from the byte-identical
tracked copies under `web/public/shield/` (verified by sha256), which
`scripts/setup-shieldnote.mjs` already writes for the PWA prover.

---

## 8–11. Four assertions that passed for the wrong reason

Grouped because they are one pattern, and the most transferable thing this work
produced. **Every one was caught by a control or a mutation, never by reading
the test.** A green assertion is evidence of nothing until you have watched it
go red for the right reason.

**8. A leak test that could not fail.** `venue-node/relay.test.mjs` asserted
`_pad` never lands in a stored message — but `_pad` is a body-level key with no
path into `msg`, so it passed against a deliberately broken relay too. Rewritten
to pin what is observable: padded and unpadded bodies behave identically, which
is the property the client's metadata defense actually depends on.

**9. A fixture that manufactured a leak.** The leak sweep's first run reported
the drop longitude escaping — it was the *venue's* published longitude, because
the fixture gave both the same value. Harmless, but the kind of false positive
that trains people to dismiss the tool.

**10. A sweep that polluted itself.** A leak sweep querying to the current head
would retroactively fail an earlier absence claim once a later control planted
the same secret. Fixed with an explicit `stop()` that freezes the window.

**11. A differential test that was vacuous on round numbers.** The arbiter
ruling preview was checked against the chain at five ratios — and passed against
a deliberately dust-losing implementation, because every escrow was a round PAS
amount, divisible by 10,000 many times over, so the split never truncated.
Fixed by giving each escrow odd wei. The unit tests caught the mutation; the
differential one did not, until the fixture was sharpened.

**A sharper version of the same lesson, from B6.** The batch-decorrelation
tests measured positional uniformity, mean correlation and fixed-point rate —
and a mutation replacing the shuffle with a random *rotation* passed all of
them, as did the pre-existing test. A rotation has identical **marginals** to a
fair shuffle. What it preserves is the **joint** distribution: one recovered
pairing unravels the whole batch. Measuring each item's behaviour on average
said nothing about the property that actually matters. Fixed by asserting
pairwise relative order and adjacency.

The habit worth keeping: after writing an assertion, break the thing it
describes and confirm it fails. Findings 1, 11, and the `/shield-withdraw`
context check were all confirmed this way.

---

## 12. Costs, now pinned

From `gas-snapshot.json` (18 paths, ±5% CI gate):

| Path | Gas | Note |
|---|---|---|
| `vault.insertShieldNote` | **730,615** | A depth-16 Poseidon tree insert — by a wide margin the most expensive path in the protocol: ~3.7× a `createOrder`, ~13× a `withdraw`. This is the per-payout price of the ZK privacy path and is worth weighing before assuming shielding scales. |
| `FareLocationVerifier.verifyProximity` | 305,627 | The Groth16 pairing check, measured alone so it moves independently of settlement. |
| `orders.createOrderERC20` | 256,597 | |
| `settlement.confirmPickup` / `confirmDropoffZK` | ~214,000 | `confirmDropoffZK` is against the mock verifier — settlement overhead only. |
| `orders.createOrder` | 196,833 | |
| `vault.withdraw` | 55,350 | |

Not yet measured: the shielded note **spend**, which needs a real Groth16 proof
against a live tree root (A1 follow-on).

## 15. The bps rebate cannot pay for a relay — **quantified**

Measured, not estimated: `gas-snapshot.json` at Paseo's 1000 gwei.

| | |
|---|---|
| Relayed gas per delivery (pickup + ZK dropoff incl. the real verify) | **0.7335 PAS** |
| Break-even fare on the `relayRebateBps=2000` rebate **alone** | **183.37 PAS** |
| Flat service fee that removes fare-dependence entirely | **0.9168 PAS / order** |
| Cash-out at which the 1% withdraw fee covers its own gas | **11.24 PAS** |

The rebate is `fare × feeBps × relayRebateBps / 1e8`, which at the deployed
250 / 2000 is **0.5% of the fare** — half a percent of one order, asked to cover
that order's entire gas. Break-even lands at 183 PAS, two orders of magnitude
above any real food delivery.

This is not new in kind — REMAINING-ACTIONS §1 already warned that "with real
(tiny) testnet fares the relay will decline settlement (rebate ≪ gas)". What is
new is the number, and what the number implies: **the flat service fee is not a
tuning knob, it is the mechanism.** A relay is viable because of F6-flat, not
because of the bps rebate, and it needs to be set to ≈0.92 PAS per order at
these gas prices. `relayRebateBps` is close to decorative by comparison.

Worth revisiting if gas prices move: the whole table is a function of the
snapshot, so re-running the suite after a gas change re-derives it.

*Pinned by* `venue-node/breakeven.test.mjs`, including an assertion that a
2 PAS fare does **not** cover — so a parameter change that alters this
conclusion fails the suite rather than passing quietly.

## 16. The ZK anonymity set was overstated — **fixed**

[PRIVACY-STATUS.md](PRIVACY-STATUS.md) claimed that with the ZK path "the
anonymity set is every unspent note in the tree, not a batch".

`bucket` is a **public signal** of a spend — `FareVault.depositShieldNoteZK`
passes it straight to `verifyShieldNote(proof, [root, nullifierHash, bucket,
ksCommitment])`, and the circuit takes it as a public input. So a 25 PAS spend
is publicly a 25 PAS spend, and hides only among the other unspent 25 PAS notes.
With three buckets deployed (1 / 5 / 25 PAS), the real set is a fraction of the
tree whenever more than one denomination is in use.

Measured in the test fixture: nine notes in the tree, and the lone 25 PAS note
has a set of **one**. Filling the 1 PAS bucket tenfold leaves it at one.

Not a code defect — the design is sound and the partitioning is inherent to
fixed denominations, which are themselves a privacy feature. The defect was in
the description, and a reader sizing their exposure off that sentence would have
over-estimated it by however much of the tree sits in other buckets.
`PRIVACY-STATUS.md` and `E2E-PRIVACY-ZK.md` now say "of the same bucket".

*Pinned by* `test/anonymity-set.test.ts`, which asserts the per-bucket counts
against the tree total, so the two cannot drift apart again.

## 17. A client module node imports cannot grow a relative import — **documented**

`test/privacy-e2e.test.ts` pulls the real `web/src/shieldpool.ts` through a
dynamic import so it tests the shipped path-derivation rather than a copy. Node
strips TypeScript types but does **not** resolve extensionless specifiers, so
the moment that module gained an `import … from "./gasbudget"` the whole hardhat
suite failed with `Cannot find module …/web/src/gasbudget`.

Hit while doing A5, and worth knowing because the failure is opaque: the error
names the imported file, not the importer, and it breaks tests that have nothing
to do with the change. The same constraint already blocked importing
`relaypick.ts` from the venue-node tier (its `./pool` import), which is why B5's
padding seam is pinned by field name on both sides instead.

Resolved by removing the need: `depositAndSnapshot`'s gas limit became a
**required** parameter rather than one defaulted from a constant, which suits
A5 anyway — every caller now budgets deliberately — and leaves `shieldpool.ts`
with no relative imports. A comment in the file says so.

## 18. The relay's settlement gas limit was a hardcoded Paseo constant — **fixed**

`relay.mjs` carried `const GAS_SETTLE = 500_000_000n`, which is right for Paseo —
it prices gas on a weight scale, so a settlement call genuinely needs a limit
that looks absurd on a normal EVM — and impossible anywhere else. Hardhat caps a
single transaction at 2^24 gas (~16.7 M), so **every** relayed settlement
reverted on the local chain before it reached a contract. The relay could not
settle in a test at all.

Found while building A3's local-chain half, and worth separating from the "500 M
is a Paseo number" point A5 already makes. A5 asserts that the constant never
leaks into `web/src`, and it still does not. This is the other half: the value is
correct *for one chain*, and it was written as though it were a property of the
protocol.

**Fixed** by making it configurable — `BigInt(process.env.RELAY_GAS_SETTLE ||
500_000_000)`. The default is unchanged, so nothing about the live deployment
moves; the comment now records why the number is what it is and why it has to be
overridable. `test/cost-ledger.test.ts` sets it to 15 M.

Two smaller versions of the same shape sit next to it and are *not* changed:
`GAS_FUND` (100 k, a plain transfer, valid on any EVM) and the `1000` gwei
fallback price. Neither blocks a test today.

## 19. The subsidy budget did not count what `/fund` pays out — **fixed**

The relay's defense against its own hot key being drained is a rolling window:
`RELAY_GAS_BUDGET_PAS` of no-reward spend per `RELAY_BUDGET_WINDOW_MS`, checked
before every unpaid action. `/fund` ends by recording `cost` — the *gas of a
plain transfer*. It never records `FUND_AMOUNT`, the 5 PAS it just sent.

`/onboard`, three handlers below it, gets this right, and says so in a comment:
`reserveBudget(cost + ONBOARD_SEED)` — "the seed itself is the subsidy, not just
gas". `/fund` is the same shape of action and counts only the postage.

Measured, at a deliberately tiny budget: **eight `/fund` calls moved 40.00018 PAS
against a declared 1 PAS/window budget**, and the window was still not
exhausted — because what it had counted was the 0.00018 PAS of gas. At the
deployed defaults (50 PAS budget, 5 PAS per burner) the budget permits on the
order of a *million* sponsorships per day, so it does not bound the faucet in any
practical sense.

What actually limits `/fund` today is the relay's own balance (503 → "operator
refill"), the per-address check that an address already holding gas is not
topped up, and the rate limiter. The first is a floor, not a budget: it stops
when the key is empty. The second is per-address and an attacker generates fresh
addresses. That leaves the rate limiter, which is keyed per caller
(20/window by default) and compounds with #2 — two `/fund` calls for the same
address inside ethers' 250 ms read cache both observe a zero balance and both
pay out.

**Fixed** in one line — `reserveBudget(cost + FUND_AMOUNT)` — plus the resizing
that has to come with it. Counting the payout would have made the old 50 PAS
budget mean **10 sponsored burners per window** instead of effectively unlimited,
quietly throttling the running demo, so the default moved to **250 PAS = 50
burners/day** at `FUND_AMOUNT_PAS=5`. `.env.example` moved with it.

The resizing is the point, not a workaround. A budget that counted only gas could
not be reasoned about at all — 50 PAS of *gas* is on the order of a million
sponsorships. Now the knob means "burners per window", which is a quantity an
operator can actually choose, and the number in the file finally says what the
relay will do.

That makes the two defaults a pair, so they are pinned as one: the budget must be
a whole multiple of `FUND_AMOUNT_PAS`, that multiple must be plausible, and
`.env.example` must not disagree with the code. Changing either literal alone now
fails rather than silently rescaling sponsorship capacity — the same drift A5 was
written about.

*Pinned by* `bounds what /fund pays out, not just the gas to pay it` and `the
default budget and the default sponsorship still agree`
(`test/relay-custody.test.ts`). The first spends a 22 PAS window on exactly four
5 PAS burners and requires the fifth to be declined 402. Mutation-checked:
restoring `reserveBudget(cost)` fails it and nothing else; a default that is not
a whole number of sponsorships fails the second and nothing else.

**What this does not fix** is #2 — two `/fund` calls for the same address inside
ethers' 250 ms read cache still both observe a zero balance. Each now consumes
its own reservation, so the window bounds the total damage, but the
"already funded" check remains non-authoritative under bursts.

## 20. Concurrent requests all passed the same budget check — **fixed**

Every guarded handler checked the window, awaited its submission, and recorded
the spend afterwards. Between the check and the record sits an `await`, so every
request already in flight tested against the same pre-spend total and every one
of them passed.

Measured: **three concurrent `/onboard` calls all seeded against a 3 PAS budget
that fits one**, spending 6 PAS — a 2× overshoot of a window that had been
verified to hold perfectly when the same three requests arrived one at a time.

Not a drain: the overshoot is bounded by how many requests are in flight
together, and everything arriving after the first record sees the real total. A
leak rather than a hole. But it is the kind that widens exactly when the relay is
busiest, and the budget is the only thing standing between a hot key and an
unrewarded endpoint.

**Fixed** by reserving instead of recording. `reserveBudget(wei)` checks the
window and takes the reservation in one synchronous step — no lock needed, since
the check and the `+=` are adjacent with no await between them — and returns a
`release()` for the caller to invoke if the send never lands, so a failed
submission cannot permanently consume a window. All nine guarded handlers
(`/fund`, `/onboard`, `/submit`, `/forward`, `/shield-queue`, `/commit-bid`,
`/shield-note`, `/shield-note-spend`, `/shield-withdraw`) now hold rather than
record; `budgetRoom`/`recordBudget` are gone.

The release path is the risk the fix introduces — a reservation that is never
returned would deny service without spending anything — so it is tested
directly, by leaving the relay exactly `ONBOARD_SEED` (past the balance floor,
short of seed + gas) to force a rejected submission.

*Pinned by* `holds the budget when requests arrive together` and `gives the
reservation back when the submission never lands`. Mutation-checked: deferring
the reservation past the send fails the first and nothing else; dropping the
refund in `release()` fails the second and nothing else.

## 21. The live runs write private keys where CI would have published them — **guarded**

Caught while wiring E3's nightly, before it shipped, which is the only reason
this is a note and not an incident.

The live scripts write their working state under `e2e-runs/`, and some of it is
key material: `live-order-e2e.mjs` writes `actors.json` containing the
customer's and driver's **private keys**, the relay lab writes `relays.json`
with three funded relay keys, and the note files carry nullifiers and salts —
values whose entire purpose is that nobody else has them. The directory is
gitignored, so nothing had ever pushed it anywhere.

A nightly changes that. The obvious way to keep a failed run's evidence is
`upload-artifact` with `path: e2e-runs/`, and **artifacts on a public repository
are downloadable by anyone**. The gitignore that makes the directory safe in git
does nothing in CI.

**Guarded** two ways. The uploads are allowlists — `report.json` and
`costs.json`, never a directory — and `scripts/ci/artifact-guard.mjs` checks
those files before they go, failing the step if any carries key material.

The guard keys on **field names**, not value shapes, and that is the interesting
part: a private key and a transaction hash are both 32 bytes of hex, and these
reports are full of legitimate hashes, roots and commitments. A value-shaped
matcher would either cry wolf on every report or be tuned down until it saw
nothing. What the writers actually do is *name* the field.

It also runs a positive control on every invocation, B2's lesson applied to the
thing that decides what leaves the build: zero findings is the healthy state and
is indistinguishable from a broken walker, so before trusting a clean sweep it
plants four secrets and requires all four caught. **That control immediately
earned its keep** — it failed on first run and exposed two defects in the guard:
`PRIVATE_KEY` was missed because the pattern had no separator class and only
matched `privateKey`, and the expected-count assertion was too strict to survive
a file tripping both matchers.

One deliberate exclusion: `nullifierHash` is **not** treated as secret. The hash
is a public signal — the vault publishes it to prevent a double-spend — while
the bare `nullifier` is its secret preimage. Flagging the published one would
block every legitimate ZK report, which is how a guard gets switched off. Both
cases are in the control.

## 22. Web coverage read 47% because untested files were not counted — **fixed**

The first `vitest run --coverage` reported **47.45% of statements** for
`web/src`, which would have been a reasonable-sounding floor to commit.

It was measuring the wrong set. v8 instruments what the test run *loads*, so the
denominator held only files some test had imported. `App.tsx` — 2,689 lines, no
tests, the largest file in the repo — was not in it. Neither were the four
console components, nor `wallets.ts`, `token.ts`, `shieldnote.ts`, `pricing.ts`,
`qr.tsx`, `map.tsx`, `tilemap.tsx`, `notify.ts` or `photoflow.ts`.

**The failure mode is the interesting part: the metric moves the wrong way.**
Adding a new module with no tests does not lower that percentage — it leaves it
untouched, because an unimported file is not counted at all. Deleting a
well-tested module *lowers* it. A floor set on that number would have ratcheted
in a direction unrelated to whether the code was tested, and it would have
looked healthy the whole time.

**Fixed** by naming the sources instead of letting the run discover them —
`include: ["src/**/*.{ts,tsx}"]` in `web/vite.config.ts` — so a file with no
tests counts as the zero it is. The honest figure is **17.40%**, and that is what
the floor is set against.

The contract tier never had this problem: solidity-coverage instruments every
contract it compiles, whether or not a test touches it.

No equivalent bug, but worth recording next to it: `hardhat coverage` needs
`--max-old-space-size=6144`, because instrumentation emits a marker per branch
and the suite then exceeds node's 2 GB default and dies with "Reached heap
limit" *partway through printing the report* — which reads as a hang rather
than an OOM.

## 23. Two state-matrix rows would have been refused before the guard they test — **fixed**

The seventh and eighth instances of the #8–11 pattern, from D5. Both were caught
by the matrix reporting the *reason* each cell was refused rather than only that
it was — which is the whole trick, and the reason it is worth the extra code.

**A row refused by an earlier check tests nothing.** `increaseTipERC20` checks
`o.token != address(0)` **before** the status. Driven against a native order —
the obvious fixture, and what every other row uses — all eight of its cells come
back `use-native-tip`. Every one "passes", and the row asserts nothing whatever
about the state machine. Fixed by driving that row against a stablecoin order,
so the token check passes and the status guard is actually reached.

**Which path reaches a status decides which guard answers.** `Cancelled` is
reachable two ways: `cancelOpen` from Open, or `cancelAssigned` from Assigned.
They produce the same status and a very different order — cancelling an *open*
order leaves `o.driver` as the zero address, so `abandonOrder` is then refused on
`not-driver` rather than on status, and that cell quietly stops testing the
transition. Fixed by reaching `Cancelled` through `cancelAssigned`, so the order
retains a driver and the status guard is what replies.

One genuine earlier-guard case survives and is asserted as itself rather than
excused: in `Open` there is no driver *at all*, so `abandonOrder` is refused on
identity by construction. That is the honest answer to "can a driver abandon an
unassigned order", so the cell pins that exact reason. The distinction being
drawn throughout is between a guard that legitimately precedes and a fixture
that accidentally hides the one under test.

## 24. `regionsCovering` returned 3.6 million cells near a pole — **fixed**

The driver board asks `regionsCovering(center, radiusKm)` for the grid cells to
query, then `orderIdsInRegions` fires a `queryFilter` at **every one of them**
inside a `Promise.all`.

Longitude degrees narrow towards the poles, so a fixed kilometre radius spans
more of them the further north you go. The code already guarded the obvious
hazard — `Math.max(cos(lat), 1e-6)` stops a divide by zero at 90° — and that
guard is exactly what produced the defect: instead of infinity, it yields a
longitude span of **898,313 cells**.

Measured, for a 25 km radius:

| Latitude | Cells |
|---|---|
| 37.77°N (San Francisco) | 9 |
| 80°N | 28 |
| 89°N | 212 |
| **90°N** | **3,593,252** |

So the failure is not a crash. It is ~3.6 million keccak256 calls to build the
list, and then several million concurrent RPC calls behind it — a hung tab, and
a node the client is now hammering. It also degrades smoothly enough (212 cells
at 89°) that nothing looks wrong until it is very wrong.

**Found by writing the test, and it announced itself the hard way:** the vitest
run stopped returning. The case was written as "survives the poles without
dividing by zero", expecting to confirm the existing clamp; what it confirmed
was that surviving the division is not the same as surviving the result.

**Fixed** by capping the longitude half-span at 180,000,000 µdeg. That is not a
tuning constant: beyond ±180° the cover has wrapped the globe and is re-listing
cells it already holds, so any larger value is meaningless by definition. The
polar case becomes **2,892** cells and San Francisco stays at 9.

Reachability is low — it needs |latitude| within about a degree of a pole, which
means a GPS glitch or an unvalidated coordinate rather than a real user. That is
why this is Medium and not High. But the cost of the bad path was unbounded, and
the fix costs one `Math.min`.

*Pinned by* `stays bounded at the poles instead of covering the planet twice`
(`web/src/chainglue.test.ts`), which asserts a ceiling at ±89°/±90° **and** that
the ordinary case did not get coarser. Note the mutation evidence here is a hang
rather than a clean red: reverting the cap makes the test time out, which is a
failure but an ugly one.

## 25. New tests passed but broke `npm run build` — **fixed**

Self-inflicted, and worth recording because the shape recurs.

The web CI job runs three things: `vitest run --coverage`, then `npm run build`,
which is `tsc -b && vite build`. `tsc -b` typechecks **everything under `src/`,
including test files**. So a test can pass under vitest — which transpiles
without typechecking — and still fail the build.

D2 shipped four test files that did exactly that. `vitest run` was green,
coverage was green, and I did not run the build; the breakage sat in two
commits before the D1 pass surfaced it. Roughly fifty errors, all of them
ordinary type sloppiness in test code:

- a `props()` helper whose `after` parameter was **narrower** than the `Run`
  type it had to satisfy (contravariance — about forty of the fifty);
- chai's numeric matchers are typed `number | Date`, so `.to.be.lessThan(aBigInt)`
  does not compile even though it runs perfectly;
- `vi.fn(() => true)` infers the literal type `true`, so a later reassignment to
  `false` is a type error;
- a mock declared with no parameters, later given an implementation that takes
  one.

**Fixed** by correcting the types rather than excluding tests from the build.
Excluding them is the tempting one-line alternative and it is worse: these files
are the only consumers of `ConsoleProps` and `Run` outside the components
themselves, so typechecking them is what catches a prop contract drifting.

**The lesson is about the command, not the types.** "The tests pass" is not the
same claim as "the tier passes", whenever a tier's CI job runs more than its
test runner. Run what CI runs.

---

## 26. Every order ticket was posted into the same relay slot — **fixed**

Found by writing the tests for the send/receive half of `ticket.ts`, which the
kitchen work had shipped uncovered.

The relay's message identity is `(from, seq, kind)` and a repost **replaces** —
that is the idempotent-retry contract in `functions/api/msg.ts`. `postTicket`
posted every ticket as `from: ""` (anonymous by design, correctly) and
`seq: 0` (hardcoded). So all three fields were constant per order: an order's
thread had exactly **one** ticket slot, and the last writer won it.

Two consequences, neither visible from the ticket suite as it stood:

- **The open mailbox stopped being safe.** `fetchTicket` is written for a
  mailbox anyone can post to, and its comment says so: a hostile ticket "won't
  decrypt", so it is harmless. That reasoning holds only if hostile tickets are
  *added alongside* the real one. Under replacement, anyone who knew the topic
  could overwrite the real ticket with noise; the venue then decrypts nothing,
  `fetchTicket` returns `null`, and the kitchen has no idea what to cook. A
  denial of service on the food, from an unauthenticated stranger.
- **The selection logic was unreachable.** `fetchTicket` loops over tickets,
  returns a `bound` one outright, and otherwise keeps the latest so "a re-send
  supersedes". None of that could ever run against the real relay, because the
  list it iterates could not hold more than one entry. A legitimate re-send —
  the customer amending an order — also silently replaced rather than
  superseding, which happens to look the same and is not.

**Fixed** by deriving `seq` from the ciphertext (`ticketSeq`). Distinct tickets
now append; a genuine retry of the *same* ticket still collapses onto itself, so
the endpoint's idempotency is preserved rather than traded away. `from` stays
`""` — the anonymity is the point of it.

Pinned by `channel.test.ts` → "a second ticket appends rather than erasing the
first" (fails against the old `seq: 0`) and "but a retry of the same ticket
collapses onto itself".

**The lesson is about what a mock is allowed to be convenient about.** The
in-memory relay in `channel.test.ts` already reproduced the `(from, seq, kind)`
dedupe faithfully, which is the only reason the regression test could fail
honestly. A mock that had just appended — the obvious simplification — would
have made the broken code pass and the fix look like a no-op.

Untouched and still true: an attacker can flood a thread to the `THREAD_MAX`
200-envelope cap and push a real ticket out. That is a property of the channel,
not of tickets, and it costs the attacker 200 posts instead of one.

---

## What was checked and found correct

Worth recording, because "we looked and it held" is a result:

- **The arbiter's escrow preview matches the chain to the wei**, including the
  driver-takes-the-remainder form that keeps the two sides summing to the escrow
  exactly. Differential-tested against `FareOrders.resolveDisputed`.
- **Every governance bound the console duplicates matches its contract**, probed
  on both sides of every boundary in `setParams` and `setGeoParams`. The console
  is neither stricter (which would make a legal setting unreachable) nor looser
  (which would turn a warning into a revert). Mutation-checked: widening
  `FEE_BPS_MAX` to 2000 fails the comparison at 1001.
- **The pause console's authority model matches `FarePauseRegistry`**: a
  guardian can pause but not unpause, the owner can do both, a stranger neither,
  and the four listed categories are exactly the four the registry accepts.
- **The upgrade console's router keys resolve to the entries `scripts/deploy.ts`
  registers**, and its `upgradable` flag matches which entries the router will
  actually accept `upgradeContract` for — `pauseRegistry` is not `FareUpgradable`
  and correctly gets `register()` instead. A drift in either would not error; it
  would silently address a different registry slot.
- **All 60 gated functions reject all 10 roles that should not hold them** —
  530 checks, each matched against the specific authorization error rather than
  merely "it reverted". No missing modifier, no over-restriction. The table is
  checked for completeness against the contracts, so it cannot fall behind them.
- **Contract-level authorization holds** on `withdrawFor` (signature bound to the
  account, unsigned recipients rejected, replays rejected), `/forward` (target
  allowlist, no value, no forged sender), and `insertShieldNoteFor` (a relay
  cannot substitute a commitment the payee never signed).
- **The privacy claims hold under a whole-lifecycle sweep**: no drop coordinate
  in any encoding, no drop salt, no exact pickup position, and no losing bidder
  or bid amount — each with a control proving the sweep could have seen them.
- **`/shield-queue` never puts the account and its commitment in one
  transaction**, asserted against real calldata (PRIVACY-TIERS §3), and releases
  a held commitment when the chain rejects the authorization — without which
  that commitment would 409 forever and the payout would be silently lost.
- **A whole delivery holds together across its seams.** Driven end to end on a
  local chain (`test/lifecycle-e2e.test.ts`), each stage consuming the previous
  stage's real output: the Groth16 proof opens the commitment the *order* stored
  (read back off the chain, verified by the real verifier), the driver's note is
  funded by settlement *earnings* rather than a fixture credit, the account that
  accepts is the account that ordered, and escrow in equals payouts out with the
  vault's closing balance equal to what it still owes plus the shield buffer.
- **A single delivery cannot shield itself, and the chain says so.** `shieldMinBatch`
  is 8, so a correct delivery produces a note whose batch is *refused*
  (`batch-too-small`) until seven other payouts join it. #16 corrected the claim
  about how large the anonymity set is; this is the complementary fact that the
  contract will not let it be 1 in the first place — worth knowing as an
  operational property, since an early or quiet deployment leaves earnings
  queued rather than shielded.

## See also

- [TEST-PLAN.md](TEST-PLAN.md) — the plan these came out of, and what remains
- [SECURITY-REVIEW.md](SECURITY-REVIEW.md) — the Slither triage
- [PRIVACY-STATUS.md](PRIVACY-STATUS.md) — what is protected, by role
