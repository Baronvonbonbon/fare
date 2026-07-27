import { describe, it, expect } from "vitest";
import { splitEscrow, slashExceedsStake, BPS_DENOMINATOR } from "./ruling";

// Unit half of TEST-PLAN C5. The differential half — the same function checked
// against what FareOrders.resolveDisputed actually does on-chain — is in
// test/ops-ruling.test.ts, because only the contract can settle that question.

describe("splitEscrow", () => {
  const PAS = (n: string) => BigInt(Math.round(Number(n) * 1e6)) * 10n ** 12n;

  it("splits at the obvious ratios", () => {
    expect(splitEscrow(PAS("3"), 5_000)).toEqual({ customerAmt: PAS("1.5"), driverAmt: PAS("1.5") });
    expect(splitEscrow(PAS("3"), 0)).toEqual({ customerAmt: 0n, driverAmt: PAS("3") });
    expect(splitEscrow(PAS("3"), 10_000)).toEqual({ customerAmt: PAS("3"), driverAmt: 0n });
    expect(splitEscrow(PAS("2"), 2_500)).toEqual({ customerAmt: PAS("0.5"), driverAmt: PAS("1.5") });
  });

  it("never strands a wei — the two sides always sum to the escrow", () => {
    // The property that matters. Truncation is unavoidable; losing value to it
    // is not, and the driver-takes-the-remainder form is what prevents it.
    for (const escrow of [0n, 1n, 3n, 7n, 9_999n, 10_001n, 12_345_678_901_234_567n]) {
      for (const bps of [0, 1, 3_333, 4_999, 5_000, 6_667, 9_999, 10_000]) {
        const { customerAmt, driverAmt } = splitEscrow(escrow, bps);
        expect(customerAmt + driverAmt, `escrow ${escrow} @ ${bps}bps`).toBe(escrow);
        expect(customerAmt >= 0n && driverAmt >= 0n).toBe(true);
      }
    }
  });

  it("gives the truncation remainder to the driver, not the customer", () => {
    // 1 wei at 50% is the sharpest case: the customer's exact share is half a
    // wei, which floors to zero.
    expect(splitEscrow(1n, 5_000)).toEqual({ customerAmt: 0n, driverAmt: 1n });
    // 3 wei at 50% → 1 / 2, not 2 / 1.
    expect(splitEscrow(3n, 5_000)).toEqual({ customerAmt: 1n, driverAmt: 2n });
  });

  it("rejects a share the chain would reject", () => {
    // The console must not render a preview for a ruling that cannot happen —
    // resolveDisputed requires customerShareBps <= 10_000.
    for (const bad of [10_001, -1, 1.5, NaN, Infinity]) {
      expect(() => splitEscrow(1_000n, bad), `bps ${bad}`).toThrow(/out of range/);
    }
    expect(() => splitEscrow(-1n, 5_000)).toThrow(/negative/);
  });

  it("BPS_DENOMINATOR matches the contract's basis-point scale", () => {
    expect(BPS_DENOMINATOR).toBe(10_000n);
  });
});

describe("slashExceedsStake", () => {
  it("flags a slash larger than the stake, because the chain silently clamps", () => {
    // FareDrivers.slash takes min(amount, stake) and emits both numbers rather
    // than reverting. Without this warning the console would promise the
    // customer damages that will never arrive.
    expect(slashExceedsStake(2n, 1n)).toBe(true);
    expect(slashExceedsStake(1n, 1n)).toBe(false);
    expect(slashExceedsStake(0n, 0n)).toBe(false);
    expect(slashExceedsStake(1n, 0n)).toBe(true);
  });
});
