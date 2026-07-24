# Relay treasury — fee coverage + auto fee-recovery swaps (Hydration/XCM)

## The finding: the gasless-order test did NOT confirm the fee covers gas

Two reasons:

1. **The e2e bypassed the guard.** `scripts/e2e-gasless.mjs` submitted the
   forwarded order + settlement **directly from the relay wallet**, not through
   the venue-node's `/forward` + `/submit` endpoints — so `economics.mjs`'s
   profitability guard never ran.
2. **Currency mismatch — the guard couldn't have decided anyway.** For a **token**
   order the F6 rebate is paid in the **order token** (USDC, 6-dp) while gas is
   spent in **native** (PAS, 18-dp). The old `coversCost(reward, cost)` compared
   them as one unit. Concretely, that order:
   - relay **spent** ~**0.088 PAS** gas (create 38 794 + accept 6 930 + pickup
     16 106 + dropoff 25 791, at 1000 gwei),
   - relay **earned** **0.01875 USDC** (F6 rebate at the raised `relayRebateBps`),

   and whether the second covers the first depends entirely on the **PAS↔USDC
   price**. At, say, 1 USDC = 0.5 PAS the rebate is 0.009375 PAS — it does **not**
   cover 0.088 PAS. **So no, coverage is not confirmed; it's a price question.**

This is exactly why the relay earning USDC but burning PAS needs a **swap**: its
native balance only ever drops. The swap closes the loop, and the swap *quote* is
the price the guard needs.

## Fix 1 — currency-aware profitability guard (shipped)

`economics.tokenToNativeWei(tokenWei, tokenDecimals, nativeDecimals, priceNum,
priceDen)` values a token amount in native wei (pure integer math). The relay's
`rebateForOrder` now:

- native order → rebate is already native, unchanged;
- **token order → rebate valued in native** via the price
  (`RELAY_TOKEN_PRICE`, or a live Hydration quote), then compared to native gas;
- **no price → returns `null` → the guard DECLINES** the settlement (it cannot
  prove the fee covers gas) rather than guessing.

So the relay now correctly refuses to settle a token order at a loss, and
`relayRebateBps` can be sized against real gas at the real price. Unit-tested
(`economics.test.mjs`, `treasury.test.mjs`; 27 pass).

## Fix 2 — auto fee-recovery swaps (venue-node/treasury.mjs)

When native gas dips below a floor, swap accrued **token fees → native** so the
relay refuels itself. Design + pure logic shipped (`shouldTopUp`, `planSwap`,
`priceFraction`, `topUpCycle` — tested); live execution gated.

**Target (verified reachable):**
- **Hydration Paseo testnet** — `wss://paseo-rpc.play.hydration.cloud`.
- **Paraspell XCM Router** — supports **Paseo + Hydration** swaps (Polkadot/
  Kusama/Paseo/Westend; 8 DEXes, testnet-capable).
- **Asset Hub EVM XCM precompile** — Asset Hub pallet-revive exposes XCM-category
  precompiles, so the relay's **existing EVM key** can `send` the swap XCM (the
  chosen signer model — no separate substrate key). Paraspell builds the route/
  quote; the precompile submits.

**Flow:** relay gas < floor → withdraw accrued token fees → Paraspell quote
(USDC→native, also feeds Fix 1's price) → `planSwap` (reach target, keep a native
reserve for XCM fees, skip dust) → XCM: Asset Hub → Hydration omnipool swap →
back to the relay on Asset Hub.

### The one hard prerequisite (why it's not live yet)

**The fee token must be a real Asset Hub *asset*** (pallet-assets, seen from EVM
via its ERC-20 precompile) to be **XCM-transferable**. Our accepted stablecoin is
an **EVM-only MockUSDC** — it **cannot** be XCM'd to Hydration. So on Paseo the
live swap needs the accepted stablecoin swapped to a genuine Asset Hub asset
(e.g. the Paseo USDC/USDT asset via its precompile). Until then, `executeSwap`
throws an explicit error (it never silently no-ops moving money), the pricing +
planning run and are tested, and `RELAY_TOKEN_PRICE` feeds the guard.

