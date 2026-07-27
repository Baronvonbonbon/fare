// Governance-console input parsing and bounds, extracted from
// GovernanceConsole so the client-side gate can be checked against the
// contracts it is supposed to mirror (TEST-PLAN C5).
//
// Every bound here duplicates a `require` in Solidity. That duplication is the
// point — the console disables Save rather than letting an operator send a
// transaction that will revert — but it also means the two can drift, so
// test/ops-governance.test.ts probes each boundary against the real contract.

// ---- FareOrders.setParams ----
export const FEE_BPS_MAX = 1_000;          // 10% hard cap
export const CANCEL_BPS_MAX = 5_000;       // 50% hard cap
export const WINDOW_MIN = 600;             // MIN_WINDOW, 10 minutes
export const WINDOW_MAX = 86_400;          // MAX_WINDOW, 24 hours

// ---- FareSettlement.setGeoParams ----
export const RADIUS_MIN = 25;
export const RADIUS_MAX = 2_000;
export const MAX_AGE_MIN = 60;             // 1 minute
export const MAX_AGE_MAX = 7_200;          // 2 hours
export const SKEW_MAX = 1_800;             // 30 minutes

/// Parse an integer field.
///
/// Blank input is NaN, not zero. `Number("")` is 0 in JavaScript, which used to
/// mean that clearing a field and pressing Save wrote a real 0 to the chain —
/// silently, because 0 is inside the valid range for feeBps, assignedCancelBps,
/// relayRebateBps, withdrawFeeBps and unbondingSeconds. Setting the protocol
/// fee to zero should take typing a zero.
///
/// Hex and exponent forms are rejected for the same reason: `Number("0x10")` is
/// 16 and `Number("1e3")` is 1000, neither of which is what an operator typing
/// into a decimal field means.
export function toInt(s: string): number {
  const t = s.trim();
  if (!/^[+-]?\d+(\.\d+)?$/.test(t)) return NaN;
  const n = Number(t);
  return Number.isFinite(n) ? Math.trunc(n) : NaN;
}

const inRange = (v: number, lo: number, hi: number) =>
  Number.isInteger(v) && v >= lo && v <= hi;

/// A bps field bounded at `max`, used for the standalone setters
/// (relayRebateBps, withdrawFeeBps).
export const bpsValid = (v: number, max: number) => inRange(v, 0, max);

export const feeBpsValid = (v: number) => inRange(v, 0, FEE_BPS_MAX);
export const cancelBpsValid = (v: number) => inRange(v, 0, CANCEL_BPS_MAX);
export const windowValid = (v: number) => inRange(v, WINDOW_MIN, WINDOW_MAX);

export const radiusValid = (v: number) => inRange(v, RADIUS_MIN, RADIUS_MAX);
export const maxAgeValid = (v: number) => inRange(v, MAX_AGE_MIN, MAX_AGE_MAX);
export const skewValid = (v: number) => inRange(v, 0, SKEW_MAX);

/// Whether `setParams` would be accepted with these four values.
export const orderParamsValid = (fee: number, cancel: number, pickup: number, delivery: number) =>
  feeBpsValid(fee) && cancelBpsValid(cancel) && windowValid(pickup) && windowValid(delivery);

/// Whether `setGeoParams` would be accepted with these four values.
export const geoParamsValid = (pickupR: number, dropoffR: number, maxAge: number, skew: number) =>
  radiusValid(pickupR) && radiusValid(dropoffR) && maxAgeValid(maxAge) && skewValid(skew);

// ---- display helpers ----

export const pct = (bps: number) => `${(bps / 100).toFixed(2)}%`;

/// Seconds → the coarsest exact unit (2700 → "45m", 86400 → "1d").
export function secsLabel(s: number): string {
  if (s === 0) return "0s";
  if (s % 86400 === 0) return `${s / 86400}d`;
  if (s % 3600 === 0) return `${s / 3600}h`;
  if (s % 60 === 0) return `${s / 60}m`;
  return `${s}s`;
}
