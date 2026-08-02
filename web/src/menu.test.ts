import { describe, it, expect } from "vitest";
import { parseEther } from "ethers";

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
(globalThis as any).localStorage = new MemStorage();

const {
  cartTotal, cartCount, addToCart, setLineQty, findLine, lineKey,
  resolveCart, resolveLine, selectionError, menuCategories, itemsInCategory,
  isOpenAt, imageUrl, MENU_VERSION,
} = await import("./menu");
const { ticketTotalWei } = await import("./ticket");
import type { Menu, MenuItem, Cart } from "./menu";

const size: MenuItem["options"] = [
  {
    id: "g1", name: "Size", required: true, min: 1, max: 1,
    choices: [
      { id: "sm", name: "Small", priceDelta: "0" },
      { id: "lg", name: "Large", priceDelta: "0.5" },
    ],
  },
  {
    id: "g2", name: "Extras", max: 2,
    choices: [
      { id: "peanuts", name: "Extra peanuts", priceDelta: "0.25" },
      { id: "lime", name: "Extra lime", priceDelta: "0.1" },
    ],
  },
];

const menu = (over: Partial<Menu> = {}): Menu => ({
  name: "Golden Gate Grill",
  version: MENU_VERSION,
  updatedAt: 0,
  categories: [
    { id: "c-main", name: "Mains", order: 1 },
    { id: "c-start", name: "Starters", order: 0 },
  ],
  items: [
    { id: "pad", name: "Pad Thai", price: "1.5", category: "c-main", options: size },
    { id: "roll", name: "Spring roll", price: "0.25", category: "c-start" },
    { id: "water", name: "Water", price: "0.1" },
  ],
  ...over,
});

describe("the cart", () => {
  it("prices quantity × unit price", () => {
    const cart = addToCart(addToCart([], "pad", ["sm"], 2), "roll", [], 4);
    expect(cartTotal(menu(), cart)).toBe(parseEther("4"));
    expect(cartCount(cart)).toBe(6);
  });

  it("adds modifier deltas to the unit price", () => {
    const cart = addToCart([], "pad", ["lg", "peanuts"], 2);
    expect(cartTotal(menu(), cart)).toBe(parseEther("4.5")); // (1.5 + 0.5 + 0.25) × 2
  });

  // Two of the same dish with different options are different things to cook.
  it("keeps differently-configured lines apart but merges identical ones", () => {
    let cart: Cart = addToCart([], "pad", ["sm"]);
    cart = addToCart(cart, "pad", ["lg"]);
    expect(cart).toHaveLength(2);
    cart = addToCart(cart, "pad", ["sm"]);
    expect(cart).toHaveLength(2);
    expect(cart[0].qty).toBe(2);
  });

  it("treats option order as insignificant when merging", () => {
    expect(lineKey("pad", ["lg", "peanuts"])).toBe(lineKey("pad", ["peanuts", "lg"]));
    const cart = addToCart(addToCart([], "pad", ["lg", "peanuts"]), "pad", ["peanuts", "lg"]);
    expect(cart).toHaveLength(1);
    expect(cart[0].qty).toBe(2);
  });

  it("drops a line when its quantity reaches zero", () => {
    const cart = addToCart([], "pad", [], 1);
    expect(setLineQty(cart, 0, 0)).toEqual([]);
    expect(findLine(cart, "pad", [])).toBe(0);
    expect(findLine(cart, "pad", ["lg"])).toBe(-1);
  });

  it("ignores a line whose item vanished from the menu", () => {
    const cart = addToCart([], "deleted-dish", [], 3);
    expect(resolveCart(menu(), cart)).toEqual([]);
    expect(cartTotal(menu(), cart)).toBe(0n);
  });

  it("resolves a line to the names the kitchen needs", () => {
    const line = resolveLine(menu(), { itemId: "pad", qty: 2, choices: ["lg"] });
    expect(line).toEqual({
      name: "Pad Thai", price: "1.5", qty: 2, choices: [{ name: "Large", priceDelta: "0.5" }],
    });
  });
});

// The venue rejects a ticket whose lines don't sum to the escrowed orderValue,
// so if these two ever disagree every honest ticket reads as forged.
describe("cart pricing agrees with ticket pricing", () => {
  it("matches over a cart with modifiers", () => {
    const m = menu();
    const cart = addToCart(addToCart([], "pad", ["lg", "peanuts"], 2), "roll", [], 3);
    const total = cartTotal(m, cart);
    const lines = resolveCart(m, cart);
    expect(ticketTotalWei({ orderId: "1", venueId: "1", lines, placedAt: 0 })).toBe(total);
  });
});