**Progress (2026-07-24):** real Asset Hub USDC (**asset 1337**, ERC-20 precompile
`0x0000053900000000000000000000000001200000`, 6-dp) is **accepted** as a FARE
escrow token on the upgraded orders — it exists on Passet Hub (~250M supply) and,
being a real pallet-assets asset, is **XCM-transferable** (unlike MockUSDC). USDt
(asset 1984) `0x000007C000000000000000000000000001200000` is also present. Two
caveats found: (a) the precompile is a **bare IERC20 — no `permit()`** even on
mainnet, so real-asset gasless orders use the **approve path**, not
`createOrderERC20WithPermit`; (b) **no open faucet** on Passet Hub (deployer
balance 0) — sourcing a balance needs the Hydration Discord faucet (`/drip`, on
Hydration's testnet) or a PAS→stablecoin swap. `scripts/hydration-swap.mjs` is the
test script for the latter (Paraspell XCM Router; quote mode is read-only, swap
mode needs a funded substrate sr25519 signer). Note: Paraspell's Hydration
exchange needs `@galacticcouncil/api-augment` + deduped `@polkadot/types`.

**To go live:** (1) accept a real Asset Hub asset as the FARE stablecoin;
(2) `npm i @paraspell/xcm-router` (+ its Wasm/augment deps) in `venue-node`;
(3) verify the Asset Hub XCM-precompile interface + wire `executeSwap` to build
via Paraspell and submit via the precompile from the relay account; (4) set
`SWAP_ENABLED=on` + the gas thresholds.

## Better path found: swap LOCALLY on Asset Hub's native DEX (no XCM)

Investigating "run the swap through Paseo" surfaced a simpler answer than the
Hydration/XCM round-trip:

- **FARE's chain (chainId 420420417) IS Paseo Asset Hub** — Paraspell's
  `AssetHubPaseo` (by mid-2026 Paseo Asset Hub runs pallet-revive; the earlier
  "Passet Hub is a separate isolated chain" worry was wrong). So it's a fully
  XCM-/DEX-routable chain, not an island.
- **Paseo Asset Hub has a NATIVE DEX** — Paraspell lists `AssetHubPaseoDex` (the
  `asset-conversion` pallet). So **PAS ↔ USDC can swap on FARE's own chain, with
  no XCM, no Hydration, and no mod-gated Discord.** This is the cleanest
  fee-recovery *and* balance-sourcing path, and it's the mainnet answer too
  (Polkadot Asset Hub has `asset-conversion`).
- **The XCM precompile** (for the cross-chain fallback) is at
  `0x00000000000000000000000000000000000a0000` — `execute(bytes,Weight)` /
  `send(bytes,bytes)` / `weighMessage(bytes)`, SCALE-encoded messages.
- **The Paseo faucet is OPEN** (Matrix/web, per-parachain target) — unlike
  Hydration's Discord `/drip` (mod-gated). It funds PAS, which the local DEX then
  swaps to USDC.

**Recommended pivot:** target the **local `asset-conversion` DEX** for PAS↔USDC
instead of Hydration/XCM. Two things to confirm/build: (1) a PAS↔USDC pool with
liquidity on the Paseo AH `asset-conversion` DEX (Paraspell's live calls hang on
testnet RPC — query the pallet directly with polkadot-api, or the DEX precompile
if one is exposed); (2) execution — an `asset-conversion` precompile callable from
the EVM relay (local swap, no XCM precompile needed) if it exists, else a
Paseo-faucet-funded substrate signer. `scripts/hydration-swap.mjs` keeps the
Hydration route as the cross-chain fallback (identifiers: `AssetHubPaseo`,
exchange `HydrationDex`; needs `@galacticcouncil/api-augment` + a `@polkadot/types`
dedupe, and the Hydration testnet RPC is flaky).

## Sufficient assets + the local DEX — VALIDATED on-chain (2026-07-24)

Queried Paseo Asset Hub directly (`@polkadot/api`, WSS `asset-hub-paseo-rpc.n.dwellir.com`):

- **USDC (1337) and USDt (1984) are `isSufficient = true`** (minBalance 0.07). A
  sufficient asset can **instantiate an account and (via `asset-conversion`) pay
  fees with no native token**. → a FARE burner can hold **only USDC**, no PAS ED.
- **PAS↔USDC and PAS↔USDt pools exist** on the native `asset-conversion` DEX
  (lpTokens 9 and 5 of 20 pools). `quotePriceExactTokensForTokens` returns a live
  price: **1 USDC = 0.2496 PAS** (1 PAS = 3.98 USDC; PAS is 10-dp on substrate).
  Wired as `treasury.assetConversionQuote(assetId)` — the recommended price source
  (replaces the flaky Hydration quote), read-only, no signer.

### Coverage verdict — at the REAL price, the current fee does NOT cover gas
The gasless order: relay spent ~0.088 PAS gas (≈ **0.35 USDC**) and earned
**0.01875 USDC** (5000-bps rebate on the tiny fare). So the fee covers **~5% of
gas** — the relay is deeply underwater on small orders. A percentage rebate on a
sub-dollar fare can't cover a fixed-ish gas cost. **Fix the fee model**, not just
the price: a **flat/minimum relay fee** per order (in USDC), or eliminate the
relay-gas problem entirely (next point).

### SETTLED (2026-07-24): EVM fee-in-asset is NOT available — probed on-chain
Probed the live runtime (`asset-hub-paseo` spec 2004002, PAS 10-dp, EVM =
`Revive`) directly (`@polkadot/api` metadata + storage). The hoped-for
simplification — burner pays its own gas in USDC, drop the relay — is **blocked**,
for two independent reasons:

1. **`eth_transact` structurally can't select a fee asset.**
   `revive.ethTransact(payload: Bytes)` wraps a raw Ethereum `TransactionSigned`;
   the runtime rebuilds a `CheckedExtrinsic` by recovering the ECDSA signer. An
   Ethereum tx has **no `assetId` field**, so the fee-asset selector is always
   `None` → **fees settle in native PAS**. `ethCall`/`ethInstantiateWithCode`
   confirm it: their params are `effectiveGasPrice`/`ethGasLimit`/`value` — pure
   Ethereum gas semantics, native only. There is nowhere to say "charge me in USDC".
2. **The substrate fee-in-asset path is present but unconfigured.** Signed-extension
   pipeline is `era, nonce, tip, assetId, mode` — the `assetId` is
   `pallet-asset-tx-payment`'s `ChargeAssetTxPayment`, and `AssetTxPayment` is
   present. BUT this runtime uses the **`AssetRate`-driven** variant (not the
   pool-based `AssetConversionTxPayment`, which is **absent**), and
   **`AssetRate.conversionRateToNative` has ZERO entries** — so no asset (not USDC,
   not USDt) is accepted for fees even from a native signer today.

⇒ The fee-in-asset selector, even if it were configured, only rides on native
substrate extrinsics — never on `eth_transact`. **The relay/forwarder stays
required for gasless EVM.** Confirmed, not inferred.

**What sufficiency still buys (take it):** USDC(1337)/USDt(1984) reconfirmed
`isSufficient=true` (minBalance 0.07) → **ED elimination** only: a burner (and the
relay account) can exist holding just the stablecoin, no PAS dust. Doesn't touch gas.

**New lever found — `Pgas` (testnet free-gas rail):** custom pallet, `pgasAssetId
= 2000000000` (a **sufficient** asset, "PGAS" = pay-gas, 3.8T supply / 397
holders). `pgas.claimPgas(slotIndex, target)` mints 5 PGAS/claim gated by the
**`AsPgas` extension verifying a ring-VRF proof** (anti-sybil proof-of-personhood),
≤100 claims/person/period. Two caveats stop it being an architecture: (a)
**testnet-only** — Polkadot mainnet AH has no `Pgas`; (b) `claimPgas` needs a
**substrate signer + VRF proof**, so a pure EVM burner can't call it. Use it to
fund the **demo** burner's gas for free on Paseo, not for the product.

### Recommendations (priority order — updated post-probe)
1. **Keep the relay** — EVM fee-in-asset is confirmed unreachable; the relay is
   structurally required for gasless EVM UX.
2. **Fix the fee model** (the real bug): switch the percentage `relayRebateBps` to a
   **flat/minimum relay fee** in USDC, sized against real gas at the live pool rate
   (`assetConversionQuote`), so the fee actually covers gas.
3. **Wire local `asset-conversion` fee-recovery** (USDC/USDt → PAS on FARE's own
   chain — no XCM/Hydration/Discord). Execution probed: **no asset-conversion
   precompile** exists (only per-asset ERC20 precompiles via `AssetsPrecompiles`),
   so the EVM relay drives `assetConversion.swapExactTokensForTokens` via the
   **`RUNTIME_PALLETS_ADDR` sentinel** (an EVM tx whose calldata is a SCALE-encoded
   runtime call → `eth_substrate_call`, dispatched under the signer's **fallback**
   `Signed` origin) — no separate substrate key. Same rail as the wired burner-side
   coverage swap below.
4. **Broaden payments**: accept **USDt (1984)** too (also sufficient; pool exists)
   — a one-line `setAcceptedToken`.
5. Use **PGAS** to fund the demo burner's gas for free on Paseo (substrate key +
   VRF claim), keeping the relay out of the loop for the testnet showcase only.
