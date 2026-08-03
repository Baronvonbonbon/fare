// The denomination ladder: how an amount is cut into shielded notes.
//
// Fixed rungs are the whole point. A note carrying an arbitrary amount is a
// fingerprint — deposit 12.437 USDC and withdraw 12.437 USDC and the shielded
// pool has hidden nothing. Rungs put every note into a crowd of identically
// sized notes, and the anonymity set is that crowd.
//
// Two directions, and they round oppositely:
//
//   decompose  — "I HAVE this much, what can I shield?"  rounds DOWN, leaving a
//                residue below the smallest rung as an ordinary balance.
//                Used on the payout side: a driver shields what their earnings
//                cover and lets the rest accumulate toward the next rung.
//
//   cover      — "I NEED this much, what must I deposit?"  rounds UP, leaving
//                overshoot that comes back as change. Used on the funding side:
//                a burner short by a cent cannot place its order.
//
// Do NOT add a "sweep the residue" rung to grind the remainder to zero. An
// exact-amount note is precisely the fingerprint the ladder exists to prevent,
// and order values are public on-chain, so an exact withdrawal relinks to the
// order that produced it.

/// USDC (6dp). Spans a single tip through a large grocery order. The smallest
/// rung sits well above the asset's 0.07 minBalance — USDC is `isSufficient` on
/// Asset Hub, so a fresh recipient given less than that fails account creation.
export const LADDER_USDC: readonly bigint[] = [500_000n, 1_000_000n, 5_000_000n, 25_000_000n, 100_000_000n];

/// Native PAS (18dp), for gas only. Matches the buckets governance sets on the
/// vault; the shape is deliberately coarse because gas amounts are small and a
/// finer ladder would only split an already-thin crowd.
export const LADDER_NATIVE: readonly bigint[] = [10n ** 18n, 5n * 10n ** 18n];

const descending = (rungs: readonly bigint[]) => [...rungs].sort((a, b) => (a > b ? -1 : 1));

/// The largest combination of rungs `amount` covers, biggest first, plus the
/// residue that no rung fits. Greedy is optimal here because each rung divides
/// the next — keep that true of any ladder you define, or this stops being so.
export function decompose(amount: bigint, ladder: readonly bigint[]): { rungs: bigint[]; residue: bigint } {
  const rungs: bigint[] = [];
  let left = amount;
  for (const r of descending(ladder)) {
    while (left >= r) {
      rungs.push(r);
      left -= r;
    }
  }
  return { rungs, residue: left };
}

/// The smallest combination of rungs that covers AT LEAST `amount`, plus the
/// overshoot. Greedy-then-top-up: take what fits, then add one more of the
/// smallest rung that closes the gap.
export function cover(amount: bigint, ladder: readonly bigint[]): { rungs: bigint[]; overshoot: bigint } {
  if (amount <= 0n) return { rungs: [], overshoot: 0n };
  const asc = descending(ladder).reverse();
  const { rungs, residue } = decompose(amount, ladder);
  if (residue === 0n) return { rungs, overshoot: 0n };
  // The cheapest rung that covers what is left over.
  const top = asc.find((r) => r >= residue) ?? asc[asc.length - 1];
  rungs.push(top);
  return { rungs: descending(rungs), overshoot: top - residue };
}

/// Total of a rung list — the amount actually deposited or shielded.
export const sum = (rungs: readonly bigint[]): bigint => rungs.reduce((a, b) => a + b, 0n);

/// How many distinct notes a plan needs. Each is its own transaction (deposit
/// and withdrawal alike), so this is the plan's gas cost and, more importantly,
/// the number of pool events an observer sees.
export const noteCount = (rungs: readonly bigint[]): number => rungs.length;
