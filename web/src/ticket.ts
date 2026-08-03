// Order tickets — what the venue actually cooks (docs/PRODUCT-INTEGRATION-PLAN.md B1).
//
// The cart is priced client-side and only its TOTAL reaches the chain, as
// `orderValue`. The line items never left the customer's device: they went into
// the local receipt (B7) and nowhere else. So a venue saw a venueId and an
// escrowed amount and had no way to know what to make. This module is the
// missing half — it carries the line items to the venue, and only to the venue.
//
//   sealed   with `sealAnon` (msg.ts) under a FRESH ephemeral key, so the relay
//            carrying the ticket learns nothing, and the envelope binds the
//            items to no sender.
//   targeted at the venue's HOT SIGNER key. An address can't be encrypted to, so
//            the pubkey travels in the (public) menu and is used only once it
//            derives to the signer the registry names — the same fail-closed
//            check `capsule.ts` applies to the arbiter. A wrong or hostile key
//            in a menu is then a no-op, not a leak.
//   bound    to the escrow: the venue re-adds the lines and compares against the
//            on-chain `orderValue`. A forged ticket that doesn't sum to what was
//            escrowed is rejected — no on-chain commitment needed for it, because
//            the amount is already on-chain.
//
// The customer stays anonymous to the transport, not to the venue: the venue can
// read `orders(id).customer` itself. What this hides is the ITEMS, from everyone
// who is not cooking them.
import { Contract, computeAddress, parseEther, type Provider } from "ethers";
import { ADDRESSES, readProvider } from "./chain";
import { VENUES_ABI } from "./abi";
import { sealAnon, openAnon, type AnonSealed } from "./msg";
import { postTicket, fetchTickets } from "./channel";

/// One line of a ticket. `price` is the unit price BEFORE modifiers; `choices`
/// carries the selected modifier deltas, so the venue sees the same
/// configuration the customer paid for. Both are decimal PAS strings, matching
/// `MenuItem.price` — the ticket is a transcript of the menu, not a second
/// pricing model.
export interface TicketLine {
  name: string;
  price: string;
  qty: number;
  choices?: { name: string; priceDelta: string }[];
}

export interface OrderTicket {
  orderId: string;
  venueId: string;
  venueName?: string;
  lines: TicketLine[];
  note?: string; // customer's note to the kitchen
  placedAt: number;
}

const ticketContext = (orderId: bigint | string) => `fare-ticket:v1:${orderId}`;

// ── pricing ──────────────────────────────────────────────────────────────────

function lineWei(l: TicketLine): bigint {
  let unit = parseEther(l.price || "0");
  for (const c of l.choices ?? []) unit += parseEther(c.priceDelta || "0");
  return unit * BigInt(Math.max(0, Math.trunc(l.qty)));
}

/// What the ticket says it costs, in wei.
export function ticketTotalWei(t: OrderTicket): bigint {
  let total = 0n;
  for (const l of t.lines) {
    try {
      total += lineWei(l);
    } catch {
      /* malformed price — a line that can't be priced can't be counted */
    }
  }
  return total;
}

/// How much a ticket can be trusted against the chain.
///
/// `unpriced` is not a failure. A venue keeping its own POS onboards with
/// `orderValue = 0` — FARE escrows only the delivery fare and the food is paid
/// for off-chain (README, "zero payment-rail migration"). There is then no
/// on-chain amount to check the lines against, and saying so is more honest than
/// reporting a match that was never tested.
export type TicketVerdict = "bound" | "unpriced" | "mismatch";

export function verifyTicketTotal(t: OrderTicket, orderValueWei: bigint): TicketVerdict {
  if (orderValueWei === 0n) return "unpriced";
  return ticketTotalWei(t) === orderValueWei ? "bound" : "mismatch";
}

// ── the venue's key ──────────────────────────────────────────────────────────

/// Is `pubKey` really the hot signer this venue registered? The menu is public
/// and mutable, so its `signerPub` is a claim, not an authority. Encrypting to an
/// unverified key would hand the order to whoever published the menu.
export function venueKeyMatches(pubKey: string, signerAddress: string): boolean {
  try {
    return computeAddress(pubKey).toLowerCase() === signerAddress.toLowerCase();
  } catch {
    return false;
  }
}

/// The venue signer pubkey to seal to, or null if there isn't a trustworthy one.
/// Null is a normal outcome — a venue that hasn't republished its menu since this
/// shipped has no `signerPub` — and callers must treat it as "no ticket", never
/// as "send it in the clear".
export async function verifiedVenueKey(
  venueId: bigint | string, signerPub?: string, provider: Provider = readProvider as any
): Promise<string | null> {
  if (!signerPub) return null;
  try {
    const venues = new Contract(ADDRESSES.venues, VENUES_ABI, provider as any);
    const v = await venues.venues(venueId);
    return venueKeyMatches(signerPub, v.signer) ? signerPub : null;
  } catch {
    return null; // can't verify → don't encrypt
  }
}

// ── send / receive ───────────────────────────────────────────────────────────

/// Seal the ticket to the venue and drop it on the order thread. Returns false
/// when there is no verifiable venue key, so the caller can tell the customer
/// their venue won't receive the items rather than failing the order — the
/// escrow and the delivery still work without it.
export async function sendTicket(
  ticket: OrderTicket, signerPub?: string, provider: Provider = readProvider as any
): Promise<boolean> {
  const venuePub = await verifiedVenueKey(ticket.venueId, signerPub, provider);
  if (!venuePub) return false;
  const sealed = await sealAnon(venuePub, ticketContext(ticket.orderId), JSON.stringify(ticket));
  return postTicket(ticket.orderId, sealed);
}

export interface ReceivedTicket {
  ticket: OrderTicket;
  verdict: TicketVerdict;
  totalWei: bigint;
}

/// Venue side: open the tickets on an order's thread with the hot signer key and
/// keep the one that checks out.
///
/// The thread is an open mailbox, so anyone can post to it. That is fine: a
/// ticket not sealed to this signer won't decrypt, and one that decrypts but
/// doesn't sum to the escrow comes back `mismatch` for the kitchen to see rather
/// than being silently shown as real.
export async function fetchTicket(
  orderId: bigint | string, signerPrivateKey: string, orderValueWei: bigint
): Promise<ReceivedTicket | null> {
  let best: ReceivedTicket | null = null;
  for (const sealed of await fetchTickets(orderId)) {
    let ticket: OrderTicket;
    try {
      ticket = JSON.parse(await openAnon(signerPrivateKey, ticketContext(orderId), sealed)) as OrderTicket;
    } catch {
      continue; // not sealed to us, or tampered
    }
    if (!Array.isArray(ticket.lines) || String(ticket.orderId) !== String(orderId)) continue;
    const received: ReceivedTicket = {
      ticket,
      verdict: verifyTicketTotal(ticket, orderValueWei),
      totalWei: ticketTotalWei(ticket),
    };
    // A ticket that matches the escrow wins outright; otherwise keep the latest
    // so a re-send supersedes, and a mismatch is still surfaced rather than hidden.
    if (received.verdict === "bound") return received;
    if (!best || (ticket.placedAt ?? 0) >= (best.ticket.placedAt ?? 0)) best = received;
  }
  return best;
}

export type { AnonSealed };