describe("option validation", () => {
  const pad = menu().items[0];

  it("requires a choice from a required group", () => {
    expect(selectionError(pad, [])).toMatch(/Size/);
    expect(selectionError(pad, ["sm"])).toBeNull();
  });

  it("enforces the maximum", () => {
    expect(selectionError(pad, ["sm", "lg"])).toMatch(/Size/);
    expect(selectionError(pad, ["sm", "peanuts", "lime"])).toBeNull();
  });

  it("passes an item with no options at all", () => {
    expect(selectionError(menu().items[2], [])).toBeNull();
  });
});

describe("categories", () => {
  it("returns declared categories in their declared order", () => {
    expect(menuCategories(menu()).map((c) => c.name)).toEqual(["Starters", "Mains"]);
  });

  // Upgrading the client must not flatten a menu published before v2.
  it("synthesizes categories from a v1 menu's free-text strings", () => {
    const v1 = menu({
      version: 1, categories: undefined,
      items: [
        { id: "a", name: "A", price: "1", category: "Drinks" },
        { id: "b", name: "B", price: "1", category: "Food" },
        { id: "c", name: "C", price: "1", category: "Drinks" },
      ],
    });
    expect(menuCategories(v1).map((c) => c.name)).toEqual(["Drinks", "Food"]);
    expect(itemsInCategory(v1, "Drinks").map((i) => i.id)).toEqual(["a", "c"]);
  });

  it("collects uncategorized items under null", () => {
    expect(itemsInCategory(menu(), null).map((i) => i.id)).toEqual(["water"]);
  });

  it("treats an item pointing at a category that no longer exists as uncategorized", () => {
    const m = menu({ items: [{ id: "x", name: "X", price: "1", category: "c-gone" }] });
    expect(itemsInCategory(m, null).map((i) => i.id)).toEqual(["x"]);
  });
});

describe("opening hours", () => {
  const at = (day: number, h: number, min = 0) => {
    // 2026-08-02 is a Sunday, so +day lands on weekday `day`.
    const d = new Date(2026, 7, 2 + day, h, min);
    expect(d.getDay()).toBe(day);
    return d;
  };
  const week = (over: Record<number, { open: string; close: string } | null> = {}) =>
    Array.from({ length: 7 }, (_, i) => (i in over ? over[i] : { open: "09:00", close: "17:00" }));

  it("reads a venue with no schedule as open, not permanently closed", () => {
    expect(isOpenAt(menu(), at(1, 3))).toBe(true);
  });

  it("is open inside the window and closed outside it", () => {
    const m = menu({ schedule: week() });
    expect(isOpenAt(m, at(1, 12))).toBe(true);
    expect(isOpenAt(m, at(1, 8, 59))).toBe(false);
    expect(isOpenAt(m, at(1, 17))).toBe(false); // closing time is exclusive
  });

  it("is closed on a day marked null", () => {
    expect(isOpenAt(menu({ schedule: week({ 1: null }) }), at(1, 12))).toBe(false);
  });

  // A kitchen trading 18:00–02:00 must not read as closed at 01:00.
  it("handles a window that runs past midnight, including into the next day", () => {
    const m = menu({ schedule: week({ 1: { open: "18:00", close: "02:00" } }) });
    expect(isOpenAt(m, at(1, 20))).toBe(true);
    expect(isOpenAt(m, at(1, 23, 59))).toBe(true);
    expect(isOpenAt(m, at(2, 1))).toBe(true); // Tuesday 01:00 belongs to Monday's window
    expect(isOpenAt(m, at(2, 3))).toBe(false);
  });

  it("does not hide a venue whose hours are malformed", () => {
    expect(isOpenAt(menu({ schedule: week({ 1: { open: "nonsense", close: "17:00" } }) }), at(1, 12))).toBe(true);
  });
});

describe("image URLs", () => {
  it("is empty for a missing CID so callers can test it", () => {
    expect(imageUrl(undefined)).toBe("");
    expect(imageUrl("")).toBe("");
  });

  it("resolves a bare CID and an ipfs:// URI to the same gateway URL", () => {
    expect(imageUrl("bafyfake")).toBe(imageUrl("ipfs://bafyfake"));
    expect(imageUrl("bafyfake")).toMatch(/bafyfake$/);
  });

  it("passes an already-usable URL through untouched", () => {
    expect(imageUrl("https://example.com/a.jpg")).toBe("https://example.com/a.jpg");
    expect(imageUrl("blob:abc")).toBe("blob:abc");
  });
});
