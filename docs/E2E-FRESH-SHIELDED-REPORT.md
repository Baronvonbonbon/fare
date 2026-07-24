# Live e2e — completely-fresh shielded delivery, real USDC (Paseo)

**Date:** 2026-07-24 · **Network:** Paseo Asset Hub (chainId `420420417`)
· **Token:** **real Asset Hub USDC — asset 1337** (`0x0000…1200000`, pallet-assets)
· **Relay:** the real `venue-node/relay.mjs` (gasless forwarding + settlement)
· **Script:** `scripts/e2e-fresh-shielded.mjs` (`setup` then `deliver`)

A brand-new main / driver / venue / burner, every value leg routed through
**Kusama Shield + the local asset-conversion DEX**, escrow in **real USDC**, and
payment split to all parties — proving the coverage-swap rail
(`venue-node/swap.mjs`) end to end inside a full order.

```
deployer ─seed→ fresh main / relay / driver / venue        driver.register · venue.registerVenue(id 5)
main ─depositNative(10 PAS)→ KS pool ─/shield-withdraw(relay)→ burner   (gas shielded, UNLINKED to main)
burner ─coverageSwap PAS→USDC(1337)──────────────→ 5 USDC   (RUNTIME_PALLETS_ADDR; escrow value is KS-derived)
burner ─approve(5) → createOrderERC20(3.5) [/forward] → placeBid(1.5) → acceptBidERC20(1.5) [/forward]  (gasless)
relay ─confirmPickup (dual-sig) → confirmDropoffZK (Groth16, no coords) ─────────→ Delivered
vault USDC splits → venue 3 · driver 1.9625 · treasury 0.01875 · relay 0.01875 (Σ 5) → venue/driver withdrawToken
```

## Result — 11 tx, all status 1

| Party | Action | via | USDC | Tx |
|---|---|---|--:|---|
| main | KS.depositNative | direct | 10 PAS | `0x4e8460…` |
| relay | KS.proxy_withdraw→burner | /shield-withdraw | — | `0xc4e4a3…` |
| burner | **coverageSwap PAS→USDC** | RUNTIME_PALLETS_ADDR | 5 | `0x1b6d49…` |
| burner | USDC.approve(orders) | direct | — | `0x58d233…` |
| burner | **createOrderERC20** | /forward (gasless) | 3.5 | `0x69d218…` |
| driver | placeBid | direct | — | `0x9c8f5c…` |
| burner | **acceptBidERC20** | /forward (gasless) | 1.5 | `0x6b73de…` |
| relay | confirmPickup (dual-sig) | /submit (gasless) | — | `0x35021b…` |
| relay | confirmDropoffZK (ZK) | /submit (gasless) | — | `0x9fa88f…` |
| venue | withdrawToken | direct | 3 | `0x04816c…` |
| driver | withdrawToken | direct | 1.9625 | `0x8260761…` |

Splits at `feeBps` 250: venue **3** (orderValue), driver **1.9625** (fare − fee),
treasury **0.01875**, relay **0.01875** (rebate) = **5 USDC**. Full ledger:
[`e2e-runs/e2e-fresh-shielded/ledger.json`](../e2e-runs/e2e-fresh-shielded/ledger.json).

## Privacy posture
- **Gas** shielded (no `main→burner` PAS edge — the pool pays the burner).
- **Escrow value** is now *also* KS-derived: the burner's USDC comes from a
  **coverage swap of shielded PAS**, not a mint and not a transfer from main —
  closing the escrow-value gap [E2E-COMBINED-REPORT.md](E2E-COMBINED-REPORT.md)
  flagged. Residual: the swap **amount** reveals the fare value (identity hidden);
  see the privacy-gap table in [RELAY-TREASURY.md](RELAY-TREASURY.md).
- Location private (Poseidon commit + Groth16 dropoff, no coords on-chain).

## Three things real-USDC-on-Paseo forced (each a fix in the script/setup)

1. **Up-front fee reservation.** Paseo reserves `gasLimit × maxFeePerGas`
   (2000 gwei) at submit — so a sender's balance must cover **value + that
   reservation**, not just actual gas. The relay's 500M-gaslimit settlement
   reserves ~**1000 PAS**, proxy_withdraw (8M) ~16 PAS. Seeds sized accordingly
   (`SEED` in the script: relay 1100, main 18).

2. **`approve` amount is a u128.** The 1337 ERC20 precompile is backed by
   pallet-assets; `approve(spender, MaxUint256)` overflows its u128 and reverts.
   The burner approves the **exact escrow total** instead.

3. **The Orders contract must hold PAS for the pallet-assets ApprovalDeposit.**
   `FareOrders._credit` does `IERC20(token).forceApprove(vault, amount)` at
   settlement; pallet-assets `approve` reserves an **ApprovalDeposit (0.01 PAS)**
   from the caller = the Orders contract. With MockUSDC (plain Solidity) this was
   free, so it never surfaced; with real USDC, `confirmPickup`/`confirmDropoffZK`
   revert with bare `0x` until Orders is funded. Orders has **no payable receive**
   (a plain EVM transfer to it reverts), so the setup phase credits its substrate
   account directly via `balances.transferKeepAlive` dispatched through
   `RUNTIME_PALLETS_ADDR`. **Contract-level note for mainnet:** real-asset
   settlement needs either a pre-funded/top-up-able Orders contract or a `_credit`
   that avoids approve+transferFrom (e.g. a direct `transfer` into the vault).

## Reproduce
```bash
npm i @polkadot/api
node scripts/e2e-fresh-shielded.mjs setup     # fresh wallets, seed, register, fund Orders
#   launch the relay with the printed RELAY_PRIVATE_KEY (RELAY_PROFIT_GUARD=off
#   so the settlement isn't declined — the fee doesn't cover gas; see RELAY-TREASURY.md)
node scripts/e2e-fresh-shielded.mjs deliver
```

## See also
- `venue-node/swap.mjs` · `scripts/shield/coverage-swap.mjs` — the coverage-swap rail
- [RELAY-TREASURY.md](RELAY-TREASURY.md) — the coverage layer + privacy gaps
- [E2E-COMBINED-REPORT.md](E2E-COMBINED-REPORT.md) — the prior run (MockUSDC, gas-only shield)