6. Drop the Hydration/XCM path to a documented fallback (cross-chain only).

## Asset-conversion coverage layer — any asset → one shielded token → gas+fare+tip

**The gap this closes.** The live Kusama Shield pool on Paseo is **native-PAS
only** (`depositNative`). The combined e2e ([E2E-COMBINED-REPORT.md](E2E-COMBINED-REPORT.md))
shields the burner's **gas** through it but leaves the **escrow USDC value
linkable** — its "one genuinely-new mainnet gap": USDC can't route through a
PAS-only pool, so the escrow traces back to `main`.

**The fix (`venue-node/swap.mjs`).** Normalize on the ONE asset the pool supports.
Everything shields as **PAS**; the burner then fans that PAS out through the local
`asset-conversion` DEX into exactly what each cost needs:

```
any user asset ─swap→ PAS ─deposit→ KS pool ─proxy_withdraw(relay)→ burner (UNLINKED)
                                          burner: keep PAS for gas
                                                  swap PAS → USDC  (fare + tip)  ← asset-conversion
                                          → gasless USDC order; relay recovers fee USDC→PAS
```

So the escrow USDC now originates from a **burner-side swap of shielded PAS**, not
a `main→burner` transfer — no new pool, no XCM. PAS is the canonical settlement
asset **by constraint** (the pool), and asset-conversion makes that invisible to
the order layer.

