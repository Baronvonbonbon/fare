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
///
/// IMPORTANT: `reward` and `cost` must be in the SAME currency. For a TOKEN
/// order the F6 rebate is in the order token (e.g. USDC, 6-dp) while gas is in
/// native (PAS, 18-dp) — convert the rebate with `tokenToNativeWei` first, else
/// the comparison is meaningless (different currency AND decimals).
export function coversCost(rewardWei, costWei, margin) {
  const m = BigInt(Math.round(margin * 1000));
  return BigInt(rewardWei) * 1000n >= BigInt(costWei) * m;
}

/// Value a token amount (in the token's smallest units) in NATIVE wei, given the
/// price of 1 whole token in native as a fraction (priceNum/priceDen) and both
/// decimals. This is what lets the relay compare a USDC-denominated rebate
/// against PAS gas: the price comes from a Hydration/Paraspell quote (or a
/// configured fallback rate) — see treasury.mjs. Pure integer math.
///   nativeWei = tokenWei · (priceNum/priceDen) · 10^(nativeDecimals − tokenDecimals)
export function tokenToNativeWei(tokenWei, tokenDecimals, nativeDecimals, priceNum, priceDen) {
  let n = BigInt(tokenWei) * BigInt(priceNum);
  let d = BigInt(priceDen);
  const shift = BigInt(nativeDecimals) - BigInt(tokenDecimals);
  if (shift >= 0n) n *= 10n ** shift;
  else d *= 10n ** -shift;
  return d === 0n ? 0n : n / d;
}

/// The inverse of the guard: the SMALLEST fare at which settling an order pays
/// for itself. `coversCost` answers "is this one worth relaying?"; this answers
/// "from what fare up is relaying worth doing at all?", which is the question an
/// operator setting `relayRebateBps` / `relayServiceFee` actually has.
///
/// Returns null when no fare suffices — with `relayRebateBps` or `feeBps` at
/// zero the rebate is identically zero, so unless the flat service fee already
/// covers the cost, settlement never pays no matter how large the order.
///
/// Exact, not approximate: `breakEvenFareWei` is the least fare for which
/// `coversCost(rebateWei(fare, …) + serviceFeeWei, costWei, margin)` holds, and
/// one wei less always fails. economics.test.mjs asserts that both ways.
export function breakEvenFareWei({ costWei, margin, feeBps, relayRebateBps, serviceFeeWei = 0n }) {
  const m = BigInt(Math.round(margin * 1000));
  const need = BigInt(costWei) * m - BigInt(serviceFeeWei) * 1000n;
  if (need <= 0n) return 0n; // the flat fee alone already covers it
  const rebateNeeded = ceilDiv(need, 1000n);
  const rate = BigInt(feeBps) * BigInt(relayRebateBps); // rebate = fare · rate / 1e8
  if (rate === 0n) return null; // no rebate at any fare
  return ceilDiv(rebateNeeded * 100_000_000n, rate);
}

const ceilDiv = (a, b) => (a + b - 1n) / b;

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
