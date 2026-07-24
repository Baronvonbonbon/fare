# Fresh shielded e2e — gas accounting + production economics

Companion to [E2E-FRESH-SHIELDED-REPORT.md](E2E-FRESH-SHIELDED-REPORT.md). Same
live run (Paseo, real USDC 1337, 11 tx). Every fee is priced at the observed
Paseo gas price (**~1000 gwei effective**, `maxFeePerGas` 2000 gwei) and, for
comparison, converted to USDC at the **live pool rate 1 PAS = 4.006 USDC**
(1 USDC = 0.2496 PAS). **Read the testnet-gas caveat (§5) before quoting absolute
PAS numbers** — the *ratios* are the real finding, not the magnitudes.

## 1. All transactions — who paid gas

| # | Party | Action | via | gasUsed | fee PAS | ≈USDC | value |
|--:|---|---|---|--:|--:|--:|--:|
| 1 | main | KS.depositNative | direct | 20 530 | 0.020530 | 0.082 | 10 PAS in |
| 2 | **relay** | KS.proxy_withdraw→burner | /shield-withdraw | 773 484 | **0.773484** | **3.099** | — |
| 3 | burner | coverageSwap PAS→USDC | sentinel | 0 ⚠ | 0 ⚠ | — | 5 USDC out |
| 4 | burner | USDC.approve(orders) | direct | 1 253 | 0.001253 | 0.005 | — |
| 5 | **relay** | createOrderERC20 (burner) | /forward | 29 200 | 0.029200 | 0.117 | 3.5 USDC |
| 6 | driver | placeBid | direct | 10 775 | 0.010775 | 0.043 | — |
| 7 | **relay** | acceptBidERC20 (burner) | /forward | 6 465 | 0.006465 | 0.026 | 1.5 USDC |
| 8 | **relay** | confirmPickup | /submit | 15 227 | 0.015227 | 0.061 | — |
| 9 | **relay** | confirmDropoffZK | /submit | 25 794 | 0.025794 | 0.103 | — |
| 10 | venue | withdrawToken | direct | 0 ⚠ | 0 ⚠ | — | 3 USDC out |
| 11 | driver | withdrawToken | direct | 0 ⚠ | 0 ⚠ | — | 1.9625 USDC out |
| | | | | | **0.8827** | **3.54** | |

⚠ **Measurement gap:** the sentinel dispatch (coverage swap) and the two
`withdrawToken` calls return `gasUsed 0` in the Paseo receipt, so the ledger
**undercounts** them. The coverage swap's real cost isn't gas at all — it's the
DEX input: **~1.25 PAS spent to buy 5 USDC** (≈1% slippage), borne by the burner
and invisible here.

## 2. Gas paid, by party (per order)

| Party | txs | gasUsed | fee PAS | ≈USDC | share |
|---|--:|--:|--:|--:|--:|
| **relay** | 5 | 850 170 | **0.8502** | **3.406** | **96%** |
| main (customer) | 1 | 20 530 | 0.0205 | 0.082 | 2.3% |
| driver | 2 | 10 775 | 0.0108 | 0.043 | 1.2% |
| burner (customer) | 2 | 1 253 | 0.0013 | 0.005 | 0.1% |
| venue | 1 | 0 ⚠ | 0 | 0 | — |

The **relay pays 96% of all gas**. Everything a customer/driver/venue touches is
either their own tiny direct tx or gasless (relay-paid).

## 3. Net economics, per order

USDC settlement of the 5 USDC escrow (feeBps 250): **venue 3.0** (order value),
**driver 1.9625** (fare 1.5 + tip 0.5 − fee 0.0375), **treasury 0.01875**,
**relay 0.01875** (F6 rebate).

| Party | pays | earns | net (USDC-equiv) |
|---|---|---|---|
| Customer (main+burner) | ~1.25 PAS swapped → 5 USDC escrow + ~0.10 PAS gas | the delivery | **−5.0** (the price of goods+delivery) |
| Venue | ~0 | 3.0 USDC | **+3.0** |
| Driver | 0.043 USDC gas | 1.9625 USDC | **+1.92** |
| Treasury | — | 0.01875 USDC | **+0.019** |
| **Relay** | **3.41 USDC-equiv gas** | 0.01875 USDC | **−3.39** |

**The relay loses ~3.39 USDC-equiv to earn 0.019 USDC — a cost/revenue ratio of
~182 : 1.** Of its gas, **91% is the one `proxy_withdraw`** (the shielded-funding
Groth16 verify), which in sponsor mode (`SHIELD_FEE_PAS=0`) earns **nothing**.

Protocol take: **0.0375 USDC on a 5 USDC order (0.75%)** — and the relay's half of
that (0.01875) is the *only* thing offsetting its 3.4 USDC of gas.

## 4. Economic shortcomings for a production system

