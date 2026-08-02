import { describe, it, expect } from "vitest";
import { Wallet, SigningKey, parseEther } from "ethers";
import { sealAnon, openAnon } from "./msg";
import type { OrderTicket, TicketLine } from "./ticket";

// ticket.ts reaches the chain for the venue-signer check, and chain.ts reads
// localStorage at module load — so stub it before importing (the sealedbid.test
// pattern).
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
(globalThis as any).localStorage = new MemStorage();

const { ticketTotalWei, verifyTicketTotal, venueKeyMatches } = await import("./ticket");

const lines: TicketLine[] = [
  { name: "Pad Thai", price: "1.5", qty: 2 },
  { name: "Spring roll", price: "0.25", qty: 4 },
];

const ticket = (over: Partial<OrderTicket> = {}): OrderTicket => ({
  orderId: "7",
  venueId: "1",
  venueName: "Golden Gate Grill",
  lines,
  placedAt: 1,
  ...over,
});

describe("ticket totals", () => {
  it("sums quantity × unit price", () => {
    expect(ticketTotalWei(ticket())).toBe(parseEther("4")); // 2×1.5 + 4×0.25
  });

  it("adds modifier deltas to the unit price before multiplying by qty", () => {
    const t = ticket({
      lines: [{ name: "Pad Thai", price: "1.5", qty: 2, choices: [{ name: "extra peanuts", priceDelta: "0.5" }] }],
    });
    expect(ticketTotalWei(t)).toBe(parseEther("4")); // (1.5 + 0.5) × 2
  });

  it("skips a malformed price rather than throwing", () => {
    const t = ticket({ lines: [{ name: "?", price: "not-a-number", qty: 1 }, ...lines] });
    expect(ticketTotalWei(t)).toBe(parseEther("4"));
  });

  it("treats a negative or fractional qty as floor-clamped", () => {
    expect(ticketTotalWei(ticket({ lines: [{ name: "x", price: "1", qty: -3 }] }))).toBe(0n);
    expect(ticketTotalWei(ticket({ lines: [{ name: "x", price: "1", qty: 2.7 }] }))).toBe(parseEther("2"));
  });
});

describe("binding a ticket to the escrow", () => {
  it("is bound when the lines add up to orderValue", () => {
    expect(verifyTicketTotal(ticket(), parseEther("4"))).toBe("bound");
  });

  it("is a mismatch when they do not", () => {
    expect(verifyTicketTotal(ticket(), parseEther("3.99"))).toBe("mismatch");
  });

  // The zero-payment-rail venue (README): FARE escrows only the delivery fare
  // and the food is paid for at the counter, so there is no on-chain amount to
  // check against. Reporting "bound" there would be a match that never happened.
  it("is unpriced when orderValue is 0, not a false match", () => {
    expect(verifyTicketTotal(ticket(), 0n)).toBe("unpriced");
    expect(verifyTicketTotal(ticket({ lines: [] }), 0n)).toBe("unpriced");
  });
});

describe("the venue key check", () => {
  it("accepts a pubkey that derives to the registered signer", () => {
    const w = Wallet.createRandom();
    expect(venueKeyMatches(new SigningKey(w.privateKey).publicKey, w.address)).toBe(true);
  });

  it("rejects a key belonging to anyone else — a menu is a claim, not an authority", () => {
    const signer = Wallet.createRandom();
    const impostor = Wallet.createRandom();
    expect(venueKeyMatches(new SigningKey(impostor.privateKey).publicKey, signer.address)).toBe(false);
  });

  it("rejects a malformed key instead of throwing", () => {
    expect(venueKeyMatches("0xnot-a-key", Wallet.createRandom().address)).toBe(false);
  });
});

describe("sealing to the venue", () => {
  const context = "fare-ticket:v1:7";

  it("round-trips the line items to the signer key", async () => {
    const venue = Wallet.createRandom();
    const sealed = await sealAnon(new SigningKey(venue.privateKey).publicKey, context, JSON.stringify(ticket()));
    const opened = JSON.parse(await openAnon(venue.privateKey, context, sealed)) as OrderTicket;
    expect(opened.lines).toEqual(lines);
    expect(ticketTotalWei(opened)).toBe(parseEther("4"));
  });

  it("does not open with any other key — the relay carrying it learns nothing", async () => {
    const venue = Wallet.createRandom();
    const eavesdropper = Wallet.createRandom();
    const sealed = await sealAnon(new SigningKey(venue.privateKey).publicKey, context, JSON.stringify(ticket()));
    await expect(openAnon(eavesdropper.privateKey, context, sealed)).rejects.toThrow();
  });

  it("does not open under another order's context — tickets don't cross orders", async () => {
    const venue = Wallet.createRandom();
    const sealed = await sealAnon(new SigningKey(venue.privateKey).publicKey, context, JSON.stringify(ticket()));
    await expect(openAnon(venue.privateKey, "fare-ticket:v1:8", sealed)).rejects.toThrow();
  });

  it("carries no sender identity: two tickets from one customer share no key material", async () => {
    const venue = Wallet.createRandom();
    const pub = new SigningKey(venue.privateKey).publicKey;
    const a = await sealAnon(pub, context, JSON.stringify(ticket()));
    const b = await sealAnon(pub, context, JSON.stringify(ticket()));
    expect(a.epk).not.toBe(b.epk);
  });
});
