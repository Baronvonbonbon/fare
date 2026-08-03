import { describe, it, expect, vi, beforeEach } from "vitest";
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

// The venue-registry read and the relay hop are the only two things the
// send/receive half touches, and both are stubbed: what is under test is the
// fail-closed rule (no verifiable key → no ticket, never plaintext) and the
// venue-side selection. ethers and the channel have their own suites, and the
// SEALING here is real crypto — msg.ts is not stubbed.
let registeredSigner: string | null = null;
let registryThrows = false;

vi.mock("./chain", () => ({
  ADDRESSES: { venues: "0x" + "22".repeat(20) },
  readProvider: {},
}));

vi.mock("ethers", async (orig) => {
  const actual = await orig<typeof import("ethers")>();
  return {
    ...actual,
    Contract: vi.fn(function () {
      return {
        venues: async () => {
          if (registryThrows) throw new Error("no chain in this test");
          return { signer: registeredSigner };
        },
      };
    }),
  };
});

// An in-memory order thread. Deliberately an append-only mailbox anyone can
// write to, which is what the real relay is.
const inbox = new Map<string, { epk: string; iv: string; ct: string }[]>();
vi.mock("./channel", () => ({
  postTicket: async (orderId: bigint | string, sealed: { epk: string; iv: string; ct: string }) => {
    inbox.set(String(orderId), [...(inbox.get(String(orderId)) ?? []), sealed]);
    return true;
  },
  fetchTickets: async (orderId: bigint | string) => inbox.get(String(orderId)) ?? [],
}));

const { ticketTotalWei, verifyTicketTotal, venueKeyMatches, verifiedVenueKey, sendTicket, fetchTicket } =
  await import("./ticket");

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

// ── the send/receive half ────────────────────────────────────────────────────

const pubOf = (w: { privateKey: string }) => new SigningKey(w.privateKey).publicKey;

describe("resolving the venue's key against the registry", () => {
  beforeEach(() => { registeredSigner = null; registryThrows = false; });

  it("returns the key when it derives to the signer the registry names", async () => {
    const venue = Wallet.createRandom();
    registeredSigner = venue.address;
    expect(await verifiedVenueKey(1n, pubOf(venue))).toBe(pubOf(venue));
  });

  // A menu is public and mutable, so its signerPub is a claim. Trusting it would
  // hand the order to whoever published the menu.
  it("refuses a key the registry does not name", async () => {
    registeredSigner = Wallet.createRandom().address;
    expect(await verifiedVenueKey(1n, pubOf(Wallet.createRandom()))).toBeNull();
  });

  it("is null for a venue that has published no signer key at all", async () => {
    registeredSigner = Wallet.createRandom().address;
    expect(await verifiedVenueKey(1n, undefined)).toBeNull();
  });

  // Can't verify → don't encrypt. An unreachable registry must not degrade into
  // trusting the menu.
  it("is null when the registry read fails", async () => {
    registryThrows = true;
    const venue = Wallet.createRandom();
    registeredSigner = venue.address;
    expect(await verifiedVenueKey(1n, pubOf(venue))).toBeNull();
  });
});

describe("sending a ticket", () => {
  beforeEach(() => { registeredSigner = null; registryThrows = false; inbox.clear(); });

  it("seals to the verified venue key and drops it on the thread", async () => {
    const venue = Wallet.createRandom();
    registeredSigner = venue.address;

    expect(await sendTicket(ticket(), pubOf(venue))).toBe(true);
    const posted = inbox.get("7")!;
    expect(posted).toHaveLength(1);
    // what went on the wire is ciphertext, not the menu
    expect(JSON.stringify(posted[0])).not.toContain("Pad Thai");
  });

  // The escrow and the delivery still work without a ticket, so this reports
  // false rather than failing the order — but it must never fall back to
  // posting the items in the clear.
  it("fails closed when there is no verifiable key — and posts nothing", async () => {
    registeredSigner = Wallet.createRandom().address;
    expect(await sendTicket(ticket(), pubOf(Wallet.createRandom()))).toBe(false);
    expect(inbox.get("7")).toBeUndefined();
  });
});

describe("the venue reading its thread", () => {
  const venue = Wallet.createRandom();

  beforeEach(() => { registeredSigner = venue.address; registryThrows = false; inbox.clear(); });

  const send = async (t: OrderTicket, to = venue) => {
    registeredSigner = to.address;
    const ok = await sendTicket(t, pubOf(to));
    registeredSigner = venue.address;
    return ok;
  };

  it("opens the ticket and reports it bound to the escrow", async () => {
    await send(ticket());
    const got = await fetchTicket(7n, venue.privateKey, parseEther("4"));
    expect(got!.verdict).toBe("bound");
    expect(got!.totalWei).toBe(parseEther("4"));
    expect(got!.ticket.lines).toEqual(lines);
  });

  it("surfaces a mismatch rather than hiding it — the kitchen decides", async () => {
    await send(ticket());
    const got = await fetchTicket(7n, venue.privateKey, parseEther("9"));
    expect(got!.verdict).toBe("mismatch");
  });

  // The thread is an open mailbox. A ticket sealed to someone else is noise:
  // it must not decrypt, and it must not displace the real one.
  it("skips a ticket sealed to another key", async () => {
    await send(ticket({ lines: [{ name: "forged", price: "99", qty: 1 }] }), Wallet.createRandom());
    expect(await fetchTicket(7n, venue.privateKey, parseEther("4"))).toBeNull();

    await send(ticket());
    const got = await fetchTicket(7n, venue.privateKey, parseEther("4"));
    expect(got!.verdict).toBe("bound");
    expect(got!.ticket.lines).toEqual(lines);
  });

  it("takes the bound ticket even when a mismatching one was posted after it", async () => {
    await send(ticket());
    await send(ticket({ lines: [{ name: "cheap", price: "0.01", qty: 1 }], placedAt: 99 }));
    expect((await fetchTicket(7n, venue.privateKey, parseEther("4")))!.verdict).toBe("bound");
  });

  it("keeps the latest when none of them match — a re-send supersedes", async () => {
    await send(ticket({ lines: [{ name: "old", price: "1", qty: 1 }], placedAt: 1 }));
    await send(ticket({ lines: [{ name: "new", price: "2", qty: 1 }], placedAt: 2 }));
    const got = await fetchTicket(7n, venue.privateKey, parseEther("4"));
    expect(got!.verdict).toBe("mismatch");
    expect(got!.ticket.lines[0].name).toBe("new");
  });

  // Replaying order 8's ticket onto order 7's thread. It decrypts — same venue
  // key — so only the orderId check inside the payload stops it being read as
  // this order's food.
  it("ignores a ticket addressed to a different order", async () => {
    const replayed = await sealAnon(
      pubOf(venue), "fare-ticket:v1:7", JSON.stringify(ticket({ orderId: "8" }))
    );
    inbox.set("7", [replayed]);
    expect(await fetchTicket(7n, venue.privateKey, parseEther("4"))).toBeNull();
  });

  it("ignores a decryptable payload that isn't a ticket", async () => {
    await send({ orderId: "7", venueId: "1", placedAt: 1 } as any); // no lines
    expect(await fetchTicket(7n, venue.privateKey, parseEther("4"))).toBeNull();
  });

  it("is null for a thread with nothing on it", async () => {
    expect(await fetchTicket(7n, venue.privateKey, parseEther("4"))).toBeNull();
  });
});
