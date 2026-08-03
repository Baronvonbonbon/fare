// Venue tablet mode — the counter-side board.
//
// The venue view was built around one moment: a driver is standing here, sign
// the release. A kitchen needs the moment BEFORE that — an order arrived, start
// cooking — which is `status === 1` (Open), often minutes before any driver has
// bid. So the board covers everything not yet handed over, and the pickup
// signing stays where it was.
//
// Prep state is deliberately DEVICE-LOCAL. "Cooking" and "ready" are the
// kitchen's own workflow, not protocol facts: putting them on-chain would cost
// gas per state change, publish the venue's throughput to any indexer, and mean
// nothing to the contract, which cares only that a pickup was cosigned. The
// on-chain "accept" remains `confirmPickup`.

export type PrepState = "new" | "cooking" | "ready";

const PREP_KEY = "fare.kitchen.prep";
const ORDER: PrepState[] = ["new", "cooking", "ready"];

type PrepMap = Record<string, PrepState>;

function load(): PrepMap {
  try {
    return JSON.parse(localStorage.getItem(PREP_KEY) || "{}") as PrepMap;
  } catch {
    return {};
  }
}

function save(m: PrepMap): void {
  localStorage.setItem(PREP_KEY, JSON.stringify(m));
}

export function prepOf(orderId: bigint | string): PrepState {
  return load()[String(orderId)] ?? "new";
}

export function setPrep(orderId: bigint | string, state: PrepState): void {
  save({ ...load(), [String(orderId)]: state });
}

/// Advance one step and return the new state; "ready" is the end (the next
/// transition is `confirmPickup`, which is on-chain and not ours to fake).
export function advancePrep(orderId: bigint | string): PrepState {
  const next = ORDER[Math.min(ORDER.length - 1, ORDER.indexOf(prepOf(orderId)) + 1)];
  setPrep(orderId, next);
  return next;
}

/// Forget prep state for orders that have left the board, so the record doesn't
/// grow forever on a tablet that never reloads.
export function prunePrep(liveOrderIds: (bigint | string)[]): void {
  const live = new Set(liveOrderIds.map(String));
  const m = load();
  const kept: PrepMap = {};
  for (const [id, s] of Object.entries(m)) if (live.has(id)) kept[id] = s;
  save(kept);
}

// ── the board ────────────────────────────────────────────────────────────────

export interface KitchenOrder {
  id: bigint;
  venueId: bigint;
  status: number;
  createdAt: bigint;
}

export interface KitchenTicket<T extends KitchenOrder> {
  o: T;
  prep: PrepState;
  /// Seconds since the order was created — how long the customer has waited.
  waitedSec: number;
  /// True once nobody has started it and it has been sitting too long.
  overdue: boolean;
}

/// What the counter should be looking at, oldest first.
///
/// FIFO is not a detail: a kitchen board sorted any other way silently reorders
/// the queue and the customer who waited longest gets served last. Orders past
/// pickup (status 3+) are gone — the food has left the building — and cancelled
/// orders drop off rather than lingering as work nobody should do.
export function kitchenBoard<T extends KitchenOrder>(
  orders: T[],
  myVenueIds: Set<string>,
  nowSec: number,
  overdueAfterSec = 15 * 60
): KitchenTicket<T>[] {
  return orders
    .filter((o) => myVenueIds.has(String(o.venueId)) && (o.status === 1 || o.status === 2))
    .map((o) => {
      const waitedSec = Math.max(0, nowSec - Number(o.createdAt));
      const prep = prepOf(o.id);
      return { o, prep, waitedSec, overdue: prep !== "ready" && waitedSec > overdueAfterSec };
    })
    .sort((a, b) => Number(a.o.createdAt - b.o.createdAt));
}

// ── the alert ────────────────────────────────────────────────────────────────

/// A short two-tone chime for a tablet across the room. Synthesized rather than
/// bundled: no asset to load, works offline, and no autoplay-blocked <audio>
/// element. Browsers still gate WebAudio until the page has been interacted
/// with, so this is silent until someone has touched the tablet once — which on
/// a counter device happens immediately.
export function chime(): void {
  try {
    const Ctx = (window as any).AudioContext ?? (window as any).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    for (const [i, freq] of [880, 1320].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.type = "sine";
      // Ramp instead of a hard stop — a square-edged gate clicks.
      gain.gain.setValueAtTime(0.0001, now + i * 0.18);
      gain.gain.exponentialRampToValueAtTime(0.3, now + i * 0.18 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.18 + 0.16);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + i * 0.18);
      osc.stop(now + i * 0.18 + 0.18);
    }
    setTimeout(() => ctx.close().catch(() => {}), 1000);
  } catch {
    /* no audio on this device — the visual + notification still fire */
  }
}