**Execution rail (shared with fee-recovery) — WIRED.** No asset-conversion
precompile exists, so the EVM burner drives `assetConversion.swapTokensForExactTokens`
through pallet-revive's **runtime-pallets sentinel**: an EVM tx whose `to` is
`RUNTIME_PALLETS_ADDR` (`0x6d6f…0000` = `PalletId("py/paddr")`) has its calldata
decoded as a SCALE-encoded `RuntimeCall` and dispatched under
`RawOrigin::Signed(to_fallback_account_id(signer))` (revive `lib.rs`~2279 +
`runtime.rs`~381). So the burner signs one ordinary EVM tx and the swap runs under
its **fallback account** (`H160 ++ 0xEE×12`) — **no substrate key, no `mapAccount`**
— which is exactly where its shielded PAS lands and where the bought USDC returns
(`sendTo` = that fallback account).

`swap.mjs` ships: live `quoteExactIn`/`priceNativePerToken` (verified 1 USDC =
0.2496 PAS, 1 USDt = 0.2516 PAS); pure tested `planCoverage` (exact-out, keeps a
gas reserve, bounds slippage) + `scaleAmount`; `encodeSwapCall` (builds the call on
live metadata) and `executeSwap` (signs + submits the sentinel EVM tx). **Decimals
gotcha handled:** the pallet denominates native PAS in the chain's **10-dp**, not
the EVM's 18-dp, so `encodeSwapCall` rescales the native `amountInMax` (round-up)
while the token `amountOut` (asset dp, shared) passes through. **Verified** by
encoding a real coverage swap and decoding it back through the live Paseo registry
(`assetConversion.swapTokensForExactTokens`, `sendTo` = fallback, `amountInMax`
= 1.2606 PAS in 10-dp). **Live probe:** `node scripts/shield/coverage-swap.mjs`
(needs `npm i @polkadot/api`; `DRY=1` plans+encodes without sending) runs the whole
thing against a funded burner and confirms by effect — the USDC gain shows up at
`balanceOf(burnerH160)` (the fallback account). Its read-only parts are verified
(price, encode/decode, the asset-1337/1984 ERC20 precompiles); the money-moving tx
is the one remaining confirmation, which the probe performs.

