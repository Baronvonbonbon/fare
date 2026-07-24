# Live e2e report — combined shielded-funding + stablecoin delivery (Paseo)

**Date:** 2026-07-24 · **Network:** Paseo Asset Hub (chainId `420420417`)
· **Token:** `USDC` (MockUSDC, 6 dp) · **KS pool:** `0x7d5a49…` (native PAS)

The full delivery run with **both** privacy paths at once: the customer's
order-placing burner has its **gas shielded through Kusama Shield**, the order is
**escrowed in USDC**, and the dropoff is **zero-knowledge**. Reuses the
registered venue (id 3) + driver. Evidence:
[`docs/e2e-combined/ledger.json`](e2e-combined/ledger.json). Reproduce:
`node scripts/e2e-combined.mjs`.

```
customer-main ─depositNative(10 PAS)→ KS pool ─proxy_withdraw(relay)→ burner   (gas, UNLINKED)
open MockUSDC.mint ──100 USDC──────────────────────────────────────→ burner   (escrow value)
burner ─approve → createOrderERC20(3.5 USDC) → [driver bids] → acceptBidERC20(1.5 USDC)
relay ─confirmPickup (dual-sig) → confirmDropoffZK (Groth16, no coords) ──────→ Delivered
venue/driver ─withdrawToken──────────────────────────────────────────────────→ USDC payouts
burner ─depositNative(8.965 PAS)─────────────────────────────────────────────→ KS  (shielded gas return)
```

## Transactions (12)

| Party | Action | PAS | USDC | Gas | Tx |
|---|---|--:|--:|--:|---|
| customer-main | KS.depositNative | 10.0 | — | 18 316 | `0x753fc5…` |
| relay | KS.proxy_withdraw→burner | — | — | 772 396 | `0xe3cb72…` |
| faucet (mint) | mint-USDC→burner | — | 100 | 4 218 | `0x899f43…` |
| customer-burner | USDC.approve(orders) | — | — | 3 936 | `0x049b93…` |
| customer-burner | **createOrderERC20** | — | 3.5 | 26 839 | `0xde1e56…` |
| driver | placeBid | — | — | 10 770 | `0xd9bc8b…` ⚠︎ |
| customer-burner | **acceptBidERC20** | — | 1.5 | 4 093 | `0x72a278…` |
| relay | confirmPickup | — | — | 13 386 | `0xf5cb6d…` |
| relay | confirmDropoffZK | — | — | 20 294 | `0x40fff5…` |
| venue | withdrawToken | — | 3 | — | `0x0fcf54…` |
| driver | withdrawToken | — | 1.9625 | — | `0x1989d8…` |
| customer-burner | KS.depositNative (return) | 8.965 | — | 18 301 | `0x466421…` |

Total gas ≈ **0.89 PAS**, dominated (0.77) by the KS `proxy_withdraw` (Groth16
withdrawal verify), borne by the relay. `⚠︎` `placeBid` settled on-chain
(`bidOf` = 1.5 USDC) but its receipt hash wasn't resolvable on the load-balanced
RPC — effect-confirmed, gas from the identical stablecoin-run call. USDC splits
are exact per order (venue 3, driver 1.9625, treasury 0.03, relay 0.0075 = 5).

## Privacy analysis — what's private, what isn't

| Axis | Result | Basis |
|---|---|---|
| **Gas funding** | ✅ shielded (no `main→burner` PAS edge) | pool pays the burner via `proxy_withdraw`; main only deposited into a shared pool |
| **Order identity** | ✅ unlinked to main | the order is placed by a fresh burner ≠ main; no direct edge |
| **Location** | ✅ private | `dropCommit` is a Poseidon hash; dropoff is a Groth16 proof — no coordinate on calldata/storage/events |
| **Escrow value (USDC)** | ◑ **links on testnet** | KS is native-PAS only, so USDC can't route through it; here the mint's *sender was customer-main*, so the value traces main→burner |

The **verified check**: zero direct `main→burner` value-transfer txs; the PAS gas
originates from the pool, not main. The **honest gap**: the escrow USDC. Two
ways to close it:

1. **Burner self-mint (testnet):** `MockUSDC.mint` is permissionless, so the
   burner — which already has KS-shielded gas — can mint its **own** USDC. That
   removes even the testnet link (an open faucet links nothing, exactly like the
   shared-PAS-faucet model in [PRIVACY.md](PRIVACY.md)). *This run minted from the
   deployer out of convenience; self-mint is the recommended pattern.*
2. **Mainnet:** real USDC needs an unlinked source — a **USDC-shielding path**
   (a multi-asset KS deposit, or a confidential-transfer asset). Native-PAS KS
   shields the gas but not the value. This is the one genuinely-new mainnet gap
   the combined flow exposes. → **Closed without a new pool** by the
   asset-conversion coverage layer (`venue-node/swap.mjs`): shield **PAS**, then
   have the burner swap PAS→USDC locally for the escrow, so the USDC's source is a
   burner-side swap of shielded PAS, not `main`. Residual: the swap **amount** still
   reveals the fare value (identity hidden). See
   [RELAY-TREASURY.md](RELAY-TREASURY.md) "Asset-conversion coverage layer".

**Same caveats as the native shielded run** ([E2E-SHIELDED-DELIVERY-REPORT.md](E2E-SHIELDED-DELIVERY-REPORT.md) §5):
the gas shielding used the last-leaf immediate deposit→withdraw pattern
(timing-correlatable) and Paseo's anonymity set is tiny — so this is a proven
**mechanism**, not real-world unlinkability, until the KS fixes land and the pool
has usage.

## Bottom line
Gas-shielded, identity-unlinked, location-private, USDC-escrowed delivery works
end to end. The remaining privacy work is **not in FARE**: an unlinked USDC
funding source (mainnet) and KS anonymity-set maturity.

## See also
- [E2E-SHIELDED-DELIVERY-REPORT.md](E2E-SHIELDED-DELIVERY-REPORT.md) — native PAS + shielded funding
- [E2E-STABLECOIN-REPORT.md](E2E-STABLECOIN-REPORT.md) — USDC escrow (no shielding)
- [SHIELDED-FUNDING.md](SHIELDED-FUNDING.md) · [PRIVACY.md](PRIVACY.md)
