import { describe, it, expect, vi, beforeEach } from "vitest";

// Driver reputation on the customer's bid cards (A6r). The point of this
// surface is that a customer chooses who comes to their house, so the failure
// mode that matters is a number that flatters a driver who has not earned it.

const DRIVERS = "0x" + "33".repeat(20);
let registry: Record<string, any> = {};
let failFor = new Set<string>();

vi.mock("./chain", () => ({
  ADDRESSES: { drivers: DRIVERS },
  readProvider: {},
}));

vi.mock("ethers", async (orig) => {
  const actual = await orig<typeof import("ethers")>();
  return {
    ...actual,
    Contract: vi.fn(function () {
      return {
        drivers: async (addr: string) => {
          if (failFor.has(addr.toLowerCase())) throw new Error("registry unreachable");
          return registry[addr.toLowerCase()] ?? { delivered: 0n, failed: 0n, banned: false };
        },
      };
    }),
  };
});

const { summarize, fmtReputation, fetchReputations, NO_HISTORY } = await import("./reputation");

const A = "0x" + "aa".repeat(20);
const B = "0x" + "bb".repeat(20);

describe("summarizing a record", () => {
  it("counts completed jobs and the share delivered", () => {
    const r = summarize(9, 1);
    expect(r).toMatchObject({ delivered: 9, failed: 1, total: 10, successPct: 90 });
  });

  // Both alternatives are claims about a record that does not exist.
  it("reports no history as null, not 0% and not 100%", () => {
    expect(summarize(0, 0).successPct).toBeNull();
    expect(NO_HISTORY.successPct).toBeNull();
  });

  it("is 100% only when nothing has ever failed", () => {
    expect(summarize(7, 0).successPct).toBe(100);
  });

  // 199/200 rounds to 100 and would render a driver with a failure on record as
  // flawless. The cap is the whole reason rounding is not left to toFixed.
  it("never rounds up to 100 while a failure is on record", () => {
    expect(summarize(199, 1).successPct).toBe(99);
    expect(summarize(9999, 1).successPct).toBe(99);
  });

  it("clamps nonsense counts rather than propagating them", () => {
    expect(summarize(-5, 2)).toMatchObject({ delivered: 0, failed: 2, successPct: 0 });
    expect(summarize(2.9, 0).delivered).toBe(2);
  });

  it("carries the ban flag", () => {
    expect(summarize(3, 0, true).banned).toBe(true);
  });
});

describe("what the card shows", () => {
  it("distinguishes a new driver from a perfect one", () => {
    expect(fmtReputation(summarize(0, 0))).toBe("new driver");
    expect(fmtReputation(summarize(5, 0))).toBe("✓5 · ✗0 · 100%");
  });

  it("shows the failures, not just the successes", () => {
    expect(fmtReputation(summarize(9, 1))).toBe("✓9 · ✗1 · 90%");
  });

  it("says banned outright, whatever the counts", () => {
    expect(fmtReputation(summarize(50, 0, true))).toBe("banned");
  });
});

describe("fetching for a set of bidders", () => {
  beforeEach(() => { registry = {}; failFor = new Set(); });

  it("keys by lowercased address", async () => {
    registry[A.toLowerCase()] = { delivered: 4n, failed: 1n, banned: false };
    const m = await fetchReputations([A.toUpperCase()]);
    expect(m.get(A.toLowerCase())).toMatchObject({ delivered: 4, failed: 1, successPct: 80 });
  });

  it("reads each driver once even when they bid twice", async () => {
    registry[A.toLowerCase()] = { delivered: 1n, failed: 0n, banned: false };
    const m = await fetchReputations([A, A, A]);
    expect(m.size).toBe(1);
  });

  // "We could not reach the registry" and "this driver has never delivered"
  // must not render the same, so an unreachable one is absent rather than zero.
  it("omits a driver whose read failed instead of inventing a zero", async () => {
    registry[B.toLowerCase()] = { delivered: 2n, failed: 0n, banned: false };
    failFor.add(A.toLowerCase());
    const m = await fetchReputations([A, B]);
    expect(m.has(A.toLowerCase())).toBe(false);
    expect(m.get(B.toLowerCase())!.delivered).toBe(2);
  });

  it("is empty for no bidders and makes no call", async () => {
    expect((await fetchReputations([])).size).toBe(0);
  });
});