### Privacy gaps (full-privacy target — what's shielded vs. what leaks)
| Leg | Status | Gap / note |
|---|---|---|
| Burner gas (PAS) | ✅ shielded | via KS `proxy_withdraw`; no `main→burner` edge |
| Order identity | ✅ unlinked | fresh per-order burner ≠ main |
| Location | ✅ private | Poseidon commit + Groth16 dropoff (no coords on-chain) |
| Escrow **value** (fare) | ◑ **amount leaks** | closed the *source* link (burner-side swap of shielded PAS), but the PAS→USDC swap amount reveals the fare **value** on-chain (identity hidden, amount not). Mitigate: standard order sizes / fixed denominations. |
| Tip | ◑ amount leaks | same as fare; a separate note/swap is more unlinkable but doubles the correlation surface. |
| Driver payout | ✗ **not shielded** | escrow→driver writes an edge, and the driver keeps a **persistent** identity (reputation/stake/payouts) — inherently linkable. Shielding it fights the reputation model. |
| Relay fee-recovery swap | ✗ not shielded | relay's USDC→PAS swaps are from its persistent identity; timing/amount-correlatable to orders. |
| Relay as observer | ✗ trust point | the relay submits the withdrawal, so it learns `burner ↔ withdrawal`. A decentralized/blind relayer would close this. |
| Anonymity set | ✗ weak (testnet) | Paseo pool ~230 leaves; real privacy needs a large set + deposit/withdraw time-decorrelation (currently last-leaf immediate pattern). |
| Fixed denominations | ◑ required | KS notes are fixed-denom; variable escrow amounts must be quantized (deposit standard units, change stays in-pool) or amounts correlate. |
| Single-asset notes | ◑ by design | one note = one asset; shielding PAS + USDC separately = two correlatable withdrawals. The coverage layer avoids this by shielding **only PAS**. |

## Config (`venue-node/.env`)

| Var | Meaning |
|---|---|
| `RELAY_TOKEN_PRICE` | native per whole token (e.g. `0.5`) — values the token rebate for the guard until live quotes are wired. Unset ⇒ the relay declines token settlements. |
| `SWAP_ENABLED` | `on` to arm auto fee-recovery swaps (default off) |
| `HYDRATION_RPC` | `wss://paseo-rpc.play.hydration.cloud` |
| `GAS_FLOOR_PAS` / `GAS_TARGET_PAS` / `GAS_RESERVE_PAS` | top-up floor / target / never-spend reserve |
| `MIN_SWAP_TOKEN_UNITS` | don't swap dust |
| `SWAP_POLL_MS` | how often to check the gas balance |

## See also
- `venue-node/economics.mjs` · `venue-node/treasury.mjs` — the math + planning
- [E2E-GASLESS-REPORT.md](E2E-GASLESS-REPORT.md) — the run that surfaced this
- [RELAY-SPONSORSHIP.md](RELAY-SPONSORSHIP.md) — the broader relay economics
