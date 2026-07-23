# Live e2e report — a stablecoin-escrowed delivery on Paseo (C3)

**Date:** 2026-07-23 · **Network:** Paseo Asset Hub (chainId `420420417`)
· **Token:** `USDC` (MockUSDC, 6 dp) `0x71FFC15a6961B655Cd3bE34Ef65361f78e6E8620`

The full FARE delivery — **order → auction → pickup → dropoff → payouts** — run
live with the order **escrowed and settled entirely in USDC** (the C3 ERC-20
path), reusing the registered venue (id 3) + driver from the native run. Every
transaction resolved cleanly. Evidence:
[`docs/e2e-stablecoin/ledger.json`](e2e-stablecoin/ledger.json). Reproduce:
`node scripts/e2e-stablecoin.mjs`.

> **Result.** The stablecoin escrow works end to end: escrow pulled in USDC
> (`createOrderERC20` + `acceptBidERC20`), settlement is token-agnostic (dual-sig
> pickup + **real Groth16 ZK dropoff** — no coordinates on-chain, same as native),
> payouts pulled in USDC (`withdrawToken`), and the fee + **F6 relay rebate settle
> in USDC too**. **Gas is still paid in PAS** — only the *escrow/value* is USDC,
> which is exactly the point (food margins don't ride DOT volatility).

## Transactions (10)

| # | Party | Action | USDC | Gas | PAS fee | Tx |
|--:|---|---|--:|--:|--:|---|
| 1 | infra | fund-customer-gas | — | 10 897 | 0.0109 | `0x4b05a7…` |
| 2 | infra | mint-USDC → customer | 100 | 6 858 | 0.0069 | `0xb7fef0…` |
| 3 | customer | USDC.approve(orders) | — | 3 936 | 0.0039 | `0x184a71…` |
| 4 | customer | **createOrderERC20** | 3.5 | 26 839 | 0.0268 | `0x6b31d7…` |
| 5 | driver | placeBid | — | 10 770 | 0.0108 | `0x583951…` |
| 6 | customer | **acceptBidERC20** | 1.5 | 4 093 | 0.0041 | `0xc9bec9…` |
| 7 | relay | confirmPickup | — | 16 026 | 0.0160 | `0xca1365…` |
| 8 | relay | confirmDropoffZK | — | 25 574 | 0.0256 | `0x0fa3d4…` |
| 9 | venue | withdrawToken | 3 | 1 961 | 0.0020 | `0xa94f37…` |
| 10 | driver | withdrawToken | 1.9625 | 1 961 | 0.0020 | `0xf043e5…` |

Total gas ≈ **0.109 PAS** across all parties (gas priced at Paseo's 1000 gwei).

## USDC value flow — exact

Customer escrows **5 USDC** (orderValue 3 + tip 0.5 + fare 1.5); it splits with
no subsidy, all in-token:

| Party | Receives (USDC) | Rule |
|---|--:|---|
| Venue | **3.0000** | `orderValue`, credited at pickup |
| Driver | **1.9625** | `fare − 2.5% fee + tip` = 1.5 − 0.0375 + 0.5 |
| Treasury | **0.0300** | protocol fee (2.5%) − relay rebate |
| Relay (F6) | **0.0075** | 20% of the fee → the settling relay, **in USDC** |
| **Sum** | **5.0000** | = orderValue + tip + fare ✅ |

Verified empirically from `FareVault.tokenBalanceOf` after settlement, then both
payees pulled their balances to their own wallets (venue 3 USDC, driver 1.9625
USDC confirmed on-chain).

## What this exercises that the native run doesn't
- `FareOrders.createOrderERC20` / `acceptBidERC20` — escrow via `transferFrom`
  (customer `approve` first) instead of `msg.value`.
- `FareVault.creditToken` / `withdrawToken` — the token payout path.
- The **fee + F6 rebate carve in USDC** (`onDropoffConfirmed` → `_credit` →
  `creditToken`), proving the reward economics are token-aware, not native-only.
- Settlement (`confirmPickup`, `confirmDropoffZK`) is unchanged and token-agnostic
  — the same ZK location privacy applies (no coordinate on-chain).

## Notes
- `MockUSDC.mint` is open (testnet only — the doc-comment says never mainnet;
  there the real bridged-USDC precompile address goes in the accepted-token set).
- The stablecoin was already `acceptedToken=true` on the live `FareOrders`.
- Gas remains native PAS; a fully-gasless token order still uses the relay's
  gas-sponsorship / funded-burner path (orthogonal to escrow currency).

## See also
- [E2E-SHIELDED-DELIVERY-REPORT.md](E2E-SHIELDED-DELIVERY-REPORT.md) — the native-PAS + shielded-funding run
- `test/stablecoin-escrow.test.ts` — the unit-level ERC-20 escrow coverage
