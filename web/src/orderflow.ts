// Order-flow decision logic, extracted from App.tsx (TEST-PLAN D1/D2).
//
// App.tsx is 2,600+ lines of component and had no tests. The parts worth
// testing are not the markup — they are the decisions buried in it: when an
// order counts as abandoned, which jobs a driver is shown, and what actually
// happens when a customer presses Place order.
//
// This is the same move C5 made for the ops consoles: pull the logic that
// decides what the UI *does* out of the component that renders it, so it can be
// asserted directly instead of through a DOM.
//
// Nothing here renders. Everything here is either pure or takes its side
// effects as injected callbacks.

import { ZeroAddress } from "ethers";
import { ADDRESSES, computeDropCommit, contracts, parse, randomSalt } from "./chain";
import { newOrderWallet } from "./wallets";
import { fundBurner, forwarderAvailable } from "./relay";
import { approveToken, gaslessCreateOrderERC20, stablecoinBalance } from "./token";
import { OrderThread } from "./channel";
import { distanceMeters, type MicroDeg } from "./geo";

// ── shared row shapes (mirrors what App builds from the chain) ───────────────

export interface OrderRow {
  id: bigint;
  customer: string;
  venueId: bigint;
  status: number;
  driver: string;
  orderValue: bigint;
  tip: bigint;
  fare: bigint;
  maxFare: bigint;
  dropCommit: string;
  createdAt: bigint;
  pickupWindowSecs: bigint;
  pickupDeadline: bigint;
  deliveryDeadline: bigint;
  token: string;
}

export interface VenueRow {
  id: bigint;
  operator: string;
  signer: string;
  payout: string;
  lat: number;
  lon: number;
  active: boolean;
  pickups: number;
  metadataURI: string;
}

export const STATUS = ["—", "Open", "Assigned", "PickedUp", "Delivered", "Cancelled", "Disputed", "Resolved"];
export const badgeClass = (s: number) => STATUS[s]?.toLowerCase() ?? "";

/// Lifecycle end-states — never re-read once cached.
export const TERMINAL_STATUS = new Set([4, 5, 7]); // Delivered, Cancelled, Resolved

// ── deadline hygiene ────────────────────────────────────────────────────────

export type Expiry = { late: boolean; label: string } | null;

/// Whether an order is past the point anyone should still be acting on it.
///
/// Open orders carry no on-chain deadline — one is only set at assignment — so
/// an unbid open order older than its own pickup window is treated as stale:
/// had it been taken at creation it would already be overdue, so nobody is
/// coming. Assigned and picked-up orders have real deadlines to compare.
export function orderExpiry(o: OrderRow, nowSec: number): Expiry {
  if (o.status === 1) {
    const staleAt = Number(o.createdAt + o.pickupWindowSecs);
    return nowSec > staleAt ? { late: true, label: "stale" } : null;
  }
  if (o.status === 2) {
    return nowSec > Number(o.pickupDeadline) ? { late: true, label: "pickup overdue" } : null;
  }
  if (o.status === 3) {
    return nowSec > Number(o.deliveryDeadline) ? { late: true, label: "delivery overdue" } : null;
  }
  return null;
}

