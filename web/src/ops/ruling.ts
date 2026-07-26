// Arbiter ruling arithmetic, extracted from DisputesConsole so it can be tested
// against the contract it is supposed to mirror (TEST-PLAN C5).
//
// This is the preview an arbiter reads before signing `resolve()`. It has no
// authority — the contract does the real split — which is exactly why it has to
// agree with it to the wei. An arbiter who is shown "customer 1.5 / driver 1.5"
// and actually causes "customer 1.5000001 / driver 1.4999999" has been misled by
// their own tool, and the ruling is not reversible.
//
// FareOrders.resolveDisputed:
//     customerAmt = escrow * customerShareBps / 10_000    (integer division)
//     driverAmt   = escrow - customerAmt
//
// The subtraction matters: the driver takes the truncation remainder, so the two
// sides always sum to exactly the escrow and no wei is stranded. Reproducing
// that as a second multiplication would round the other way and lose dust.

export const BPS_DENOMINATOR = 10_000n;

export type EscrowSplit = { customerAmt: bigint; driverAmt: bigint };

/// Split `escrow` the way `FareOrders.resolveDisputed` will.
///
/// Throws on a share outside 0…10000, mirroring the contract's `bad-bps`
/// require — a console that renders a preview for an input the chain will
/// reject is showing a number that can never happen.
export function splitEscrow(escrow: bigint, customerShareBps: number): EscrowSplit {
  if (!Number.isInteger(customerShareBps) || customerShareBps < 0 || customerShareBps > 10_000) {
    throw new Error(`customerShareBps out of range: ${customerShareBps}`);
  }
  if (escrow < 0n) throw new Error("escrow must not be negative");
  const customerAmt = (escrow * BigInt(customerShareBps)) / BPS_DENOMINATOR;
  return { customerAmt, driverAmt: escrow - customerAmt };
}

/// Whether a proposed slash exceeds what the driver actually has staked.
/// `FareDrivers.slash` clamps rather than reverting, so without this the
/// console would promise the customer damages that will never arrive.
export function slashExceedsStake(slashWei: bigint, driverStake: bigint): boolean {
  return slashWei > driverStake;
}
