# FARE — Static-Analysis Security Review (E2)

Static analysis with **Slither** (the primary gate, wired into CI) plus **Mythril**
as an on-demand deep-dive. This note records the triage: every detector finding,
its verdict, and the rationale — with attention to the freshly-deployed **F6/F8**
surface (EIP-2771 forwarder, EIP-712 `withdrawFor`, and the rebate/fee math).

Run locally:

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install slither-analyzer
slither . --filter-paths node_modules      # uses the hardhat compilation
```

## Headline

**Slither 0.11.5** — 46 contracts, 101 detectors, **96 results**, and **zero
high-severity findings**: no `reentrancy-eth`, no `arbitrary-send-eth`, no
`tx.origin` auth, no `weak-PRNG`, no unchecked-transfer. Every result is
Low / Informational / Optimization. The new F6/F8 code carries **no** reentrancy
finding — the `nonReentrant` guards on `FareVault.withdrawFor` and
`FareOrders.onDropoffConfirmed` hold, and the forwarder is OpenZeppelin's audited
`ERC2771Forwarder`.

## Findings & verdicts

| Detector | Where | Verdict |
|---|---|---|
| `reentrancy-benign` / `reentrancy-events` | `FareDisputes.openDispute`, `FareGovernanceRouter.upgradeContract`/`setContractFrozen`, `FareSettlement.confirmPickup`/`confirmDropoffZK` | **Accepted.** Every external call is to a *trusted protocol contract* that is itself `nonReentrant`, and state/nullifiers are written before the call (e.g. `usedNullifiers[nullifier]=true` precedes `orders.onDropoffConfirmed`). No value is at risk to an attacker-controlled callee. |
| `divide-before-multiply` | `GeoLib.cosMicroDeg`, `GeoLib.distanceSquaredMeters` | **Accepted.** Intentional fixed-point geo math; the ordering + scale factors are chosen for range safety and the precision loss is documented in-code. Not present in the fee/rebate arithmetic. |
| `block-timestamp` | `FareVault.withdrawFor` (deadline), `FareOrders.onDropoffConfirmed`/deadlines | **Accepted.** `block.timestamp` gates hour-scale deadlines and delivery windows; sub-second miner drift is immaterial at that granularity. Standard, safe usage. |
| `low-level-calls` | `PaseoSafeSender._safeSend` (`.call`) | **Accepted.** Deliberate — the pull-payment vault must not let a reverting recipient block settlement; the `.call` return is checked and the contract is the single money-out path. |
| `missing-inheritance` | `FareVault` "should inherit `IFareVault`" | **Accepted (style).** `FareVault` matches the `IFareVault` surface consumers use; formal `is IFareVault` is cosmetic and omitted to keep the interface minimal. |
| `immutable-states` | `pauseRegistry` in `FareOrders`/`FareSettlement`/`FareVenues` | **Accepted (gas).** Set once in the constructor; could be `immutable` for a micro gas saving. **Not changed** — these are deployed live, and re-deploying to shave gas on an informational is not worth diverging repo source from live bytecode. Fold into a future upgrade if one happens for other reasons. |
| `calls-loop` / `costly-operations-inside-a-loop` | `FareDrivers.importRecords`, `FareVenues.importVenues` | **Accepted.** Owner-only, one-shot migration helpers run at upgrade time with a bounded, operator-chosen id list — not user-facing hot paths. |
| `unused-return`, `unindexed-event-address-parameters`, `missing-events-access-control`, `dead-code`, `naming-convention` | assorted | **Accepted (informational).** No security impact; cosmetic/telemetry. |

**Net:** nothing to fix in the deployed contracts. The F6/F8 additions
(`FareForwarder`, `FareVault.withdrawFor` + `withdrawFeeBps`, `FareOrders`
`relayRebateBps` + rebate carve) introduced **no new high/medium finding**.

## Mythril (on-demand)

Mythril's symbolic execution is thorough but slow, so it is **not** a CI gate.
Run it against a specific contract when changing money-handling logic:

```bash
pip install mythril
myth analyze contracts/FareVault.sol --solv 0.8.24 --execution-timeout 300
```

Priority targets: `FareVault` (custody + `withdrawFor` signature path),
`FareForwarder`, and `FareOrders` settlement/fee arithmetic.

## CI

`.github/workflows/slither.yml` runs Slither on every push / PR
(`crytic/slither-action`) so regressions surface in review. This closes the
Slither half of the E2 mainnet-gate prerequisite; a full external audit (E3)
remains a hard gate before real value.
