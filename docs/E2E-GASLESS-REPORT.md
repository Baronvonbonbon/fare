# Live report — gasless stablecoin order (Option C) on the upgraded FareOrders

**Date:** 2026-07-24 · **Network:** Paseo Asset Hub (chainId `420420417`)

Proof that **Option C is live**: a customer wallet with **zero native PAS** placed
and funded a USDC order **entirely by signatures** — the venue-node relay paid all
gas. Ledger: [`docs/e2e-gasless/ledger.json`](e2e-gasless/ledger.json). Reproduce:
`node scripts/e2e-gasless.mjs`.

## The live upgrade (freeze-and-drain)
`scripts/upgrade-gasless-orders.ts` promoted **FareOrders** to the gasless-ERC20
build. Narrow upgrade (only FareOrders changed):

| | |
|---|---|
| New FareOrders | **`0xeB04BfD381366Cb614544C50475D2B32B2dA4693`** |
| Old FareOrders | `0xAA117E…568a0E` — frozen, drain-only |
| Preserved | treasury `0x6Db7…1FD1`, feeBps 250, windows 2700/5400, acceptedToken |
| Raised (reuse+raise F6) | **`relayRebateBps` 2000 → 5000** (50% of the fee → settling relay) |
| Re-pointed | settlement / ratings / disputes → new orders; re-authorized on vault/drivers/venues |

All 14 post-upgrade validation checks passed (router promotion, cross-refs,
`createOrderERC20WithPermit` present). Recovery: `router.upgradeContract` back to
the old address (which stays deployed).

> **Permit token.** The app's original stablecoin (`0x71FF…`) predates
> `ERC20Permit`, so gasless (permit) orders need a permit-capable token. A fresh
> permit `MockUSDC` was deployed (`0x3e014ca365cBeB4fA4410A885a998fa1ADfe0A06`),
> accepted on the new orders, and the address book now points at it. Real Asset
> Hub USDC supports EIP-2612, so this is a testnet-only artifact.

## Transactions (9) — customer paid 0 PAS

| Party | Action | USDC | Gas | Customer PAS |
|---|---|--:|--:|:--:|
| faucet | mint-USDC → customer | 100 | 6 874 | 0 ✓ |
| **relay** | **forward: createOrderERC20WithPermit** | 3.5 | 38 794 | **0 ✓** |
| driver | placeBid | — | 10 775 | 0 |
| **relay** | **forward: acceptBidERC20** | 1.5 | 6 930 | **0 ✓** |
| relay | confirmPickup | — | 16 106 | 0 |
| relay | confirmDropoffZK | — | 25 791 | 0 ✓ |
| venue | withdrawToken | 3 | 1 978 | — |
| driver | withdrawToken | 1.9625 | 1 978 | — |

Total gas ≈ **0.113 PAS**, all paid by the relay/faucet. The customer's native
balance was asserted **== 0 at every step** (after mint, after gasless create,
after gasless accept, after delivery, at end).

## What the run proves
- **`createOrderERC20WithPermit` is gasless + forwardable live**: the customer
  signed an EIP-2612 permit (no approve tx) + a `FareForwarder` ForwardRequest;
  the relay `execute()`d it. On-chain `o.customer` == the **signer** (not the
  forwarder), and the 3.5 USDC escrow was pulled from the customer via the
  permit-set allowance.
- **`acceptBidERC20` is gasless + forwardable live**: same pattern, fare escrowed
  from the customer, order → Assigned.
- **Settlement + ZK dropoff unchanged**: dual-sig pickup + Groth16 proximity (no
  coordinates on-chain), Delivered.
- **Raised F6 rebate is live**: this order's 0.0375 USDC fee split **50/50** —
  relay 0.01875, treasury 0.01875 (was 20/80). So the relay is compensated *from
  the order* for the gas it fronts; sizing is a governance knob (`relayRebateBps`).

## Bottom line
A customer needs **no native PAS** to order in stablecoin — the relay fronts gas
and is repaid from the order's fee. Combined with KS-only burner funding
(shielded value) and the ZK dropoff (private location), the stablecoin order is
now gasless, unlinkable, and location-private end to end. Remaining: a
permit-capable stablecoin in production (real USDC has it) and the KS multi-asset
USDC deposit to shield the escrow value itself.

## See also
- [E2E-STABLECOIN-REPORT.md](E2E-STABLECOIN-REPORT.md) · [E2E-COMBINED-REPORT.md](E2E-COMBINED-REPORT.md) · [SHIELDED-FUNDING.md](SHIELDED-FUNDING.md)
- `test/gasless-erc20.test.ts` — the unit-level Option C coverage
