// Relay economics — the profitability guard's pure math (no I/O, unit-tested).
//
// The relay earns two rewards (both live on Paseo): the F6 settlement rebate
// (a share of the protocol fee, paid when it submits the dropoff) and the F8
// withdraw fee (a share of a gasless withdrawal). It spends gas on those plus
// the no-reward actions (fund / bids / pickup / cancels / rate). This module
// answers "is a reward-bearing action worth its cost?" and "is there budget
// left for a no-reward action?" — the relay wires these to on-chain reads +
// gas estimates. All amounts are wei (BigInt or BigInt-coercible).

/// F6 rebate the relay collects for settling a fare's dropoff:
///   fare · feeBps · relayRebateBps / 1e8   (feeBps and relayRebateBps are /1e4).
export function rebateWei(fareWei, feeBps, relayRebateBps) {
  return (BigInt(fareWei) * BigInt(feeBps) * BigInt(relayRebateBps)) / 100_000_000n;
}

/// F8 fee the relay keeps for submitting a gasless withdrawal:
///   balance · withdrawFeeBps / 1e4.
export function withdrawFeeWei(balanceWei, withdrawFeeBps) {
  return (BigInt(balanceWei) * BigInt(withdrawFeeBps)) / 10_000n;
}

/// reward ≥ cost × margin, evaluated in integer wei (margin is a float like
/// 1.25; scaled by 1000 so we never do float math on wei).
export function coversCost(rewardWei, costWei, margin) {
  const m = BigInt(Math.round(margin * 1000));
  return BigInt(rewardWei) * 1000n >= BigInt(costWei) * m;
}

/// Rolling-window subsidy budget: does `costWei` still fit under `budgetWei`
/// given `spentWei` already spent this window? (A zero/negative budget blocks.)
export function withinBudget(spentWei, costWei, budgetWei) {
  return BigInt(spentWei) + BigInt(costWei) <= BigInt(budgetWei);
}

/// A rolling-window accumulator. `now`/`windowMs` gate a reset; `spent` is wei.
export function rollingWindow(windowMs) {
  return { spent: 0n, start: 0 };
}
/// Roll the window forward if it has elapsed, then return the current spend.
export function windowSpent(win, now, windowMs) {
  if (now - win.start > windowMs) {
    win.spent = 0n;
    win.start = now;
  }
  return win.spent;
}
