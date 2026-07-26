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
| 2 | `/fund` can double-fund inside a 250 ms window | Low | ☐ Open |
| 3 | Oversized request body returns 500, not 413 | Cosmetic | ☐ Open |
| 4 | CI ran nothing but Slither, path-filtered to `contracts/**` | **High** (process) | ✅ Fixed |
| 5 | `relay.mjs` could not be imported by a test | Medium (process) | ✅ Fixed |
| 6 | `PINE_RPC` silently overrides `RELAY_RPC_URL` | Low (footgun) | 🟡 Neutralized in tests |
| 7 | Tests need ZK artifacts that are gitignored | Medium (process) | ✅ Fixed |
| 8–11 | Four assertions that passed for the wrong reason | — | ✅ All fixed |
| 12 | `insertShieldNote` costs 730,615 gas | Informational | 📌 Pinned |

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

## See also

- [TEST-PLAN.md](TEST-PLAN.md) — the plan these came out of, and what remains
- [SECURITY-REVIEW.md](SECURITY-REVIEW.md) — the Slither triage
- [PRIVACY-STATUS.md](PRIVACY-STATUS.md) — what is protected, by role