/// Coarsest useful countdown. Seconds are dropped past an hour because a
/// ticking second on a two-hour deadline is noise.
export function fmtLeft(sec: number): string {
  if (sec <= 0) return "now";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ── the driver board ────────────────────────────────────────────────────────

export interface TaggedOrder {
  o: OrderRow;
  /// Metres from the driver to the venue's PUBLIC pin, or null with no fix.
  dist: number | null;
}

export interface DriverBoard {
  /// Orders this driver is already carrying.
  jobs: OrderRow[];
  /// Open orders worth bidding on, nearest first.
  shown: TaggedOrder[];
  /// Open orders hidden by the radius filter.
  hidden: number;
  /// Open orders dropped as abandoned.
  staleCount: number;
  /// Live open-order count per venue, for the map pins.
  openByVenue: Map<string, number>;
}

/// What a driver is shown, and why.
///
/// Three decisions live here and each one fails silently if it is wrong: a
/// driver who sees no jobs assumes the market is empty, a driver shown stale
/// orders chases pickups nobody is waiting for, and a distance sort that is
/// backwards buries the closest work.
export function driverBoard(
  orders: OrderRow[],
  venues: VenueRow[],
  opts: { me: string | null; myLoc: MicroDeg | null; radiusKm: number; nowSec: number }
): DriverBoard {
  const { me, myLoc, radiusKm, nowSec } = opts;
  const mine = me?.toLowerCase() ?? null;

  const jobs = orders.filter(
    (o) => !!mine && o.driver.toLowerCase() === mine && (o.status === 2 || o.status === 3 || o.status === 6)
  );

  const venueOf = (o: OrderRow) => venues.find((v) => v.id === o.venueId);
  const openLive = orders.filter((o) => o.status === 1 && !orderExpiry(o, nowSec));
  const staleCount = orders.filter((o) => o.status === 1).length - openLive.length;

  const openTagged: TaggedOrder[] = openLive.map((o) => {
    const v = venueOf(o);
    return { o, dist: myLoc && v ? distanceMeters(myLoc, { lat: v.lat, lon: v.lon }) : null };
  });

  // Without a fix, or with the radius off, nothing is hidden — a driver who has
  // not granted location must still see the whole board rather than an empty one.
  const filtering = !!myLoc && radiusKm > 0;
  const shown = (filtering ? openTagged.filter((x) => x.dist != null && x.dist <= radiusKm * 1000) : openTagged)
    // Untagged orders sort last rather than first: an unknown distance is not a
    // near one.
    .slice()
    .sort((a, b) => (a.dist ?? Infinity) - (b.dist ?? Infinity));

  const openByVenue = new Map<string, number>();
  for (const o of openLive) openByVenue.set(String(o.venueId), (openByVenue.get(String(o.venueId)) ?? 0) + 1);

  return { jobs, shown, hidden: openTagged.length - shown.length, staleCount, openByVenue };
}

// ── drop secrets and receipts ───────────────────────────────────────────────

/// The drop coordinates never leave the device; they are keyed by the
/// commitment so the dropoff proof can find them again.
export const dropStoreKey = (commit: string) => `fare.drop.${commit.toLowerCase()}`;

/// B7 — cart line items are off-chain for privacy, so a receipt is stashed
/// locally at checkout keyed by the order's dropCommit.
export const receiptKey = (commit: string) => `fare.receipt.${commit.toLowerCase()}`;

export interface ReceiptData {
  venueId: string;
  venueName: string;
  items: { name: string; price: string; qty: number }[];
  orderValue: string; // PAS decimal
  tip: string;
  maxFare: string;
  placedAt?: number;
  rateUsd?: number; // PAS/USD captured at checkout — locks the receipt's fiat value (C2)
}

export function loadReceipt(commit: string): ReceiptData | null {
  try {
    const r = localStorage.getItem(receiptKey(commit));
    return r ? (JSON.parse(r) as ReceiptData) : null;
  } catch {
    return null;
  }
}

export interface DropSecret { lat: number; lon: number; salt: string }

export function loadDropSecret(commit: string): DropSecret | null {
  try {
    const r = localStorage.getItem(dropStoreKey(commit));
    return r ? (JSON.parse(r) as DropSecret) : null;
  } catch {
    return null;
  }
}

// ── placing an order ────────────────────────────────────────────────────────

export interface PlaceOrderOpts {
  venueId: bigint;
  orderValueWei: bigint;
  tipWei: bigint;
  maxFareWei: bigint;
  lat: number;
  lon: number;
  receipt: ReceiptData;
  token?: string; // undefined / address(0) = native PAS; else stablecoin escrow (C3)
  act: (label: string, fn: () => Promise<any>) => Promise<any>;
  say: (m: string, err?: boolean) => void;
}

/// Shared order placement: a fresh per-order wallet, funded through the
/// shielded pool, escrowing the order. Used by both first-time checkout and
/// reorder.
///
/// The two writes before `act` are deliberately first. If the transaction
/// fails, a stored secret for an order that never existed is harmless; losing
/// the secret for an order that DID would make the drop unprovable and the
/// escrow unrecoverable.
export async function placeOrder(opts: PlaceOrderOpts) {
  const { venueId, orderValueWei, tipWei, maxFareWei, lat, lon, receipt, token, act, say } = opts;
  const salt = randomSalt();
  const commit = computeDropCommit(lat, lon, salt);
  localStorage.setItem(dropStoreKey(commit), JSON.stringify({ lat, lon, salt }));
  localStorage.setItem(receiptKey(commit), JSON.stringify({ ...receipt, placedAt: Date.now() }));
  const escrow = orderValueWei + tipWei;
  const isToken = !!token && token !== ZeroAddress;

  return act("Create order", async () => {
    const w = newOrderWallet();
    // Announce the order wallet's public key on the order thread as soon as the
    // order exists: sealed bids are sealed TO the customer, and a driver has no
    // other way to obtain the key of a wallet that has never spoken (phase 4).
    const announce = (orderId: bigint) =>
      new OrderThread(orderId, w.privateKey, w.address, ZeroAddress).open().catch(() => {});

    // KS-ONLY funding: the burner is funded solely through the Kusama Shield
    // pool, so no non-shielded on-chain edge re-links it to the customer.
    // `fundBurner` throws if shielded funding is not configured — there is no
    // faucet fallback.
    say("Funding the private wallet through the shielded pool…");
    if (isToken) {
      // Token order: the burner needs a little gas; the escrow value is the
      // stablecoin. That stablecoin is REAL Asset Hub USDC, which has no mint —
      // the burner used to self-mint MockUSDC here, which is why the demo always
      // worked and why the amounts meant nothing. It must now already hold the
      // escrow, so this fails closed rather than inventing money.
      await fundBurner(w.address, parse("0.5"));
      const held = await stablecoinBalance(w.address);
      if (held < escrow) {
        throw new Error(
          `the private wallet holds ${held} of the ${escrow} needed. Real USDC cannot be minted — ` +
          `fund this wallet (mainnet: the shielded-funding path) before placing a token order.`
        );
      }
      if (forwarderAvailable()) {
        try {
          // Option C: permit + forwarded creation, relay pays the gas.
          return await gaslessCreateOrderERC20(contracts(w).orders, token!, {
            venueId, dropCommit: commit, orderValue: orderValueWei, tip: tipWei, maxFare: maxFareWei,
          });
        } catch {
          // The real USDC precompile is a bare IERC20 with NO permit(), so the
          // permit signature cannot be produced. Fall through to approve+direct.
        }
      }
      // No forwarder, or no permit on this token → the burner pays its own gas.
      await approveToken(w, token!, ADDRESSES.orders, escrow);
      return contracts(w).orders.createOrderERC20(token!, venueId, commit, orderValueWei, tipWei, maxFareWei, 0, 0);
    }

    await fundBurner(w.address, escrow + parse("0.2"));
    const tx = await contracts(w).orders.createOrder(
      venueId, commit, orderValueWei, tipWei, maxFareWei, 0, 0, { value: escrow }
    );
    const rec = await tx.wait();
    const created = rec?.logs
      ?.map((l: any) => { try { return contracts(w).orders.interface.parseLog(l); } catch { return null; } })
      ?.find((e: any) => e?.name === "OrderCreated");
    if (created) await announce(created.args.orderId);
    return tx;
  });
}

// ── which orders each role fetches ──────────────────────────────────────────
//
// Extracted from App's refresh callback, where it sat inside a `useCallback`
// closure and could not be reached. It decides what the whole app is even aware
// of, and every branch of it fails by showing too little — an empty screen that
// looks exactly like an empty market.
//
// Chain access is INJECTED rather than imported, so this can be driven without
// a node. The lazy `discoverOrders` matters and is part of the contract: the
// driver's region path must not pull the full `OrderCreated` stream, which is
// the whole point of the phase-2 server-side region query.

export type Role = "customer" | "driver" | "venue";

export interface DiscoveredOrder { id: bigint; venueId: bigint; customer: string; block: number }
export interface Assignment { id: bigint; driver: string }

export interface DiscoveryDeps {
  discoverOrders: (from: number, to: number) => Promise<DiscoveredOrder[]>;
  discoverAssignments: (from: number, to: number) => Promise<Assignment[]>;
  orderIdsInRegions: (regions: string[], from: number, to: number) => Promise<bigint[]>;
  regionsCovering: (center: MicroDeg, radiusKm: number) => string[];
  /// The local per-order wallet registry — a customer's orders span many
  /// addresses, not one.
  myOrderWallets: () => Set<string>;
  /// Fallback for a node with no `eth_getLogs`.
  nextOrderId: () => Promise<bigint>;
}

export interface DiscoveryOpts {
  role: Role;
  me: string | null;
  myLoc: MicroDeg | null;
  radiusKm: number;
  venues: VenueRow[];
  from: number;
  to: number;
}

/// The order ids this role needs, as decimal strings.
export async function discoverRelevantOrders(
  deps: DiscoveryDeps,
  opts: DiscoveryOpts
): Promise<Set<string>> {
  const { role, myLoc, radiusKm, venues, from, to } = opts;
  const me = opts.me?.toLowerCase() ?? null;

  const relevant = new Set<string>();
  const add = (ids: bigint[]) => ids.forEach((id) => relevant.add(String(id)));

  const myVenueIds = new Set(
    venues
      .filter((v) => me && (v.operator.toLowerCase() === me || v.signer.toLowerCase() === me))
      .map((v) => String(v.id))
  );
  const venueById = new Map(venues.map((v) => [String(v.id), v]));
  const inRegion = (venueId: bigint) => {
    if (!myLoc || radiusKm === 0) return true;
    const v = venueById.get(String(venueId));
    return !!v && distanceMeters(myLoc, { lat: v.lat, lon: v.lon }) <= radiusKm * 1000;
  };

  // Fetched at most once, and only if a branch actually needs it.
  let created: DiscoveredOrder[] | null = null;
  const getCreated = async () => (created ??= await deps.discoverOrders(from, to));

  try {
    if (role === "customer") {
      const mine = deps.myOrderWallets();
      add((await getCreated()).filter((d) => mine.has(d.customer.toLowerCase())).map((d) => d.id));
    } else if (role === "venue" && me) {
      add((await getCreated()).filter((d) => myVenueIds.has(String(d.venueId))).map((d) => d.id));
    } else if (role === "driver") {
      if (myLoc && radiusKm > 0) {
        // Phase 2: region is the LEADING indexed topic, so this filters
        // server-side. A pre-OrderRegion node throws, and then the full stream
        // plus a client-side filter is the only way to get the same answer.
        try {
          add(await deps.orderIdsInRegions(deps.regionsCovering(myLoc, radiusKm), from, to));
        } catch {
          add((await getCreated()).filter((d) => inRegion(d.venueId)).map((d) => d.id));
        }
      } else {
        add((await getCreated()).map((d) => d.id)); // everywhere
      }
      if (me) {
        // Own jobs, ALWAYS and regardless of radius — otherwise a driver's
        // active delivery disappears from their screen the moment they walk
        // out of the radius they set.
        const assigns = await deps.discoverAssignments(from, to);
        add(assigns.filter((a) => a.driver.toLowerCase() === me).map((a) => a.id));
      }
    }
    // Account-scoped roles with no session have nothing to show.
  } catch {
    // A node without eth_getLogs: enumerate everything and let the views filter
    // locally. Slow and correct beats fast and blank.
    const next = await deps.nextOrderId();
    for (let i = 1n; i < next; i++) relevant.add(String(i));
  }

  return relevant;
}
