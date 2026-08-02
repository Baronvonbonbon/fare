import { describe, it, expect, beforeEach } from "vitest";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
(globalThis as any).localStorage = new MemStorage();

const { prepOf, setPrep, advancePrep, prunePrep, kitchenBoard } = await import("./kitchen");

type O = { id: bigint; venueId: bigint; status: number; createdAt: bigint };
const order = (id: number, over: Partial<O> = {}): O => ({
  id: BigInt(id), venueId: 1n, status: 1, createdAt: 1000n, ...over,
});

const MINE = new Set(["1"]);

beforeEach(() => (globalThis as any).localStorage.clear());

describe("prep state", () => {
  it("defaults to new", () => {
    expect(prepOf(7n)).toBe("new");
  });

  it("round-trips through storage", () => {
    setPrep(7n, "cooking");
    expect(prepOf(7n)).toBe("cooking");
    expect(prepOf("7")).toBe("cooking"); // bigint and string key the same order
  });

  it("advances new → cooking → ready and stops there", () => {
    expect(advancePrep(7n)).toBe("cooking");
    expect(advancePrep(7n)).toBe("ready");
    expect(advancePrep(7n)).toBe("ready"); // the next step is confirmPickup, on-chain
  });

  it("prunes orders that have left the board", () => {
    setPrep(1n, "cooking");
    setPrep(2n, "ready");
    prunePrep([1n]);
    expect(prepOf(1n)).toBe("cooking");
    expect(prepOf(2n)).toBe("new"); // forgotten
  });
});

describe("the kitchen board", () => {
  it("shows open and assigned orders for my venues only", () => {
    const board = kitchenBoard(
      [order(1), order(2, { status: 2 }), order(3, { venueId: 9n })],
      MINE,
      1000
    );
    expect(board.map((t) => Number(t.o.id))).toEqual([1, 2]);
  });

  it("drops orders past pickup — the food has already left", () => {
    const board = kitchenBoard([order(1, { status: 3 }), order(2, { status: 4 })], MINE, 1000);
    expect(board).toHaveLength(0);
  });

  it("drops cancelled orders rather than leaving work nobody should do", () => {
    expect(kitchenBoard([order(1, { status: 5 })], MINE, 1000)).toHaveLength(0);
  });

  // A board sorted any other way silently reorders the queue and the customer
  // who waited longest gets served last.
  it("is FIFO by creation time", () => {
    const board = kitchenBoard(
      [order(3, { createdAt: 300n }), order(1, { createdAt: 100n }), order(2, { createdAt: 200n })],
      MINE,
      1000
    );
    expect(board.map((t) => Number(t.o.id))).toEqual([1, 2, 3]);
  });

  it("reports how long each order has waited, never negative", () => {
    const [a, b] = kitchenBoard([order(1, { createdAt: 100n }), order(2, { createdAt: 5000n })], MINE, 1000);
    expect(a.waitedSec).toBe(900);
    expect(b.waitedSec).toBe(0); // clock skew must not render as a negative wait
  });

  it("flags an order overdue once it has sat past the threshold", () => {
    const [t] = kitchenBoard([order(1, { createdAt: 0n })], MINE, 16 * 60, 15 * 60);
    expect(t.overdue).toBe(true);
  });

  it("does not flag an order that is already plated", () => {
    setPrep(1n, "ready");
    const [t] = kitchenBoard([order(1, { createdAt: 0n })], MINE, 16 * 60, 15 * 60);
    expect(t.overdue).toBe(false);
  });

  it("carries each order's prep state onto the board", () => {
    setPrep(2n, "cooking");
    const board = kitchenBoard([order(1), order(2)], MINE, 1000);
    expect(board.map((t) => t.prep)).toEqual(["new", "cooking"]);
  });
});
