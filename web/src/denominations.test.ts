// @vitest-environment jsdom
// jsdom only because the planShielding cross-check pulls in shieldpayout.ts,
// which imports chain.ts, which reads localStorage at module load. The ladder
// itself is pure.
import { describe, it, expect } from "vitest";
import { LADDER_USDC, LADDER_NATIVE, decompose, cover, sum, noteCount } from "./denominations";
import { planShielding } from "./shieldpayout";

const USDC = (n: number) => BigInt(Math.round(n * 1e6));
const PAS = (n: number) => BigInt(n) * 10n ** 18n;

describe("the denomination ladder", () => {
  it("cuts an amount into rungs, largest first, and reports what is left", () => {
    const { rungs, residue } = decompose(USDC(31.4), LADDER_USDC);
    expect(rungs).toEqual([USDC(25), USDC(5), USDC(1)]);
    expect(residue).toBe(USDC(0.4));
    expect(sum(rungs) + residue).toBe(USDC(31.4));
  });

  it("never exceeds what it was given", () => {
    for (const amount of [0, 0.49, 0.5, 1, 4.99, 137.02, 999.999]) {
      const { rungs, residue } = decompose(USDC(amount), LADDER_USDC);
      expect(sum(rungs)).toBeLessThanOrEqual(USDC(amount));
      expect(sum(rungs) + residue).toBe(USDC(amount));
      expect(residue).toBeLessThan(LADDER_USDC[0]);
    }
  });

  it("shields nothing below the smallest rung, rather than inventing one", () => {
    // The residue is deliberate. A bespoke small note would be unique and
    // therefore self-identifying — worse than leaving the value unshielded.
    const { rungs, residue } = decompose(USDC(0.42), LADDER_USDC);
    expect(rungs).toEqual([]);
    expect(residue).toBe(USDC(0.42));
  });

  it("covers a needed amount by rounding UP, and reports the overshoot", () => {
    // Funding rounds the other way: a burner one cent short cannot order.
    const { rungs, overshoot } = cover(USDC(31.4), LADDER_USDC);
    expect(sum(rungs)).toBeGreaterThanOrEqual(USDC(31.4));
    expect(rungs).toEqual([USDC(25), USDC(5), USDC(1), USDC(0.5)]);
    expect(overshoot).toBe(USDC(0.1));
    expect(sum(rungs) - overshoot).toBe(USDC(31.4));
  });

  it("covers exactly when the amount is already on the ladder", () => {
    const { rungs, overshoot } = cover(USDC(30), LADDER_USDC);
    expect(rungs).toEqual([USDC(25), USDC(5)]);
    expect(overshoot).toBe(0n);
  });

  it("covers a dust amount with a single smallest rung", () => {
    const { rungs, overshoot } = cover(1n, LADDER_USDC);
    expect(rungs).toEqual([USDC(0.5)]);
    expect(overshoot).toBe(USDC(0.5) - 1n);
  });

  it("covers zero with nothing", () => {
    expect(cover(0n, LADDER_USDC)).toEqual({ rungs: [], overshoot: 0n });
    expect(decompose(0n, LADDER_USDC)).toEqual({ rungs: [], residue: 0n });
  });

  it("never returns a rung that is not on the ladder", () => {
    for (const amount of [0.5, 3.3, 26, 101.7, 512]) {
      for (const r of cover(USDC(amount), LADDER_USDC).rungs) expect(LADDER_USDC).toContain(r);
      for (const r of decompose(USDC(amount), LADDER_USDC).rungs) expect(LADDER_USDC).toContain(r);
    }
  });

  it("keeps every rung above USDC's 0.07 minBalance", () => {
    // USDC is `isSufficient` on Asset Hub, so a withdrawal to a FRESH address
    // below the minimum fails account creation and the note is wasted. Every
    // rung must clear it on its own, because a note is withdrawn on its own.
    const MIN_BALANCE = USDC(0.07);
    for (const r of LADDER_USDC) expect(r).toBeGreaterThan(MIN_BALANCE);
  });

  it("keeps the ladder divisible, which is what makes greedy optimal", () => {
    // Greedy is only guaranteed minimal when each rung divides the next. If a
    // future ladder breaks that, decompose stops being optimal silently.
    for (const ladder of [LADDER_USDC, LADDER_NATIVE]) {
      for (let i = 1; i < ladder.length; i++) {
        expect(ladder[i] % ladder[i - 1], `${ladder[i]} is not a multiple of ${ladder[i - 1]}`).toBe(0n);
      }
    }
  });

  it("counts the notes a plan needs, which is what an observer sees", () => {
    // Each rung is its own deposit and its own withdrawal, so this is a privacy
    // number as much as a gas number. It is also wildly non-linear near a rung
    // boundary: 100 is one note, 99 is eleven. Worth surfacing in the UI —
    // nudging a top-up up to the next rung is cheaper AND quieter.
    expect(noteCount(cover(USDC(100), LADDER_USDC).rungs)).toBe(1);
    expect(noteCount(cover(USDC(99), LADDER_USDC).rungs)).toBe(11);
  });

  it("works on the native ladder too", () => {
    const { rungs, residue } = decompose(PAS(7), LADDER_NATIVE);
    expect(rungs).toEqual([PAS(5), PAS(1), PAS(1)]);
    expect(residue).toBe(0n);
  });

  it("still backs planShielding, so payouts and funding share one algorithm", () => {
    // shieldpayout.ts used to carry its own copy of this greedy. Two
    // implementations of the same rule drift; this pins them together.
    const buckets = [...LADDER_USDC];
    expect(planShielding(USDC(31.4), buckets)).toEqual(decompose(USDC(31.4), LADDER_USDC).rungs);
    expect(planShielding(USDC(0.42), buckets)).toEqual([]);
  });
});
