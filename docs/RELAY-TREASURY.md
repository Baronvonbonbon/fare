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

**To go live:** (1) accept a real Asset Hub asset as the FARE stablecoin;
(2) `npm i @paraspell/xcm-router` (+ its Wasm/augment deps) in `venue-node`;
(3) verify the Asset Hub XCM-precompile interface + wire `executeSwap` to build
via Paraspell and submit via the precompile from the relay account; (4) set
`SWAP_ENABLED=on` + the gas thresholds.

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