1. **The relay is structurally unprofitable per order (≈182:1).** A *percentage*
   rebate on the fare cannot cover a roughly *fixed* gas cost — the exact finding
   in [RELAY-TREASURY.md](RELAY-TREASURY.md), now measured inside a full order.
   The run only completes because `RELAY_PROFIT_GUARD=off`; **with the guard on,
   production refuses to settle** ("fare reward below relayed cost").
2. **Shielded funding is the cost sink and a pure subsidy.** `proxy_withdraw` is
   0.77 PAS (91% of relay gas) and, in sponsor mode, unpriced. Privacy is being
   given away for free — every order the relay funds is a ~3 USDC-equiv gift.
3. **Currency mismatch is unresolved in the loop.** The relay spends **PAS** and
   earns **USDC**; its PAS balance only drains. The fee-recovery swap
   (`swap.mjs`/`treasury.mjs`, USDC→PAS) exists but is **not wired into the relay
   here**, so a real relay runs out of gas.
4. **Reservation capital lock-up.** Paseo reserves `gasLimit × maxFeePerGas`
   up-front, so a single 500M-gaslimit settlement **locks ~1000 PAS** to actually
   spend ~0.06 USDC. A relay must idle large capital per concurrent settlement —
   caps throughput and raises the cost of running one.
5. **Customer over-funding + stranded PAS.** We shield **10 PAS** to fund a burner
   that needs ~1.25 PAS (swap) + a transient ~4 PAS (reservation) → **~8.7 PAS
   left stranded** in a disposable burner. Recovering it needs a *shielded-return*
   deposit (another tx + Groth16), or it's lost.
6. **Two Groth16 proofs per order** (withdrawal + dropoff): client-side proof-gen
   latency (tens of seconds each) and the verify is the on-chain gas sink.
7. **Coverage-swap spread + hidden weight fee.** ~1% DEX slippage on thin
   liquidity, plus a substrate weight fee the EVM receipt reports as 0 — real
   costs that don't appear in gas accounting and grow with order size / thin pools.
8. **Orders working capital.** Real-asset settlement needs the Orders contract to
   hold PAS for pallet-assets approval deposits (§ report finding 3) — an ongoing
   operational balance to monitor/top-up.

## 5. The testnet-gas caveat (don't over-read the magnitudes)

Paseo charges ~1000–2000 gwei; **mainnet Polkadot Asset Hub is far cheaper**, so
the absolute 3.4 USDC-equiv relay cost is inflated. What does **not** improve with
a cheaper gas price is the **ratio**: the rebate is ~0.5% of relay cost, and
`proxy_withdraw` stays the dominant fixed cost. Fix the *model*, not just the price.

## 6. Levers (what a production system needs)

**Validated live (guard ON, Paseo):** with `FareOrders` v2 at
`0xba2df454…` and `relayServiceFee(USDC)=4.25`, a fresh order settled **without
the profit guard declining** and the relay collected the **4.25 USDC** fee. Relay
net per order flipped **−3.39 → +0.83 USDC-equiv** (earned 4.25, paid ~0.85 PAS ≈
3.42) — profitable at last. Splits: venue 3 · driver 1.9625 · treasury 0.0375 ·
**relay 4.25** (Σ 9.25).

**Implemented (this PR):**
- ✅ **Flat all-in relay service fee in USDC** — `FareOrders.relayServiceFee[token]`,
  a governance-set flat amount the customer escrows on top of orderValue+tip and
  that is paid in full to the settling relay (refunded if no relay settles). Sized
  (off-chain) to cover the whole per-order cost + margin, because a percentage
  rebate can't. Snapshotted per order.
- ✅ **Guard gates on it** — the relay's settlement guard now values
  `serviceFee + rebate` in native and requires it to clear cumulative gas × margin
  (`relayCompForOrder` in `relay.mjs`).
- ✅ **Fee-recovery wired** — when the relay's gas dips below the floor it sweeps
  its accrued vault USDC and swaps USDC→PAS on the local DEX via the sentinel rail
  (`swap.executeRecoverySwap` + the `RELAY_FEE_RECOVERY` loop), self-refilling.

**Still open:**
- **Deploy + tune:** promote the new `FareOrders` (freeze-and-drain) and
  `setRelayServiceFee` to a value that covers gas at the live pool rate + margin.
- **Price the privacy:** charge the shielded-withdrawal in fee mode
  (`SHIELD_FEE_PAS>0`) so the customer pays for their own unlinkable funding —
  or fold it into the flat service fee (the "all-in" intent).
- **Cut the reservation:** make `GAS_SETTLE`/`GAS_SHIELD` configurable near real
  usage, freeing the ~1000 PAS lock-up.
- **Amortise shielding:** one deposit funds many withdrawals; withdraw only
  `escrow + gas headroom` (not a fixed 10 PAS); auto shield-return the remainder.
- **Batch settlement** or a cheaper verify to shrink the per-order sink.

## Reproduce the accounting
```bash
# after a run (docs/E2E-FRESH-SHIELDED-REPORT.md), the ledger has every tx:
cat e2e-runs/e2e-fresh-shielded/ledger.json
```
