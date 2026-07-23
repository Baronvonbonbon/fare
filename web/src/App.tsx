import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ADDRESSES,
  RPC_URL,
  Session,
  SignerMode,
  connect,
  contracts,
  computeDropCommit,
  currentBlock,
  ratingsEnabled,
  decodePayload,
  discoverAssignments,
  discoverOrders,
  orderIdsInRegions,
  regionsCovering,
  DRIP_MIN,
  encodePayload,
  fmt,
  nativeBalance,
  parse,
  NodeMode,
  embeddedAvailable,
  getNodeMode,
  getNodeUrl,
  initNode,
  nodeLabel,
  pingNode,
  randomSalt,
  setNode,
  short,
  signLocation,
  signDriverCommit,
  syncAddressesFromRouter,
  waitForFunding,
} from "./chain";
import {
  newOrderWallet,
  orderWalletAddresses,
  contractsForOrder,
  walletFor,
  sweepToMain,
} from "./wallets";
import { isAddress, ZeroAddress } from "ethers";
import { OrderThread, type ChatMsg, type LocUpdate } from "./channel";
import { newPhotoKey, sealPhoto, openPhoto } from "./photo";
import { notify, notifyPermission, enableNotifications, type NotifyPermission } from "./notify";
import { pushConfigured, pushSubscribed, subscribePush, syncWatched } from "./push";
import { compressImage, storeSealed, fetchSealed, photoObjectUrl } from "./photoflow";
import {
  Menu, MenuItem, Cart, fetchMenu, cartTotal, cartCount,
  emptyMenu, newItemId, publishMenu, hasMenuURI,
} from "./menu";
import { proveProximity, positionCommit } from "./zk";
import { sponsorGas, relaySettle, relayForward, relayWithdraw, ensureGas } from "./relay";
import { usePasUsd, cachedRate, fiatOf, pasToUsd, formatUsd } from "./pricing";
import {
  tokenOrdersEnabled, stablecoinAsset, assetOf, fmtAsset, parseAsset,
  mintStablecoin, approveToken, stablecoinBalance,
} from "./token";
import { MicroDeg, distanceMeters, fmtCoord, fmtDist, getPosition, snapToGrid } from "./geo";
import { QRScan, QRShow } from "./qr";
import { VenuePin, TrackMap } from "./map";
import { AreaMap, PinMap } from "./tilemap";

// ---- shared types ----

interface OrderRow {
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
  token: string; // escrow asset — address(0) native PAS, else the stablecoin (C3)
  bidders: { addr: string; amount: bigint; delivered: number; failed: number; ratingX100: number; ratingN: number }[];
}

interface VenueRow {
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

const STATUS = ["—", "Open", "Assigned", "PickedUp", "Delivered", "Cancelled", "Disputed", "Resolved"];
const badgeClass = (s: number) => STATUS[s]?.toLowerCase() ?? "";

// ---- deadline hygiene ----
// Open orders have no on-chain deadline until assigned, so we treat an unbid
// open order older than its own pickup window as stale (had it been taken at
// creation it would already be past pickup — nobody is coming). Assigned /
// picked-up orders have real on-chain deadlines.
type Expiry = { late: boolean; label: string } | null;
function orderExpiry(o: OrderRow, nowSec: number): Expiry {
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
function ExpiryBadge({ o }: { o: OrderRow }) {
  const e = orderExpiry(o, Math.floor(Date.now() / 1000));
  return e ? <span className="badge expired">{e.label}</span> : null;
}

type Role = "customer" | "driver" | "venue";

// Order lifecycle end-states — never re-read once cached.
const TERMINAL_STATUS = new Set([4, 5, 7]); // Delivered, Cancelled, Resolved
// First-load log backfill window (~46 days at 2s blocks) — well past our
// deploy, and within Paseo's getLogs range. Incremental after that.
const INITIAL_LOOKBACK = 2_000_000;

// Drop-location secrets the customer holds until dropoff.
const dropStoreKey = (commit: string) => `fare.drop.${commit.toLowerCase()}`;

// B7 — order receipts. Cart line items are off-chain (privacy), so we stash a
// receipt locally at checkout keyed by the order's dropCommit; the receipt view
// and reorder read it back. Falls back to on-chain amounts when absent (legacy).
const receiptKey = (commit: string) => `fare.receipt.${commit.toLowerCase()}`;
interface ReceiptData {
  venueId: string;
  venueName: string;
  items: { name: string; price: string; qty: number }[];
  orderValue: string; // PAS decimal
  tip: string;
  maxFare: string;
  placedAt?: number;
  rateUsd?: number; // PAS/USD captured at checkout — locks the receipt's fiat value (C2)
}
function loadReceipt(commit: string): ReceiptData | null {
  try {
    const r = localStorage.getItem(receiptKey(commit));
    return r ? (JSON.parse(r) as ReceiptData) : null;
  } catch {
    return null;
  }
}

/// Shared order-placement: fresh per-order wallet, faucet-funded, escrows the
/// order. Used by both first-time checkout and reorder. Persists the drop secret
/// + the receipt keyed by the (fresh) commit.
async function placeOrder(opts: {
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
}) {
  const { venueId, orderValueWei, tipWei, maxFareWei, lat, lon, receipt, token, act, say } = opts;
  const salt = randomSalt();
  const commit = computeDropCommit(lat, lon, salt);
  localStorage.setItem(dropStoreKey(commit), JSON.stringify({ lat, lon, salt }));
  localStorage.setItem(receiptKey(commit), JSON.stringify({ ...receipt, placedAt: Date.now() }));
  const escrow = orderValueWei + tipWei;
  const isToken = !!token && token !== ZeroAddress;
  return act("Create order", async () => {
    const w = newOrderWallet();
    say("New private wallet — funding from faucet…");
    await sponsorGas(w.address);
    if (isToken) {
      // Token order: the burner only needs gas from the faucet; it self-mints
      // its stablecoin escrow (testnet MockUSDC), then approves + creates. No
      // link to the customer's main wallet (mainnet: shielded funding, C4).
      await waitForFunding(w.address, parse("0.3"));
      say("Minting stablecoin escrow to the private wallet…");
      await mintStablecoin(w, w.address, escrow);
      await approveToken(w, token!, ADDRESSES.orders, escrow);
      return contracts(w).orders.createOrderERC20(
        token!, venueId, commit, orderValueWei, tipWei, maxFareWei, 0, 0
      );
    }
    await waitForFunding(w.address, escrow + parse("0.2"));
    return contracts(w).orders.createOrder(
      venueId, commit, orderValueWei, tipWei, maxFareWei, 0, 0, { value: escrow }
    );
  });
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [role, setRole] = useState<Role>(() => (localStorage.getItem("fare.role") as Role) || "customer");
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null);
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [venues, setVenues] = useState<VenueRow[]>([]);
  const [vaultBal, setVaultBal] = useState<bigint>(0n);
  const [vaultTokenBal, setVaultTokenBal] = useState<bigint>(0n); // stablecoin earnings (C3)
  const [pendingDust, setPendingDust] = useState<bigint>(0n);
  const [nativeBal, setNativeBal] = useState<bigint>(0n);
  const [busy, setBusy] = useState(false);
  const [nodeSync, setNodeSync] = useState<string | null>(
    getNodeMode() === "pine-embedded" ? "connecting…" : null
  );
  const [nodeErr, setNodeErr] = useState<string | null>(null);

  // Shared "my area": the device's location + a radius, used to filter/sort by
  // proximity to the public pickup (venue) pin. Persisted so it survives a
  // reload. Drop locations are hidden commitments and are never filtered on.
  const [myLoc, setMyLoc] = useState<MicroDeg | null>(() => {
    try {
      const s = localStorage.getItem("fare.myloc");
      return s ? (JSON.parse(s) as MicroDeg) : null;
    } catch {
      return null;
    }
  });
  const [radiusKm, setRadiusKm] = useState<number>(() => Number(localStorage.getItem("fare.radiuskm")) || 15);
  useEffect(() => localStorage.setItem("fare.radiuskm", String(radiusKm)), [radiusKm]);

  // Struct cache shared across refreshes: terminal orders are never re-read.
  const orderCache = useRef<Map<string, OrderRow>>(new Map());

  // Boot the selected node (no-op for hosted/daemon; starts the in-tab
  // smoldot light client for pine-embedded and reports sync progress).
  useEffect(() => {
    initNode((step) => setNodeSync(step))
      .then(() => setNodeSync(null))
      .catch((e) => setNodeSync(`light client failed: ${e.message}`));
  }, []);

  // A "pine daemon" node with no daemon running (e.g. on a phone) fails every
  // read silently — the app just shows zeros. Probe it and surface a fix.
  useEffect(() => {
    if (getNodeMode() !== "pine-daemon") return;
    let cancelled = false;
    pingNode().then(
      () => !cancelled && setNodeErr(null),
      () => !cancelled &&
        setNodeErr(`Can't reach the pine daemon at ${getNodeUrl()} — open the node menu and switch to Hosted RPC.`)
    );
    return () => { cancelled = true; };
  }, []);

  const say = useCallback((msg: string, err = false) => {
    setToast({ msg, err });
    window.setTimeout(() => setToast(null), err ? 8000 : 4500);
  }, []);

  /// Capture the device's GPS once as the shared "my area" anchor for
  /// proximity filtering/sorting (persisted).
  const locateMe = useCallback(async () => {
    try {
      const p = await getPosition();
      setMyLoc(p);
      localStorage.setItem("fare.myloc", JSON.stringify(p));
      say("Location set — showing what's near you");
    } catch (e: any) {
      say(e.message, true);
    }
  }, [say]);

  const refresh = useCallback(async () => {
    try {
      await syncAddressesFromRouter(); // follow router-driven upgrades
      const c = contracts();

      // ── 1. Venues first — few, read directly, and needed to scope orders
      //       by venue / region below.
      const nextVenue: bigint = await c.venues.nextVenueId();
      const venueIds = Array.from({ length: Number(nextVenue - 1n) }, (_, i) => BigInt(i + 1));
      const rawVenues = await Promise.all(venueIds.map((id) => c.venues.venues(id)));
      const venueRows: VenueRow[] = rawVenues.map((v, i) => ({
        id: venueIds[i],
        operator: v.operator,
        signer: v.signer,
        payout: v.payout,
        lat: Number(v.lat),
        lon: Number(v.lon),
        active: v.active,
        pickups: Number(v.pickups),
        metadataURI: v.metadataURI,
      }));
      setVenues(venueRows);

      // ── 2. Role-aware scoping. We fetch the OrderCreated stream once (topic0)
      //       and filter the decoded args client-side (Paseo can't server-side
      //       filter non-leading topics). Each role keeps only the orders it
      //       needs, so the struct reads below stay scoped. The driver also
      //       pulls their own assigned jobs, so a job never vanishes when it
      //       drifts out of radius.
      const latest = await currentBlock();
      const from = Math.max(0, latest - INITIAL_LOOKBACK);
      const me = session?.address?.toLowerCase();
      const relevant = new Set<string>();
      const add = (ids: bigint[]) => ids.forEach((id) => relevant.add(String(id)));
      const myVenueIds = new Set(
        venueRows
          .filter((v) => me && (v.operator.toLowerCase() === me || v.signer.toLowerCase() === me))
          .map((v) => String(v.id))
      );
      const venueById = new Map(venueRows.map((v) => [String(v.id), v]));
      const inRegion = (venueId: bigint) => {
        if (!myLoc || radiusKm === 0) return true;
        const v = venueById.get(String(venueId));
        return !!v && distanceMeters(myLoc, { lat: v.lat, lon: v.lon }) <= radiusKm * 1000;
      };

      // Fetch the full OrderCreated stream lazily — the driver's region path
      // avoids it entirely (server-side region query instead).
      let created: Awaited<ReturnType<typeof discoverOrders>> | null = null;
      const getCreated = async () => (created ??= await discoverOrders(from, latest));

      try {
        if (role === "customer") {
          // A customer's orders now span many per-order wallets, not one
          // address — match against the local wallet registry.
          const mineAddrs = orderWalletAddresses();
          add((await getCreated()).filter((d) => mineAddrs.has(d.customer.toLowerCase())).map((d) => d.id));
        } else if (role === "venue" && me) {
          add((await getCreated()).filter((d) => myVenueIds.has(String(d.venueId))).map((d) => d.id));
        } else if (role === "driver") {
          if (myLoc && radiusKm > 0) {
            // Phase 2: fetch only orders whose pickup region covers the radius,
            // server-side (region is the leading indexed topic). Fall back to
            // the full stream + client-side filter on a pre-OrderRegion node.
            try {
              add(await orderIdsInRegions(regionsCovering(myLoc, radiusKm), from, latest));
            } catch {
              add((await getCreated()).filter((d) => inRegion(d.venueId)).map((d) => d.id));
            }
          } else {
            add((await getCreated()).map((d) => d.id)); // everywhere
          }
          if (me) {
            const assigns = await discoverAssignments(from, latest);
            add(assigns.filter((a) => a.driver.toLowerCase() === me).map((a) => a.id)); // my jobs, anywhere
          }
        }
        // account-scoped roles with no session → nothing to show
      } catch {
        // node without eth_getLogs — enumerate all; views filter locally
        const nextOrder: bigint = await c.orders.nextOrderId();
        for (let i = 1n; i < nextOrder; i++) relevant.add(String(i));
      }

      // ── 3. Read structs only for newly-seen or still-active relevant orders;
      //       terminal orders (Delivered/Cancelled/Resolved) stay cached.
      const cache = orderCache.current;
      const toRead = [...relevant].filter((id) => {
        const row = cache.get(id);
        return !row || !TERMINAL_STATUS.has(row.status);
      });
      const readRows = await Promise.all(
        toRead.map(async (idStr) => {
          const id = BigInt(idStr);
          const o = await c.orders.orders(id);
          let bidders: OrderRow["bidders"] = [];
          if (Number(o.status) === 1) {
            const addrs: string[] = await c.orders.biddersOf(id);
            // Enrich each bid with the driver's on-chain reputation so the
            // customer can weigh trust against price (A6).
            const rows = await Promise.all(
              addrs.map(async (addr) => {
                const amount: bigint = await c.orders.bidOf(id, addr);
                let delivered = 0, failed = 0, ratingX100 = 0, ratingN = 0;
                try {
                  const d = await c.drivers.drivers(addr);
                  delivered = Number(d.delivered);
                  failed = Number(d.failed);
                } catch {}
                if (c.ratings) {
                  try {
                    const [avg, n] = await c.ratings.driverRating(addr);
                    ratingX100 = Number(avg);
                    ratingN = Number(n);
                  } catch {}
                }
                return { addr, amount, delivered, failed, ratingX100, ratingN };
              })
            );
            bidders = rows.filter((b) => b.amount > 0n).sort((a, b) => (a.amount < b.amount ? -1 : 1));
          }
          return {
            id,
            customer: o.customer,
            venueId: o.venueId,
            status: Number(o.status),
            driver: o.driver,
            orderValue: o.orderValue,
            tip: o.tip,
            fare: o.fare,
            maxFare: o.maxFare,
            dropCommit: o.dropCommit,
            createdAt: o.createdAt,
            pickupWindowSecs: o.pickupWindowSecs,
            pickupDeadline: o.pickupDeadline,
            deliveryDeadline: o.deliveryDeadline,
            token: o.token,
            bidders,
          } as OrderRow;
        })
      );
      for (const row of readRows) cache.set(String(row.id), row);

      // Publish only the current role's relevant orders, newest first.
      setOrders(
        ([...relevant].map((id) => cache.get(id)).filter(Boolean) as OrderRow[]).sort((a, b) =>
          a.id < b.id ? 1 : -1
        )
      );

      if (me) {
        setVaultBal(await c.vault.balanceOf(me));
        setPendingDust(await c.vault.pendingPaseoDust(me));
        setNativeBal(await nativeBalance(me));
        if (ADDRESSES.stablecoin) {
          try { setVaultTokenBal(await c.vault.tokenBalanceOf(ADDRESSES.stablecoin, me)); } catch {}
        }
      }
    } catch (e: any) {
      console.error(e);
    }
  }, [session, role, myLoc, radiusKm]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 8000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => localStorage.setItem("fare.role", role), [role]);

  // B4 (P1): local notifications on relevant order transitions. `orders` is
  // already role-scoped, so a change there is something this user cares about.
  // First run just seeds the baseline (no notify on load); no persistent identity
  // is registered anywhere — foreground-only, purely local.
  const prevOrders = useRef<Map<string, { status: number; driver: string }> | null>(null);
  useEffect(() => {
    const prev = prevOrders.current;
    const next = new Map(orders.map((o) => [String(o.id), { status: o.status, driver: o.driver }]));
    if (prev && notifyPermission() === "granted") {
      const me = session?.address?.toLowerCase();
      for (const [id, cur] of next) {
        const was = prev.get(id);
        if (!was) {
          if (cur.status === 1 && role === "driver") notify("New order nearby", `Order #${id} is open for bids`, `new-${id}`);
          else if (cur.status === 1 && role === "venue") notify("New order", `Order #${id} came in for your venue`, `new-${id}`);
          continue;
        }
        if (cur.status === was.status) continue;
        if (cur.status === 2) {
          if (role === "driver" && me && cur.driver.toLowerCase() === me) notify("Bid accepted 🎉", `You got order #${id}`, `st-${id}`);
          else if (role === "customer") notify("Driver assigned", `A driver accepted order #${id}`, `st-${id}`);
        } else if (cur.status === 3 && role === "customer") {
          notify("Picked up 🛵", `Order #${id} is on the way`, `st-${id}`);
        } else if (cur.status === 4 && role === "customer") {
          notify("Delivered ✅", `Order #${id} was delivered`, `st-${id}`);
        }
      }
    }
    prevOrders.current = next;
  }, [orders, role, session]);

  // B4 (P2): the coarse region(s) we ask the push service to notify us about —
  // our search area + our orders' venue cells. The service pushes by region only;
  // it never learns which order is ours.
  const subscribeRegions = useCallback((): string[] => {
    const set = new Set<string>();
    if (myLoc) for (const r of regionsCovering(myLoc, Math.max(radiusKm, 5))) set.add(r);
    for (const o of orders) {
      const v = venues.find((x: VenueRow) => String(x.id) === String(o.venueId));
      if (v) for (const r of regionsCovering({ lat: v.lat, lon: v.lon }, 1)) set.add(r);
    }
    return [...set];
  }, [myLoc, radiusKm, orders, venues]);

  // Keep the SW's watched-order set (local filter) + push regions fresh.
  useEffect(() => {
    if (notifyPermission() !== "granted") return;
    syncWatched(orders.map((o) => String(o.id)));
    if (pushConfigured() && pushSubscribed()) subscribePush(subscribeRegions());
  }, [orders, subscribeRegions]);

  /// Wrap a tx-sending action with busy state + toast + refresh.
  const act = useCallback(
    async (label: string, fn: () => Promise<any>) => {
      if (!session) return say("Connect a wallet first", true);
      setBusy(true);
      try {
        const tx = await fn();
        if (tx?.wait) await tx.wait();
        say(`${label} ✓`);
        await refresh();
      } catch (e: any) {
        const m = e?.reason ?? e?.shortMessage ?? e?.message ?? String(e);
        say(`${label} failed: ${m}`, true);
      } finally {
        setBusy(false);
      }
    },
    [session, say, refresh]
  );

  /// Top up a burner's gas from the serverless faucet if it's low. Auto-runs
  /// on burner connect; also the manual "Top up gas" button. Silent on a
  /// missing endpoint (local/unconfigured) — the manual button stays available.
  const maybeDrip = useCallback(
    async (address: string, manual = false) => {
      try {
        const before = await nativeBalance(address);
        if (!manual && before >= DRIP_MIN) return;
        say("Funding demo wallet…");
        const r = await sponsorGas(address);
        if (r.funded) {
          // The faucet returns as soon as the tx is submitted; the chain needs
          // a few seconds to include it. Poll until the balance actually rises
          // (or time out) so the display updates instead of looking stuck.
          let landed = false;
          for (let i = 0; i < 12 && !landed; i++) {
            await new Promise((res) => setTimeout(res, 1500));
            landed = (await nativeBalance(address).catch(() => before)) > before;
          }
          await refresh();
          say(landed ? "Gas added ✓" : "Gas sent — balance will update shortly");
        } else if (r.configured === false) {
          say("Faucet not configured — fund at faucet.polkadot.io", true);
        } else if (r.reason === "sufficient") {
          if (manual) say("Wallet already has gas");
        } else if (r.error) {
          say(`Faucet: ${r.error}`, true);
        }
      } catch {
        if (manual) say("Faucet unreachable — try faucet.polkadot.io", true);
      }
    },
    [say, refresh]
  );

  const signed = session ? contracts(session.signer) : null;

  return (
    <>
      <header className="masthead">
        <div className="logo">
          FARE<span className="dot" aria-hidden="true">.</span>
          <small>p2p delivery · polkadot hub</small>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <NotifyBell say={say} onEnabled={async () => {
            await syncWatched(orders.map((o) => String(o.id)));
            if (pushConfigured()) await subscribePush(subscribeRegions());
          }} />
          <NodeChip />
          <WalletChip session={session} balance={nativeBal} onConnect={async (mode, key) => {
            try {
              const s = await connect(mode, key);
              setSession(s);
              say(`Connected ${short(s.address)}`);
              // No auto-drip: gas is topped up on demand (the "Top up gas"
              // button) or avoided entirely via gasless meta-txs (F8).
            } catch (e: any) {
              say(e.message, true);
            }
          }} />
        </div>
      </header>

      {nodeSync && (
        <div className="vault-strip" style={{ borderColor: "rgba(7,255,255,0.3)", background: "rgba(7,255,255,0.05)" }}>
          <div>
            <div className="lbl">in-browser light client</div>
            <div className="mono" style={{ color: "var(--cyan)" }}>{nodeSync}</div>
          </div>
        </div>
      )}

      {nodeErr && (
        <div className="vault-strip" style={{ borderColor: "rgba(255,38,112,0.4)", background: "rgba(255,38,112,0.06)" }}>
          <div>
            <div className="lbl">node unreachable</div>
            <div className="mono" style={{ color: "var(--pink)" }}>{nodeErr}</div>
          </div>
        </div>
      )}

      <nav className="roles">
        {(["customer", "driver", "venue"] as Role[]).map((r) => (
          <button key={r} className={role === r ? "active" : ""} onClick={() => setRole(r)}>
            <span className="glyph">{r === "customer" ? "🛍" : r === "driver" ? "🛵" : "🏪"}</span>
            {r}
          </button>
        ))}
      </nav>

      {session?.mode === "burner" && nativeBal < DRIP_MIN && (
        <div className="vault-strip" style={{ borderColor: "rgba(7,255,255,0.3)", background: "rgba(7,255,255,0.05)" }}>
          <div>
            <div className="lbl">gas balance low — burner needs PAS to transact</div>
            <div className="amt" style={{ color: "var(--cyan)" }}>{fmt(nativeBal)} PAS</div>
          </div>
          <button className="btn small" disabled={busy} onClick={() => maybeDrip(session.address, true)}>
            Top up gas
          </button>
        </div>
      )}

      {session && (vaultBal > 0n || pendingDust > 0n) && (
        <VaultStrip {...{ vaultBal, vaultTokenBal, pendingDust, busy, act, signed, say }} />
      )}

      {role === "customer" && (
        <CustomerView {...{ session, orders, venues, act, busy, signed, say, myLoc, locateMe }} />
      )}
      {role === "driver" && (
        <DriverView {...{ session, orders, venues, act, busy, signed, say, myLoc, radiusKm, setRadiusKm, locateMe }} />
      )}
      {role === "venue" && (
        <VenueView {...{ session, orders, venues, act, busy, signed, say }} />
      )}

      <p className="hint mono" style={{ textAlign: "center", marginTop: 20 }}>
        node {nodeLabel()} · {RPC_URL} · orders {short(ADDRESSES.orders)} · settlement {short(ADDRESSES.settlement)}
      </p>

      {toast && <div className={`toast ${toast.err ? "err" : ""}`}>{toast.msg}</div>}
    </>
  );
}

// ---------- node selection ----------

/// Enable local order notifications (B4 P1). Tap to grant permission; foreground
/// only, no server/identity. Hidden where the Notification API is unavailable.
function NotifyBell({ say, onEnabled }: { say: (m: string, err?: boolean) => void; onEnabled: () => Promise<void> }) {
  const [perm, setPerm] = useState<NotifyPermission>(() => notifyPermission());
  if (perm === "unsupported") return null;
  const label = perm === "granted" ? "🔔" : "🔕";
  const bg = pushConfigured() ? " + background" : "";
  const title = perm === "granted" ? `Order notifications on${bg}` : perm === "denied" ? "Notifications blocked in browser settings" : `Enable order notifications${bg}`;
  return (
    <button className="btn ghost small" title={title} style={{ padding: "4px 8px" }}
      onClick={async () => {
        if (perm === "granted") { say("Notifications are on"); return; }
        const r = await enableNotifications();
        setPerm(r);
        if (r === "granted") {
          say(pushConfigured() ? "Notifications enabled ✓ (incl. background)" : "Notifications enabled ✓");
          onEnabled().catch(() => {});
        } else {
          say(r === "denied" ? "Notifications blocked — enable them in browser settings" : "Notifications not enabled", true);
        }
      }}>
      {label}
    </button>
  );
}

/// The trust gradient, user-selectable per device: hosted gateway → local
/// pine daemon (verifying light client behind localhost) → in-browser
/// smoldot light client. Switching persists and reloads the app.
function NodeChip() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<NodeMode>(getNodeMode());
  const [url, setUrl] = useState(getNodeUrl());
  const current = getNodeMode();

  const OPTIONS: { value: NodeMode; label: string; hint: string; disabled?: boolean }[] = [
    { value: "hosted", label: "Hosted RPC", hint: "eth-rpc gateway — convenient, trusted third party" },
    { value: "pine-daemon", label: "Pine daemon", hint: "local pine-rpc node — smoldot light client, verified reads" },
    {
      value: "pine-embedded",
      label: "In-browser light client",
      hint: embeddedAvailable()
        ? "smoldot runs in this tab (experimental, ~30s sync)"
        : "Paseo only — unavailable on a local dev chain",
      disabled: !embeddedAvailable(),
    },
  ];

  return (
    <div style={{ position: "relative" }}>
      <button className="wallet-chip" onClick={() => setOpen(!open)} title="Node / trust level">
        <span
          className="status-dot"
          style={current !== "hosted" ? { background: "var(--cyan)", boxShadow: "0 0 8px var(--cyan)" } : {}}
        />
        {nodeLabel()}
      </button>
      {open && (
        <div className="card" style={{ position: "absolute", right: 0, top: 42, width: 290, zIndex: 20 }}>
          {OPTIONS.map((o) => (
            <label key={o.value} style={{ display: "block", marginBottom: 10, opacity: o.disabled ? 0.45 : 1 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input
                  type="radio"
                  name="node"
                  style={{ width: "auto" }}
                  checked={mode === o.value}
                  disabled={o.disabled}
                  onChange={() => setMode(o.value)}
                />
                <strong style={{ fontSize: 13 }}>{o.label}</strong>
              </div>
              <div className="hint" style={{ marginTop: 2, marginLeft: 24 }}>{o.hint}</div>
            </label>
          ))}
          {mode === "pine-daemon" && (
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://127.0.0.1:8545" />
          )}
          <button
            className="btn small"
            style={{ width: "100%", marginTop: 10 }}
            disabled={mode === current && (mode !== "pine-daemon" || url === getNodeUrl())}
            onClick={() => setNode(mode, mode === "pine-daemon" ? url : undefined)}
          >
            Switch node (reloads)
          </button>
        </div>
      )}
    </div>
  );
}

// ---------- wallet ----------

function WalletChip({
  session,
  balance,
  onConnect,
}: {
  session: Session | null;
  balance: bigint;
  onConnect: (m: SignerMode, key?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (session) {
    return (
      <div className="wallet-chip" title={session.address}>
        <span className="status-dot" />
        {short(session.address)}
        <span className="wallet-bal">{fmt(balance)} PAS</span>
      </div>
    );
  }
  return (
    <div style={{ position: "relative" }}>
      <button className="wallet-chip disconnected" onClick={() => setOpen(!open)}>
        <span className="status-dot" /> connect
      </button>
      {open && (
        <div className="card" style={{ position: "absolute", right: 0, top: 42, width: 260, zIndex: 20 }}>
          <button className="btn ghost small" style={{ width: "100%", marginBottom: 8 }}
            onClick={() => { setOpen(false); onConnect("injected"); }}>
            Injected wallet
          </button>
          <button className="btn ghost small" style={{ width: "100%", marginBottom: 8 }}
            onClick={() => { setOpen(false); onConnect("burner"); }}>
            Burner key (this device)
          </button>
          <PasteKey onSubmit={(k) => { setOpen(false); onConnect("key", k); }} />
        </div>
      )}
    </div>
  );
}

function PasteKey({ onSubmit }: { onSubmit: (k: string) => void }) {
  const [k, setK] = useState("");
  return (
    <div>
      <input placeholder="0x… private key (dev only)" value={k} onChange={(e) => setK(e.target.value)} />
      <button className="btn small" style={{ width: "100%", marginTop: 8 }} disabled={!k} onClick={() => onSubmit(k)}>
        Use key
      </button>
    </div>
  );
}

// ---------- shared order pieces ----------

function Route({ status }: { status: number }) {
  // Open(1) → Assigned(2) → PickedUp(3) → Delivered(4)
  const step = status >= 4 ? 3 : status - 1;
  return (
    <>
      <div className="route">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} style={{ display: "contents" }}>
            {i > 0 && <span className={`leg ${step >= i ? "done" : ""}`} />}
            <span className={`stop ${step >= i ? "done" : ""}`} />
          </span>
        ))}
      </div>
      <div className="route-labels">
        <span>open</span>
        <span>assigned</span>
        <span>picked up</span>
        <span>delivered</span>
      </div>
    </>
  );
}

function OrderMeta({ o, venues }: { o: OrderRow; venues: VenueRow[] }) {
  const venue = venues.find((v) => v.id === o.venueId);
  return (
    <>
      {o.status >= 1 && o.status <= 4 && <Route status={o.status} />}
      <div className="kv"><span className="k">venue</span><span className="v">#{String(o.venueId)}{venue ? ` · ${venue.metadataURI.replace(/^\w+:\/\//, "")}` : ""}</span></div>
      {assetOf(o.token).isToken && (
        <div className="kv"><span className="k">paid in</span><span className="v">{assetOf(o.token).symbol} · stablecoin escrow</span></div>
      )}
      <div className="kv"><span className="k">order value</span><span className="v amount">{fmtAsset(o.orderValue, o.token)}</span></div>
      <div className="kv"><span className="k">tip</span><span className="v amount">{fmtAsset(o.tip, o.token)}</span></div>
      <div className="kv">
        <span className="k">{o.status >= 2 ? "fare" : "max fare"}</span>
        <span className="v amount">{fmtAsset(o.status >= 2 ? o.fare : o.maxFare, o.token)}</span>
      </div>
      {o.driver !== "0x0000000000000000000000000000000000000000" && (
        <div className="kv"><span className="k">driver</span><span className="v">{short(o.driver)}</span></div>
      )}
    </>
  );
}

function GeoPill({ pos }: { pos: MicroDeg | null }) {
  return pos ? <span className="geo-pill">◉ {fmtCoord(pos)}</span> : null;
}

// Shared dispute UI. Openable (evidence + bond) on Assigned/PickedUp; shows the
// dispute detail on a Disputed order. `handle` is the contracts object to sign
// the openDispute with (the order's per-order wallet for a customer; the session
// for a driver) — the contract requires msg.sender to be a party. (A7)
function DisputeControl({ o, handle, busy, act }: any) {
  const [evidence, setEvidence] = useState("");
  const [bond, setBond] = useState<bigint>(0n);
  const [detail, setDetail] = useState<any>(null);
  useEffect(() => {
    contracts().disputes.disputeBond().then(setBond).catch(() => {});
    if (o.status === 6) {
      contracts().disputes.disputeOfOrder(o.id).then(async (did: bigint) => {
        if (did > 0n) setDetail(await contracts().disputes.disputes(did));
      }).catch(() => {});
    }
  }, [o.status, String(o.id)]);

  if (o.status === 6) {
    const st = detail ? ["—", "open", "resolved"][Number(detail.status)] : "…";
    return (
      <div className="kv-block" style={{ marginTop: 8 }}>
        <div className="kv"><span className="k">dispute</span><span className="v">{st}</span></div>
        {detail && <div className="kv"><span className="k">opened by</span><span className="v mono">{short(detail.opener)}</span></div>}
        {detail?.evidenceURI && <div className="kv"><span className="k">evidence</span><span className="v">{detail.evidenceURI}</span></div>}
        <p className="hint">{Number(detail?.status) === 2 ? "Resolved by the arbiter." : "Frozen — awaiting arbiter ruling."}</p>
      </div>
    );
  }
  if (o.status !== 2 && o.status !== 3) return null;
  return (
    <div className="btn-row" style={{ flexWrap: "wrap", marginTop: 8 }}>
      <input style={{ flex: 1, minWidth: 120 }} placeholder="evidence URI / note (optional)"
        value={evidence} onChange={(e) => setEvidence(e.target.value)} />
      <button className="btn ghost small" disabled={busy || !handle}
        onClick={() => act("Open dispute", () => handle.disputes.openDispute(o.id, evidence, { value: bond }))}>
        Dispute{bond > 0n ? ` · ${fmt(bond)} PAS bond` : ""}
      </button>
    </div>
  );
}

function VaultStrip({ vaultBal, vaultTokenBal, pendingDust, busy, act, signed, say }: any) {
  const [cold, setCold] = useState("");
  const stable = stablecoinAsset();
  const hasToken = !!stable && vaultTokenBal > 0n;
  return (
    <div className="vault-strip">
      <div>
        <div className="lbl">vault balance — pull payment</div>
        <div className="amt">{fmt(vaultBal)} PAS</div>
        {hasToken && <div className="amt">{fmtAsset(vaultTokenBal, stable!.address)}</div>}
        {pendingDust > 0n && (
          <div className="hint">+ {fmt(pendingDust)} PAS queued dust (Paseo rounding)</div>
        )}
      </div>
      <div className="btn-row" style={{ flexWrap: "wrap" }}>
        <button className="btn small" disabled={busy || vaultBal === 0n}
          onClick={() => act("Withdraw", () => relayWithdraw(signed!.vault))}>Withdraw</button>
        <button className="btn ghost small" disabled={busy || vaultBal === 0n}
          onClick={() => {
            const to = cold.trim();
            if (!isAddress(to)) return say("Enter a valid cold-wallet address", true);
            act("Withdraw to cold wallet", () => relayWithdraw(signed!.vault, to));
          }}>→ cold wallet</button>
        {hasToken && (
          <button className="btn small" disabled={busy}
            onClick={() => {
              const to = cold.trim();
              const w = to && isAddress(to)
                ? () => signed!.vault.withdrawTokenTo(stable!.address, to)
                : () => signed!.vault.withdrawToken(stable!.address);
              act(`Withdraw ${stable!.symbol}`, w);
            }}>Withdraw {stable!.symbol}</button>
        )}
        {pendingDust > 0n && (
          <button className="btn ghost small" disabled={busy}
            onClick={() => act("Claim dust", () => signed!.vault.claimPaseoDust())}>Claim dust</button>
        )}
        <input style={{ flex: 1, minWidth: 150 }} placeholder="cold wallet 0x… (optional)"
          value={cold} onChange={(e) => setCold(e.target.value)} />
      </div>
    </div>
  );
}

// ---------- customer ----------

function CustomerView({ session, orders, venues, act, busy, signed, say, myLoc, locateMe }: any) {
  // Orders span many per-order wallets (privacy). Match on the local registry
  // rather than a single session address.
  const mineAddrs = orderWalletAddresses();
  const mine = orders.filter((o: OrderRow) => mineAddrs.has(o.customer.toLowerCase()));
  const [sweeping, setSweeping] = useState(false);

  async function sweep() {
    if (!session) return say("Connect a wallet first", true);
    if (!confirm("Sweep refunds to your main wallet? This links your per-order wallets together on-chain.")) return;
    setSweeping(true);
    try {
      const steps = await sweepToMain(session.address);
      const swept = steps.reduce((n, s) => n + (s.swept ?? 0n), 0n);
      const errs = steps.filter((s) => s.error).length;
      say(`Swept ${fmt(swept)} PAS to ${short(session.address)}${errs ? ` (${errs} wallet(s) failed)` : ""}`);
    } catch (e: any) {
      say(e?.message ?? String(e), true);
    } finally {
      setSweeping(false);
    }
  }

  const active = mine.filter((o: OrderRow) => o.status <= 3 || o.status === 6);
  const past = mine
    .filter((o: OrderRow) => o.status === 4 || o.status === 5 || o.status === 7)
    .sort((a: OrderRow, b: OrderRow) => Number(b.id - a.id)); // newest first

  return (
    <>
      <CreateOrder {...{ session, venues, act, busy, say, myLoc, locateMe }} />
      <div className="section-note">
        my orders
        <span className="hint" style={{ display: "block", fontWeight: 400 }}>
          Each order uses a fresh, faucet-funded wallet — consecutive orders can't be linked on-chain.
        </span>
      </div>
      {active.length === 0 && (
        <div className="empty"><span className="dots">· · ·</span>No active orders — place one above.</div>
      )}
      {active.map((o: OrderRow) => (
        <CustomerOrder key={String(o.id)} {...{ o, venues, act, busy, session, say }} />
      ))}

      {past.length > 0 && (
        <details className="history">
          <summary className="section-note">order history · {past.length}</summary>
          {past.map((o: OrderRow) => (
            <HistoryCard key={String(o.id)} {...{ o, venues, act, busy, session, say }} />
          ))}
        </details>
      )}

      {mine.length > 0 && (
        <div className="btn-row" style={{ marginTop: 12 }}>
          <button className="btn ghost small" disabled={busy || sweeping} onClick={sweep}>
            {sweeping ? "Sweeping…" : "Sweep refunds → main wallet"}
          </button>
          <span className="hint">⚠ links your per-order wallets together</span>
        </div>
      )}
    </>
  );
}

function MenuCart({ menu, cart, setCart, rate }: { menu: Menu; cart: Cart; setCart: (c: Cart) => void; rate: number }) {
  const add = (id: string, d: number) => {
    const q = Math.max(0, (cart[id] ?? 0) + d);
    const next = { ...cart };
    if (q === 0) delete next[id];
    else next[id] = q;
    setCart(next);
  };
  const avail = menu.items.filter((i) => i.available !== false);
  const itemFiat = (price: string) => {
    try { return fiatOf(parse(price || "0"), rate); } catch { return ""; }
  };
  return (
    <div className="field">
      <span>menu — {menu.name || "items"} {cartCount(cart) > 0 ? `· ${cartCount(cart)} in cart` : ""}</span>
      {avail.length === 0 && <p className="hint">This venue hasn't published items yet.</p>}
      {avail.map((item) => (
        <div className="kv" key={item.id}>
          <span className="k">
            {item.name}
            {item.desc ? <span className="hint"> · {item.desc}</span> : null}
          </span>
          <span className="v">
            <span className="amount">{itemFiat(item.price) || `${item.price} PAS`} </span>
            {itemFiat(item.price) && <span className="hint">{item.price} PAS </span>}
            {(cart[item.id] ?? 0) > 0 && (
              <>
                <button className="btn ghost small" type="button" onClick={() => add(item.id, -1)}>−</button>
                <span className="mono"> {cart[item.id]} </span>
              </>
            )}
            <button className="btn small" type="button" onClick={() => add(item.id, 1)}>+</button>
          </span>
        </div>
      ))}
    </div>
  );
}

function CreateOrder({ session, venues, act, busy, say, myLoc, locateMe }: any) {
  const [venueId, setVenueId] = useState("");
  const [pos, setPos] = useState<MicroDeg | null>(null);
  const [mapOpen, setMapOpen] = useState(false);
  const [orderValue, setOrderValue] = useState("0"); // manual fallback (no menu)
  const [tip, setTip] = useState("0");
  const [maxFare, setMaxFare] = useState("0.5");
  const [menu, setMenu] = useState<Menu | null>(null);
  const [cart, setCart] = useState<Cart>({});
  const [menuLoading, setMenuLoading] = useState(false);
  const [asset, setAsset] = useState<"native" | "token">("native"); // escrow asset (C3)
  const { rate } = usePasUsd(); // fiat display rate (C2)

  // Fetch the selected venue's off-chain menu (IPFS via metadataURI).
  useEffect(() => {
    setMenu(null);
    setCart({});
    const v = venues.find((x: VenueRow) => String(x.id) === venueId);
    if (!v || !hasMenuURI(v.metadataURI)) return;
    setMenuLoading(true);
    fetchMenu(v.metadataURI).then(setMenu).catch(() => {}).finally(() => setMenuLoading(false));
  }, [venueId]);

  const stable = stablecoinAsset();
  const isToken = asset === "token" && !!stable;
  const escrowToken = isToken ? stable!.address : undefined;
  const sym = isToken ? stable!.symbol : "PAS";
  const menuDriven = !!menu && menu.items.length > 0;
  const useMenu = menuDriven && !isToken; // menus are PAS-priced; token orders use manual entry
  const parseAmt = (v: string) => (isToken ? parseAsset(v, escrowToken) : parse(v));
  const orderValueWei = useMenu ? cartTotal(menu, cart) : parseAmt(orderValue);
  const tipWei = parseAmt(tip);
  const maxFareWei = parseAmt(maxFare);

  // Nearest venues first when we know where the customer is.
  const active = venues
    .filter((v: VenueRow) => v.active)
    .map((v: VenueRow) => ({ v, dist: myLoc ? distanceMeters(myLoc, { lat: v.lat, lon: v.lon }) : null }))
    .sort((a: any, b: any) => (a.dist ?? Infinity) - (b.dist ?? Infinity));

  return (
    <div className="card">
      <h2>Place a pickup order <span className="tag">escrow</span></h2>
      <label className="field">
        <span>
          pickup venue
          {!myLoc && (
            <button className="link-btn" type="button" onClick={locateMe}> · ◉ sort by distance</button>
          )}
        </span>
        <select value={venueId} onChange={(e) => setVenueId(e.target.value)}>
          <option value="">— select —</option>
          {active.map(({ v, dist }: any) => (
            <option key={String(v.id)} value={String(v.id)}>
              #{String(v.id)} · {hasMenuURI(v.metadataURI) ? `Venue #${v.id}` : v.metadataURI.replace(/^\w+:\/\//, "")}
              {dist != null ? ` · ${fmtDist(dist)} away` : ` · ${fmtCoord({ lat: v.lat, lon: v.lon })}`}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>drop location (kept secret — only a commitment goes on-chain)</span>
        <div className="btn-row">
          <button className="btn ghost small" type="button" onClick={() => setMapOpen(true)}>
            ◎ Drop pin on map
          </button>
          <button className="btn ghost small" type="button"
            onClick={async () => { try { setPos(await getPosition()); } catch (e: any) { say(e.message, true); } }}>
            Use my GPS
          </button>
        </div>
        <GeoPill pos={pos} />
      </label>
      {mapOpen && (
        <PinMap
          initial={pos}
          onConfirm={(m) => { setPos(m); setMapOpen(false); }}
          onCancel={() => setMapOpen(false)}
        />
      )}
      {tokenOrdersEnabled() && (
        <label className="field">
          <span>pay with</span>
          <div className="btn-row">
            <button type="button" className={`btn small ${asset === "native" ? "" : "ghost"}`}
              onClick={() => setAsset("native")}>PAS</button>
            <button type="button" className={`btn small ${asset === "token" ? "" : "ghost"}`}
              onClick={() => setAsset("token")}>{stable!.symbol} · stablecoin</button>
          </div>
        </label>
      )}
      {menuLoading && <p className="hint">Loading menu…</p>}
      {useMenu && <MenuCart menu={menu!} cart={cart} setCart={setCart} rate={rate} />}
      {isToken && menuDriven && <p className="hint">This venue's menu is priced in PAS — pay in {sym} using manual amounts below.</p>}

      <div className="row3">
        {useMenu ? (
          <label className="field"><span>cart total{fiatOf(orderValueWei, rate) && ` · ${fiatOf(orderValueWei, rate)}`}</span>
            <input value={`${fmt(orderValueWei)} PAS`} readOnly /></label>
        ) : (
          <label className="field"><span>order value ({sym})</span>
            <input value={orderValue} onChange={(e) => setOrderValue(e.target.value)} inputMode="decimal" /></label>
        )}
        <label className="field"><span>tip ({sym})</span>
          <input value={tip} onChange={(e) => setTip(e.target.value)} inputMode="decimal" /></label>
        <label className="field"><span>max fare ({sym})</span>
          <input value={maxFare} onChange={(e) => setMaxFare(e.target.value)} inputMode="decimal" /></label>
      </div>
      <p className="hint">
        {isToken
          ? `Escrowed in ${sym}. The private wallet mints its ${sym} escrow from the testnet faucet — no link to your main wallet.`
          : useMenu
          ? "Cart total is escrowed for the venue; add a tip and set your delivery-fare ceiling."
          : "Order value 0 = pay the venue off-chain; the protocol then only escrows the delivery fare."}
      </p>
      <div className="btn-row">
        <button className="btn" disabled={busy || !session || !venueId || !pos}
          onClick={() => {
            const items = useMenu
              ? menu!.items
                  .filter((it) => (cart[it.id] ?? 0) > 0)
                  .map((it) => ({ name: it.name, price: it.price, qty: cart[it.id] }))
              : [];
            const receipt: ReceiptData = {
              venueId, venueName: menu?.name || `Venue #${venueId}`, items,
              orderValue: fmtAsset(orderValueWei, escrowToken), tip, maxFare,
              rateUsd: cachedRate(), // capture the fiat rate at checkout (C2)
            };
            // Fresh per-order identity, funded from the faucet so it links to
            // nothing (docs/PRIVACY.md risk #3); persists a local receipt (B7).
            placeOrder({
              venueId: BigInt(venueId), orderValueWei, tipWei, maxFareWei,
              lat: pos!.lat, lon: pos!.lon, receipt, token: escrowToken, act, say,
            });
          }}>
          Open for bids
        </button>
      </div>
    </div>
  );
}

const TRACK_STEPS = [
  { s: 1, label: "Placed" },
  { s: 2, label: "Driver assigned" },
  { s: 3, label: "Picked up" },
  { s: 4, label: "Delivered" },
];

function fmtLeft(sec: number): string {
  if (sec <= 0) return "now";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// B2 — live order tracking. The status stepper + ETA are derived entirely from
// on-chain data (order status + deadlines); a live driver-location dot needs the
// off-chain location relay (Group B follow-on / see NETWORK-ARCHITECTURE.md).
function OrderTracker({ o }: { o: OrderRow }) {
  const [now, setNow] = useState(Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  if (o.status >= 5) {
    return <div className="track-eta">{STATUS[o.status]}</div>; // Cancelled/Disputed/Resolved
  }

  let eta = "";
  if (o.status === 1) eta = "Waiting for driver bids…";
  else if (o.status === 2) {
    const left = Number(o.pickupDeadline) - now;
    eta = left > 0 ? `Driver heading to venue · pickup in ~${fmtLeft(left)}` : "Pickup overdue";
  } else if (o.status === 3) {
    const left = Number(o.deliveryDeadline) - now;
    eta = left > 0 ? `On the way · ETA ~${fmtLeft(left)}` : "Delivery overdue";
  } else if (o.status === 4) eta = "Delivered 🎉";

  return (
    <div className="tracker">
      <div className="track-steps">
        {TRACK_STEPS.map((st) => {
          const done = o.status > st.s || o.status === 4;
          const active = o.status === st.s && o.status !== 4;
          return (
            <div key={st.s} className={`track-step ${done ? "done" : active ? "active" : ""}`}>
              <span className="dot">{done ? "✓" : st.s}</span>
              <span className="lbl">{st.label}</span>
            </div>
          );
        })}
      </div>
      <div className="track-eta">{eta}</div>
    </div>
  );
}

// B7 — itemized receipt (local cart snapshot + on-chain amounts).
// C2 — when a fiat rate was captured at checkout, show the locked fiat value
// alongside PAS (the rate is fixed to the receipt, not the live one).
function OrderReceipt({ o }: { o: OrderRow }) {
  const r = loadReceipt(o.dropCommit);
  const isToken = assetOf(o.token).isToken;
  // Fiat is only meaningful for a PAS order — a stablecoin order already reads in
  // dollars. So show the captured-rate fiat only on native orders (C2/C3).
  const rate = isToken ? undefined : r?.rateUsd;
  const total = o.orderValue + o.tip + o.fare;
  const fiat = (wei: bigint) => (rate ? formatUsd(pasToUsd(wei, rate)) : "");
  return (
    <details className="payload-details">
      <summary>receipt</summary>
      {r && (
        <>
          <div className="kv"><span className="k">{r.venueName}</span>
            <span className="v hint">{r.placedAt ? new Date(r.placedAt).toLocaleDateString() : ""}</span></div>
          {r.items.map((it, i) => (
            <div className="kv" key={i}>
              <span className="k">{it.qty}× {it.name}</span>
              <span className="v mono">{it.price} PAS</span>
            </div>
          ))}
        </>
      )}
      <div className="kv"><span className="k">order value</span><span className="v mono">{fmtAsset(o.orderValue, o.token)}</span></div>
      <div className="kv"><span className="k">tip</span><span className="v mono">{fmtAsset(o.tip, o.token)}</span></div>
      {o.fare > 0n && <div className="kv"><span className="k">delivery fare</span><span className="v mono">{fmtAsset(o.fare, o.token)}</span></div>}
      <div className="kv"><span className="k">total</span>
        <span className="v amount">{rate ? `${fiat(total)} · ` : ""}{fmtAsset(total, o.token)}</span></div>
      {rate && <p className="hint">Fiat locked at checkout @ {formatUsd(rate)}/PAS.</p>}
      {!r && <p className="hint">No itemized breakdown on this device.</p>}
    </details>
  );
}

function StarRow({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <div className="kv">
      <span className="k">{label}</span>
      <span className="v">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" className="star-btn" onClick={() => onChange(n)}>
            {n <= value ? "★" : "☆"}
          </button>
        ))}
      </span>
    </div>
  );
}

// B5 — verified-delivery rating. Signed by the order's per-order wallet (the
// contract gates: only the Delivered order's customer can rate, once).
function RateWidget({ o, busy, act, say }: any) {
  const [dStars, setDStars] = useState(0);
  const [vStars, setVStars] = useState(0);
  const [done, setDone] = useState(false);
  useEffect(() => {
    contracts().ratings?.rated(o.id).then((r: boolean) => setDone(r)).catch(() => {});
  }, [String(o.id)]);
  const os = contractsForOrder(o.customer);
  if (!ratingsEnabled()) return null;
  if (done) return <p className="hint">★ You rated this order — thanks!</p>;
  return (
    <div className="rate-widget">
      <StarRow label="rate driver" value={dStars} onChange={setDStars} />
      <StarRow label="rate venue" value={vStars} onChange={setVStars} />
      <div className="btn-row">
        <button className="btn small" disabled={busy || !os || (dStars === 0 && vStars === 0)}
          onClick={() =>
            act("Rate", () => relayForward("ratings", os!.ratings, "rate", [o.id, dStars, vStars])).then(() => setDone(true))
          }>
          Submit rating
        </button>
      </div>
    </div>
  );
}

function HistoryCard({ o, venues, act, busy, session, say }: any) {
  const canReorder = !!localStorage.getItem(dropStoreKey(o.dropCommit));
  async function reorder() {
    const stored = localStorage.getItem(dropStoreKey(o.dropCommit));
    if (!stored) return say("Can't reorder — drop location isn't on this device", true);
    const { lat, lon } = JSON.parse(stored);
    const r = loadReceipt(o.dropCommit) ?? {
      venueId: String(o.venueId), venueName: `Venue #${o.venueId}`, items: [],
      orderValue: fmt(o.orderValue), tip: fmt(o.tip), maxFare: fmt(o.maxFare),
    };
    r.rateUsd = cachedRate(); // re-capture at reorder time (C2)
    await placeOrder({
      venueId: o.venueId, orderValueWei: o.orderValue, tipWei: o.tip, maxFareWei: o.maxFare,
      token: o.token, lat, lon, receipt: r, act, say,
    });
  }
  return (
    <div className="order" style={{ opacity: 0.9 }}>
      <div className="order-head">
        <span className="order-id">Order #{String(o.id)}</span>
        <span className={`badge ${badgeClass(o.status)}`}>{STATUS[o.status]}</span>
      </div>
      <OrderMeta o={o} venues={venues} />
      <OrderReceipt o={o} />
      {o.status === 4 && <RateWidget o={o} busy={busy} act={act} say={say} />}
      <div className="btn-row">
        <button className="btn ghost small" disabled={busy || !session || !canReorder}
          onClick={reorder} title={canReorder ? "" : "Drop location not on this device"}>
          Reorder
        </button>
      </div>
    </div>
  );
}

/// End-to-end encrypted order chat (B3). Content is sealed client-side (msg.ts)
/// and moved over the relay channel (channel.ts); the relay never sees plaintext.
/// Needs a local-key wallet for ECDH, so it no-ops for injected wallets.
function ChatPanel({ orderId, myPriv, myAddr, peerAddr }: { orderId: bigint; myPriv?: string | null; myAddr?: string; peerAddr?: string }) {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [text, setText] = useState("");
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);
  const threadRef = useRef<OrderThread | null>(null);

  useEffect(() => {
    if (!open || !myPriv || !myAddr || !peerAddr || !isAddress(peerAddr)) return;
    const t = new OrderThread(orderId, myPriv, myAddr, peerAddr);
    threadRef.current = t;
    let alive = true;
    t.open().catch(() => {});
    const tick = async () => {
      try { const nu = await t.poll(); if (alive && nu.length) setMsgs((m) => [...m, ...nu]); } catch { /* transient */ }
    };
    tick();
    const iv = setInterval(tick, 4000);
    return () => { alive = false; clearInterval(iv); threadRef.current = null; };
  }, [open, String(orderId), myPriv, myAddr, peerAddr]);

  if (!myPriv || !peerAddr || !isAddress(peerAddr)) return null;

  const send = async () => {
    const t = threadRef.current;
    const body = text.trim();
    if (!t || !body) return;
    try { const mine = await t.send(body); setMsgs((m) => [...m, mine]); setText(""); setNote(""); }
    catch (e: any) { setNote(e?.message ?? "couldn't send"); }
  };

  return (
    <div style={{ marginTop: 8 }}>
      <button className="btn ghost small" onClick={() => setOpen((v) => !v)}>
        💬 {open ? "Hide chat" : "Chat"}{msgs.length ? ` (${msgs.length})` : ""}
      </button>
      {open && (
        <div style={{ border: "1px solid #333", borderRadius: 8, padding: 8, marginTop: 6 }}>
          <div style={{ maxHeight: 160, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
            {msgs.length === 0 && <span className="hint">End-to-end encrypted, per-order. Say hi 👋</span>}
            {msgs.map((m, i) => (
              <div key={i} style={{ alignSelf: m.mine ? "flex-end" : "flex-start", background: m.mine ? "#b57bff" : "#222", color: m.mine ? "#000" : "inherit", padding: "3px 8px", borderRadius: 10, maxWidth: "80%", wordBreak: "break-word" }}>
                {m.text}
              </div>
            ))}
          </div>
          <div className="btn-row" style={{ marginTop: 6 }}>
            <input style={{ flex: 1 }} value={text} onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") send(); }} placeholder="message… (E2E)" />
            <button className="btn small" onClick={send} disabled={!text.trim()}>Send</button>
          </div>
          {note && <div className="hint" style={{ marginTop: 4 }}>{note}</div>}
        </div>
      )}
    </div>
  );
}

/// Driver-side delivery tools (B2 + B6). Maintains one channel thread for the
/// order; the driver can opt-in to share live location (E2E, throttled) and/or
/// send a proof-of-delivery photo (compressed + sealed under a fresh key; only
/// the key travels E2E, the blob goes to the photo store). Nothing on-chain.
function TrackPublisher({ orderId, myPriv, myAddr, peerAddr }: { orderId: bigint; myPriv?: string | null; myAddr?: string; peerAddr?: string }) {
  const [sharing, setSharing] = useState(false);
  const [note, setNote] = useState("");
  const [photo, setPhoto] = useState("");
  const threadRef = useRef<OrderThread | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // One thread for the order — learns the customer's key + carries loc/photo.
  useEffect(() => {
    if (!myPriv || !myAddr || !peerAddr || !isAddress(peerAddr)) return;
    const t = new OrderThread(orderId, myPriv, myAddr, peerAddr);
    threadRef.current = t;
    let alive = true;
    t.open().catch(() => {});
    t.poll().catch(() => {});
    const iv = setInterval(() => { if (alive) t.poll().catch(() => {}); }, 4000);
    return () => { alive = false; clearInterval(iv); threadRef.current = null; };
  }, [String(orderId), myPriv, myAddr, peerAddr]);

  // Location watch, gated on the opt-in toggle.
  useEffect(() => {
    if (!sharing) return;
    if (!("geolocation" in navigator)) { setNote("no geolocation on this device"); return; }
    let last = 0;
    const wid = navigator.geolocation.watchPosition(
      (pos) => {
        const now = Date.now();
        if (now - last < 8000) return; // throttle to ~8s
        last = now;
        const lat = Math.round(pos.coords.latitude * 1e6);
        const lon = Math.round(pos.coords.longitude * 1e6);
        threadRef.current?.sendLoc(lat, lon).then((ok) => setNote(ok ? "sharing your location…" : "waiting for the customer to open tracking…")).catch(() => {});
      },
      (err) => setNote(err.message),
      { enableHighAccuracy: true, maximumAge: 5000 }
    );
    return () => navigator.geolocation.clearWatch(wid);
  }, [sharing]);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    const t = threadRef.current;
    if (!f || !t) return;
    setPhoto("sealing…");
    try {
      const bytes = await compressImage(f); // downscale + strip EXIF
      const key = newPhotoKey(); // crypto-shred handle
      const sealed = await sealPhoto(key, bytes);
      setPhoto("storing…");
      const id = await storeSealed(sealed);
      const ok = await t.sendPhoto(key, id);
      setPhoto(ok ? "delivery photo sent ✓ (expires)" : "stored — will deliver when the customer opens the order");
    } catch (err: any) {
      setPhoto(err?.message ?? "photo failed");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  if (!myPriv || !peerAddr || !isAddress(peerAddr)) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <div className="btn-row">
        <button className={sharing ? "btn small" : "btn ghost small"} onClick={() => setSharing((s) => !s)}>
          {sharing ? "📍 Sharing — stop" : "📍 Share location"}
        </button>
        <button className="btn ghost small" onClick={() => fileRef.current?.click()}>📷 Delivery photo</button>
        <input ref={fileRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }} onChange={onFile} />
      </div>
      {sharing && note && <div className="hint" style={{ marginTop: 4 }}>{note}</div>}
      {photo && <div className="hint" style={{ marginTop: 4 }}>{photo}</div>}
    </div>
  );
}

/// Customer-side live-tracking panel (B2). Subscribes to the driver's E2E
/// location updates and renders them on a tile-less map with distance + a rough
/// ETA. The driver's position is decrypted locally and never leaves the device.
function TrackPanel({ orderId, myPriv, myAddr, peerAddr, drop, venue }: { orderId: bigint; myPriv?: string | null; myAddr?: string; peerAddr?: string; drop?: MicroDeg | null; venue?: MicroDeg | null }) {
  const [open, setOpen] = useState(false);
  const [driver, setDriver] = useState<MicroDeg | null>(null);
  const [trace, setTrace] = useState<MicroDeg[]>([]);
  const [photoUrl, setPhotoUrl] = useState("");
  const [photoNote, setPhotoNote] = useState("");

  useEffect(() => {
    if (!open || !myPriv || !myAddr || !peerAddr || !isAddress(peerAddr)) return;
    const onLoc = (l: LocUpdate) => {
      const p = { lat: l.lat, lon: l.lon };
      setDriver(p);
      setTrace((tr) => [...tr.slice(-40), p]);
    };
    const onPhoto = async (ref: { key: string; id: string }) => {
      setPhotoNote("decrypting delivery photo…");
      try {
        const sealed = await fetchSealed(ref.id);
        const bytes = await openPhoto(ref.key, sealed);
        setPhotoUrl(photoObjectUrl(bytes));
        setPhotoNote("");
      } catch (e: any) {
        setPhotoNote(e?.message ?? "photo unavailable");
      }
    };
    const t = new OrderThread(orderId, myPriv, myAddr, peerAddr, onLoc, onPhoto);
    let alive = true;
    t.open().catch(() => {});
    const tick = () => { if (alive) t.poll().catch(() => {}); };
    tick();
    const iv = setInterval(tick, 4000);
    return () => { alive = false; clearInterval(iv); };
  }, [open, String(orderId), myPriv, myAddr, peerAddr]);

  useEffect(() => () => { if (photoUrl) URL.revokeObjectURL(photoUrl); }, [photoUrl]);

  if (!myPriv || !peerAddr || !isAddress(peerAddr) || !drop) return null;
  const distM = driver ? distanceMeters(driver, drop) : null;
  const etaMin = distM != null ? Math.max(1, Math.round(distM / (25_000 / 60))) : null; // ~25 km/h

  return (
    <div style={{ marginTop: 8 }}>
      <button className="btn ghost small" onClick={() => setOpen((v) => !v)}>🗺️ {open ? "Hide tracking" : "Track driver"}</button>
      {open && (
        <div style={{ marginTop: 6 }}>
          {driver ? (
            <>
              <TrackMap drop={drop} venue={venue} driver={driver} trace={trace} />
              <div className="hint" style={{ marginTop: 4 }}>
                {distM != null && `${fmtDist(distM)} away`}{etaMin != null && ` · ~${etaMin} min`} · location is end-to-end encrypted
              </div>
            </>
          ) : (
            <div className="hint">Waiting for the driver to share their location…</div>
          )}
          {photoUrl && (
            <div style={{ marginTop: 8 }}>
              <div className="hint">📷 Proof of delivery — end-to-end encrypted, expires:</div>
              <img src={photoUrl} alt="proof of delivery" style={{ maxWidth: "100%", borderRadius: 8, marginTop: 4 }} />
            </div>
          )}
          {photoNote && <div className="hint" style={{ marginTop: 4 }}>{photoNote}</div>}
        </div>
      )}
    </div>
  );
}

function CustomerOrder({ o, venues, act, busy, session, say }: any) {
  const [payload, setPayload] = useState("");
  const [scanning, setScanning] = useState(false);
  // Every action on this order (cancel, tip, accept, confirm) must come from the
  // per-order wallet that created it — the contract checks msg.sender == customer.
  const os = contractsForOrder(o.customer);
  const orphaned = !os; // wallet not on this device (e.g. different browser)

  async function topUp() {
    try {
      say("Topping up this order's wallet from the faucet…");
      const r = await sponsorGas(o.customer);
      say(r.funded ? "Topped up ✓" : r.reason === "sufficient" ? "Already funded" : "Faucet unavailable", !r.funded && r.reason !== "sufficient");
    } catch (e: any) {
      say(e?.message ?? String(e), true);
    }
  }

  // ZK dropoff: scan the driver's signed position code, then prove — entirely
  // on this device — that the driver is within the drop radius of our committed
  // location, WITHOUT either coordinate ever going on-chain.
  async function confirmDelivery(driverPayload: string) {
    try {
      const stored = localStorage.getItem(dropStoreKey(o.dropCommit));
      if (!stored) throw new Error("Drop-location secret not on this device");
      const drop = JSON.parse(stored); // { lat, lon, salt }
      const other = decodePayload(driverPayload);
      if (other.kind !== "dropoff-driver") throw new Error("That's not a driver handoff code");
      const { att, sig } = other; // DriverCommitAttestation + signature
      const dp = other.pos; // { lat, lon, salt } shared by the driver at the door
      if (!dp) throw new Error("Driver code is missing the position data");

      const radiusMeters = Number(await contracts().settlement.dropoffRadiusMeters());
      say("Building delivery proof… (a few seconds)");
      const { proof, pubSignals } = await proveProximity({
        orderId: o.id.toString(),
        radiusMeters,
        cust: { lat: drop.lat, lon: drop.lon, salt: drop.salt },
        driver: { lat: dp.lat, lon: dp.lon, salt: dp.salt },
      });
      // Sanity: the driver's signed commitment must equal what we proved against.
      if (BigInt(att.posCommit) !== pubSignals[2]) {
        throw new Error("Driver's signed position doesn't match the shared coordinates");
      }
      if (!os) throw new Error("This order's wallet isn't on this device");
      await act("Confirm delivery", () =>
        relaySettle(os, "confirmDropoffZK", [att, sig, proof, pubSignals])
      );
      say("Delivery confirmed — fare released 🎉");
    } catch (e: any) {
      say(e?.message ?? String(e), true);
    }
  }

  return (
    <div className="order">
      <div className="order-head">
        <span className="order-id">Order #{String(o.id)}</span>
        <ExpiryBadge o={o} />
        <span className={`badge ${badgeClass(o.status)}`}>{STATUS[o.status]}</span>
      </div>
      <OrderTracker o={o} />
      <OrderMeta o={o} venues={venues} />
      <div className="kv">
        <span className="k">private wallet</span>
        <span className="v mono" title={o.customer}>
          {short(o.customer)}
          {!orphaned && o.status !== 4 && o.status !== 5 && (
            <button className="link-btn" type="button" disabled={busy} onClick={topUp}> · ⛽ top up</button>
          )}
        </span>
      </div>
      {orphaned && (
        <p className="hint">⚠ This order was placed from another device — its wallet isn't here, so you can't act on it.</p>
      )}
      <OrderReceipt o={o} />

      {o.status === 1 && (
        <>
          <div className="section-note">driver bids — you pick, price isn't everything</div>
          {o.bidders.length === 0 && <p className="hint">Waiting for driver bids…</p>}
          {o.bidders.map((b: any) => (
            <div className="kv" key={b.addr}>
              <span className="k mono">
                {short(b.addr)}
                <span className="hint" title="rating · delivered / failed on-chain">
                  {b.ratingN > 0 ? ` · ★${(b.ratingX100 / 100).toFixed(1)} (${b.ratingN})` : ""}
                  {" "}· ✓{b.delivered} ✗{b.failed}
                  {b.delivered + b.failed > 0
                    ? ` · ${Math.round((b.delivered / (b.delivered + b.failed)) * 100)}%`
                    : " · new"}
                </span>
              </span>
              <span className="v">
                <span className="amount">{fmtAsset(b.amount, o.token)} </span>
                <button className="btn small" disabled={busy || orphaned}
                  onClick={() => act("Accept bid", async () => {
                    // Value action → must go direct; ensure the order burner has
                    // gas first. Gasless actions skip this entirely.
                    if (assetOf(o.token).isToken) {
                      // Escrow the fare in the order's stablecoin: the burner
                      // self-mints it (testnet faucet), approves, then accepts.
                      await ensureGas(o.customer, parse("0.3"));
                      const w = walletFor(o.customer)!;
                      await mintStablecoin(w, o.customer, b.amount);
                      await approveToken(w, o.token, ADDRESSES.orders, b.amount);
                      return os!.orders.acceptBidERC20(o.id, b.addr);
                    }
                    await ensureGas(o.customer, b.amount + parse("0.2"));
                    return os!.orders.acceptBid(o.id, b.addr, { value: b.amount });
                  })}>
                  Accept
                </button>
              </span>
            </div>
          ))}
          <div className="btn-row">
            <button className="btn danger small" disabled={busy || orphaned}
              onClick={() => act("Cancel order", () => relayForward("orders", os!.orders, "cancelOpen", [o.id]))}>Cancel</button>
          </div>
        </>
      )}

      {o.status === 2 && (
        <div className="btn-row">
          <button className="btn danger small" disabled={busy || orphaned}
            onClick={() => act("Cancel", () => relayForward("orders", os!.orders, "cancelAssigned", [o.id]))}>
            Cancel (driver keeps a cut pre-deadline)
          </button>
        </div>
      )}

      {o.status === 3 && (
        <>
          <p className="hint">
            Driver at your door? Scan their handoff code. Your device proves — in zero knowledge —
            that they're at your door and releases the fare. Your address never touches the chain.
          </p>
          {scanning && (
            <QRScan
              expectKind="dropoff-driver"
              onResult={(v) => { setScanning(false); setPayload(v); confirmDelivery(v); }}
              onCancel={() => setScanning(false)}
            />
          )}
          <label className="field">
            <span>driver handoff code</span>
            <button className="btn ghost small" type="button" disabled={busy}
              onClick={() => setScanning(true)}>⧉ Scan driver QR</button>
            <textarea value={payload} onChange={(e) => setPayload(e.target.value)}
              placeholder="…or paste code" />
          </label>
          <div className="btn-row">
            <button className="btn" disabled={busy || !payload || !session || orphaned}
              onClick={() => confirmDelivery(payload)}>
              Confirm delivery
            </button>
          </div>
        </>
      )}
      {(o.status === 2 || o.status === 3) && (
        <ChatPanel orderId={o.id} myPriv={walletFor(o.customer)?.privateKey} myAddr={o.customer} peerAddr={o.driver} />
      )}
      {(o.status === 2 || o.status === 3) && (() => {
        // The customer knows their own drop (stored locally at order creation);
        // the driver's live position arrives E2E over the channel.
        let drop: MicroDeg | null = null;
        try { const r = JSON.parse(localStorage.getItem(dropStoreKey(o.dropCommit)) || "null"); if (r) drop = { lat: r.lat, lon: r.lon }; } catch { /* no local drop */ }
        const v = venues.find((x: VenueRow) => String(x.id) === String(o.venueId));
        return (
          <TrackPanel orderId={o.id} myPriv={walletFor(o.customer)?.privateKey} myAddr={o.customer} peerAddr={o.driver}
            drop={drop} venue={v ? { lat: v.lat, lon: v.lon } : null} />
        );
      })()}
      {(o.status === 2 || o.status === 3 || o.status === 6) && (
        <DisputeControl o={o} handle={os} busy={busy} act={act} />
      )}
    </div>
  );
}

// ---------- driver ----------

function DriverView({ session, orders, venues, act, busy, signed, say, myLoc, radiusKm, setRadiusKm, locateMe }: any) {
  const [me, setMe] = useState<any>(null);
  useEffect(() => {
    if (!session) return;
    contracts().drivers.drivers(session.address).then(setMe).catch(() => {});
  }, [session, orders]);

  const jobs = orders.filter(
    (o: OrderRow) =>
      session &&
      o.driver.toLowerCase() === session.address.toLowerCase() &&
      (o.status === 2 || o.status === 3 || o.status === 6)
  );

  // Open orders, tagged with pickup distance (from my location to the public
  // venue pin). With a radius set we hide out-of-town pickups; either way we
  // sort nearest-first so the closest jobs surface.
  const nowSec = Math.floor(Date.now() / 1000);
  const venueOf = (o: OrderRow) => venues.find((v: VenueRow) => v.id === o.venueId);
  // Drop stale (abandoned) open orders — a driver shouldn't chase them.
  const openLive = orders.filter((o: OrderRow) => o.status === 1 && !orderExpiry(o, nowSec));
  const staleCount = orders.filter((o: OrderRow) => o.status === 1).length - openLive.length;
  const openTagged = openLive.map((o: OrderRow) => {
    const v = venueOf(o);
    const dist = myLoc && v ? distanceMeters(myLoc, { lat: v.lat, lon: v.lon }) : null;
    return { o, dist };
  });
  const filtering = !!myLoc && radiusKm > 0;
  const shown = (filtering
    ? openTagged.filter((x: any) => x.dist != null && x.dist <= radiusKm * 1000)
    : openTagged
  ).sort((a: any, b: any) => (a.dist ?? Infinity) - (b.dist ?? Infinity));
  const hidden = openTagged.length - shown.length;

  // Venue pins for the proximity map, tagged with their live open-order count.
  const openByVenue = new Map<string, number>();
  for (const o of openLive) openByVenue.set(String(o.venueId), (openByVenue.get(String(o.venueId)) ?? 0) + 1);
  const venuePins: VenuePin[] = venues.map((v: VenueRow) => ({
    id: String(v.id),
    lat: v.lat,
    lon: v.lon,
    name: v.metadataURI.replace(/^\w+:\/\//, ""),
    openCount: openByVenue.get(String(v.id)) ?? 0,
  }));

  if (session && me && !me.registered) return <DriverRegister {...{ act, busy, signed }} />;

  return (
    <>
      {me?.registered && <DriverAccount {...{ me, act, busy, signed, say }} />}
      {jobs.length > 0 && <div className="section-note">active jobs</div>}
      {jobs.map((o: OrderRow) => (
        <DriverJob key={String(o.id)} {...{ o, venues, act, busy, signed, session, say }} />
      ))}

      <div className="area-bar">
        <button className="btn ghost small" type="button" onClick={locateMe}>
          ◉ {myLoc ? "Update my area" : "Set my area (GPS)"}
        </button>
        {myLoc && (
          <label className="area-radius">
            within
            <select value={radiusKm} onChange={(e) => setRadiusKm(Number(e.target.value))}>
              <option value={5}>5 km</option>
              <option value={15}>15 km</option>
              <option value={50}>50 km</option>
              <option value={0}>everywhere</option>
            </select>
          </label>
        )}
      </div>

      {myLoc && venuePins.length > 0 && (
        <AreaMap center={myLoc} venues={venuePins} radiusKm={radiusKm} />
      )}

      <div className="section-note">
        open orders — bid your fare
        {filtering && ` · near you${hidden > 0 ? ` (${hidden} farther away hidden)` : ""}`}
        {staleCount > 0 && ` · ${staleCount} stale hidden`}
      </div>
      {shown.length === 0 && (
        <div className="empty">
          <span className="dots">· · ·</span>
          {myLoc && hidden > 0
            ? `No open orders within ${radiusKm} km — widen the radius to see ${hidden} more.`
            : "No open orders right now."}
        </div>
      )}
      {shown.map(({ o, dist }: any) => (
        <DriverBid key={String(o.id)} {...{ o, venues, act, busy, signed, session, dist }} />
      ))}
    </>
  );
}

function DriverRegister({ act, busy, signed }: any) {
  const [name, setName] = useState("");
  const [stake, setStake] = useState("0");
  return (
    <div className="card">
      <h2>Register as a driver <span className="tag">one-time</span></h2>
      <label className="field"><span>profile (name / vehicle)</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Dana · e-bike" /></label>
      <label className="field"><span>stake (PAS, optional — builds trust, slashable on fraud)</span>
        <input value={stake} onChange={(e) => setStake(e.target.value)} inputMode="decimal" /></label>
      <div className="btn-row">
        <button className="btn" disabled={busy}
          onClick={() => act("Register", () => signed.drivers.register(`demo://${name || "driver"}`, { value: parse(stake) }))}>
          Register
        </button>
      </div>
    </div>
  );
}

function DriverAccount({ me, act, busy, signed, say }: any) {
  const [add, setAdd] = useState("");
  const [profile, setProfile] = useState("");
  const [unbonding, setUnbonding] = useState(0);
  useEffect(() => {
    contracts().drivers.unbondingSeconds().then((s: bigint) => setUnbonding(Number(s))).catch(() => {});
  }, []);
  const reqAt = Number(me.unstakeRequestedAt);
  const remaining = reqAt > 0 ? reqAt + unbonding - Math.floor(Date.now() / 1000) : 0;
  const dur = (s: number) => (s > 3600 ? `${Math.ceil(s / 3600)}h` : s > 60 ? `${Math.ceil(s / 60)}m` : `${s}s`);
  return (
    <div className="card">
      <h2>My driver account</h2>
      <div className="kv"><span className="k">stake</span><span className="v amount">{fmt(me.stake)} PAS</span></div>
      <div className="kv"><span className="k">reputation</span>
        <span className="v">✓{Number(me.delivered)} delivered · ✗{Number(me.failed)} failed</span></div>
      {reqAt > 0 && (
        <div className="kv"><span className="k">unbonding</span>
          <span className="v">{remaining > 0 ? `unlocks in ~${dur(remaining)}` : "ready to withdraw"}</span></div>
      )}
      <div className="btn-row" style={{ flexWrap: "wrap" }}>
        <input style={{ flex: 1, minWidth: 90 }} placeholder="add PAS" value={add}
          onChange={(e) => setAdd(e.target.value)} inputMode="decimal" />
        <button className="btn small" disabled={busy || !add}
          onClick={() => act("Add stake", () => signed.drivers.addStake({ value: parse(add) }))}>Add stake</button>
        {reqAt === 0 ? (
          <button className="btn ghost small" disabled={busy || me.stake === 0n}
            onClick={() => act("Request unstake", () => signed.drivers.requestUnstake())}>Request unstake</button>
        ) : (
          <button className="btn ghost small" disabled={busy || remaining > 0}
            onClick={() => act("Withdraw stake", () => signed.drivers.withdrawStake())}>Withdraw stake</button>
        )}
      </div>
      <div className="btn-row" style={{ flexWrap: "wrap" }}>
        <input style={{ flex: 1, minWidth: 120 }} placeholder="update profile (name / vehicle)"
          value={profile} onChange={(e) => setProfile(e.target.value)} />
        <button className="btn ghost small" disabled={busy || !profile}
          onClick={() => act("Update profile", () => signed.drivers.setMetadata(`demo://${profile}`))}>Save</button>
      </div>
    </div>
  );
}

function DriverBid({ o, venues, act, busy, signed, session, dist }: any) {
  const [amount, setAmount] = useState("");
  const myBid = o.bidders.find(
    (b: any) => session && b.addr.toLowerCase() === session.address.toLowerCase()
  );
  return (
    <div className="order">
      <div className="order-head">
        <span className="order-id">Order #{String(o.id)}</span>
        {dist != null && <span className="dist-pill">◉ {fmtDist(dist)} to pickup</span>}
        <span className={`badge ${badgeClass(o.status)}`}>{STATUS[o.status]}</span>
      </div>
      <OrderMeta o={o} venues={venues} />
      {myBid && (
        <div className="kv"><span className="k">your bid</span><span className="v amount">{fmtAsset(myBid.amount, o.token)}</span></div>
      )}
      <div className="btn-row">
        <input style={{ flex: 1, minWidth: 120 }} placeholder={`≤ ${fmtAsset(o.maxFare, o.token)}`}
          value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
        <button className="btn small" disabled={busy || !amount}
          onClick={() => act("Place bid", () => relayForward("orders", signed.orders, "placeBid", [o.id, parseAsset(amount, o.token)]))}>
          {myBid ? "Rebid" : "Bid"}
        </button>
        {myBid && (
          <button className="btn ghost small" disabled={busy}
            onClick={() => act("Withdraw bid", () => relayForward("orders", signed.orders, "withdrawBid", [o.id]))}>
            Withdraw
          </button>
        )}
      </div>
    </div>
  );
}

function DriverJob({ o, venues, act, busy, signed, session, say }: any) {
  const [counterpartyPayload, setCounterpartyPayload] = useState("");
  const [scanning, setScanning] = useState(false);
  const [payload, setPayload] = useState(""); // dropoff: driver's handoff code
  const venue = venues.find((v: VenueRow) => v.id === o.venueId);
  const isPickup = o.status === 2;

  // Pickup: driver signs GPS, scans the venue code, and submits (unchanged —
  // the venue pin is public, so there's nothing to hide at pickup).
  async function submitPickup() {
    try {
      const pos = await getPosition();
      if (venue) {
        const d = distanceMeters(pos, { lat: venue.lat, lon: venue.lon });
        if (d > 400) say(`Heads up: you look ~${Math.round(d)} m from the venue pin`, true);
      }
      // Coarsen to a ~33 m grid before signing so the exact spot never enters
      // calldata (privacy); still well within the pickup radius. See geo.ts.
      const at = snapToGrid(pos);
      const myAtt = {
        orderId: o.id.toString(), phase: 1, actor: session.address,
        lat: at.lat, lon: at.lon, timestamp: Math.floor(Date.now() / 1000),
      };
      const mySig = await signLocation(session, myAtt);
      const other = decodePayload(counterpartyPayload);
      if (other.kind !== "pickup-venue") throw new Error("That's not a venue pickup code");
      await act("Confirm pickup", () =>
        relaySettle(signed, "confirmPickup", [myAtt, mySig, other.att, other.sig])
      );
      setCounterpartyPayload("");
    } catch (e: any) {
      say(e?.message ?? String(e), true);
    }
  }

  // Dropoff (ZK): the driver commits to their OWN position and shares it with
  // the customer, who builds the proof and submits. The driver never reveals a
  // coordinate on-chain and never submits — they hand off a signed commitment
  // plus the position data the customer needs to prove proximity.
  async function signDropoffHandoff() {
    try {
      const pos = await getPosition();
      const salt = randomSalt();
      const posCommit = positionCommit(pos.lat, pos.lon, salt);
      const att = {
        orderId: o.id.toString(), phase: 2, actor: session.address,
        posCommit, timestamp: Math.floor(Date.now() / 1000),
      };
      const sig = await signDriverCommit(session, att);
      // The customer needs the plaintext position (they'll prove locally and it
      // never leaves their device in the clear). QR is exchanged face-to-face.
      setPayload(encodePayload("dropoff-driver", att, sig, { lat: pos.lat, lon: pos.lon, salt }));
      say("Handoff signed — show the code to your customer");
    } catch (e: any) {
      say(e?.message ?? String(e), true);
    }
  }

  return (
    <div className="order" style={{ borderColor: "rgba(255,38,112,0.4)" }}>
      <div className="order-head">
        <span className="order-id">Job #{String(o.id)}</span>
        <ExpiryBadge o={o} />
        <span className={`badge ${badgeClass(o.status)}`}>{STATUS[o.status]}</span>
      </div>
      <OrderMeta o={o} venues={venues} />
      {venue && (
        <div className="kv"><span className="k">pickup pin</span>
          <span className="v">{fmtCoord({ lat: venue.lat, lon: venue.lon })}</span></div>
      )}

      {o.status === 6 ? (
        <DisputeControl o={o} handle={signed} busy={busy} act={act} />
      ) : isPickup ? (
        <>
          <p className="hint">
            At the counter: ask the venue for their signed pickup code, paste it, and confirm. Your
            GPS position is signed and checked on-chain against the venue pin.
          </p>
          {scanning && (
            <QRScan
              expectKind="pickup-venue"
              onResult={(v) => { setCounterpartyPayload(v); setScanning(false); say("Pickup code scanned ✓"); }}
              onCancel={() => setScanning(false)}
            />
          )}
          <label className="field">
            <span>venue pickup code</span>
            <button className="btn ghost small" type="button" disabled={busy} onClick={() => setScanning(true)}>
              ⧉ Scan venue QR
            </button>
            <textarea value={counterpartyPayload} onChange={(e) => setCounterpartyPayload(e.target.value)}
              placeholder="…or paste code" />
          </label>
          <div className="btn-row">
            <button className="btn" disabled={busy || !counterpartyPayload} onClick={submitPickup}>
              Confirm pickup
            </button>
            <button className="btn danger small" disabled={busy}
              onClick={() => act("Abandon", () => relayForward("orders", signed.orders, "abandonOrder", [o.id]))}>Abandon</button>
          </div>
        </>
      ) : (
        <>
          <p className="hint">
            At the door: sign your handoff and show the code to the customer. They prove you're here
            in zero knowledge and release the fare — no coordinates go on-chain.
          </p>
          <div className="btn-row">
            <button className="btn" disabled={busy || !session} onClick={signDropoffHandoff}>
              Sign dropoff handoff
            </button>
          </div>
          {payload && (
            <>
              <p className="hint">Let your customer scan this (or paste the code below):</p>
              <QRShow value={payload} />
              <details className="payload-details">
                <summary>show code text</summary>
                <div className="payload-box">{payload}</div>
              </details>
            </>
          )}
        </>
      )}
      {(o.status === 2 || o.status === 3) && (
        <ChatPanel orderId={o.id} myPriv={(session?.signer as any)?.privateKey} myAddr={session?.address} peerAddr={o.customer} />
      )}
      {(o.status === 2 || o.status === 3) && (
        <TrackPublisher orderId={o.id} myPriv={(session?.signer as any)?.privateKey} myAddr={session?.address} peerAddr={o.customer} />
      )}
      {(o.status === 2 || o.status === 3) && (
        <DisputeControl o={o} handle={signed} busy={busy} act={act} />
      )}
    </div>
  );
}

// ---------- venue ----------

function VenueView({ session, orders, venues, act, busy, signed, say }: any) {
  const mine = venues.filter(
    (v: VenueRow) => session && v.operator.toLowerCase() === session.address.toLowerCase()
  );
  const mySignerVenues = venues.filter(
    (v: VenueRow) => session && v.signer.toLowerCase() === session.address.toLowerCase()
  );
  const queue = orders.filter(
    (o: OrderRow) => o.status === 2 && mySignerVenues.some((v: VenueRow) => v.id === o.venueId)
  );

  return (
    <>
      <VenueRegister {...{ act, busy, signed, say }} />
      {mine.length > 0 && <div className="section-note">my venues</div>}
      {mine.map((v: VenueRow) => (
        <VenueManage key={String(v.id)} {...{ v, act, busy, signed, say }} />
      ))}
      <div className="section-note">pickup queue — driver is here, sign the release</div>
      {queue.length === 0 && (
        <div className="empty"><span className="dots">· · ·</span>No assigned orders waiting for pickup.</div>
      )}
      {queue.map((o: OrderRow) => (
        <VenuePickup key={String(o.id)} {...{ o, venues, session, say }} />
      ))}
    </>
  );
}

function VenueManage({ v, act, busy, signed, say }: any) {
  const [payout, setPayout] = useState("");
  const [signer, setSigner] = useState("");
  const [profile, setProfile] = useState("");
  const [pos, setPos] = useState<MicroDeg | null>(null);
  const [mapOpen, setMapOpen] = useState(false);
  return (
    <div className="order">
      <div className="order-head">
        <span className="order-id">Venue #{String(v.id)}</span>
        <span className={`badge ${v.active ? "open" : "cancelled"}`}>{v.active ? "Active" : "Inactive"}</span>
      </div>
      <div className="kv"><span className="k">profile</span><span className="v">{v.metadataURI}</span></div>
      <div className="kv"><span className="k">pin</span><span className="v">{fmtCoord({ lat: v.lat, lon: v.lon })}</span></div>
      <div className="kv"><span className="k">payout</span><span className="v mono">{short(v.payout)}</span></div>
      <div className="kv"><span className="k">hot signer</span><span className="v mono">{short(v.signer)}</span></div>
      <div className="kv"><span className="k">pickups served</span><span className="v">{v.pickups}</span></div>
      <details className="payload-details">
        <summary>manage</summary>
        <div className="btn-row" style={{ flexWrap: "wrap" }}>
          <button className="btn ghost small" disabled={busy}
            onClick={() => act(v.active ? "Pause venue" : "Activate venue", () => signed.venues.setActive(v.id, !v.active))}>
            {v.active ? "Pause" : "Activate"}
          </button>
        </div>
        <div className="btn-row" style={{ flexWrap: "wrap" }}>
          <input style={{ flex: 1, minWidth: 120 }} placeholder="new payout 0x…" value={payout} onChange={(e) => setPayout(e.target.value)} />
          <button className="btn ghost small" disabled={busy || !isAddress(payout.trim())}
            onClick={() => act("Set payout", () => signed.venues.setPayout(v.id, payout.trim()))}>Set payout</button>
        </div>
        <div className="btn-row" style={{ flexWrap: "wrap" }}>
          <input style={{ flex: 1, minWidth: 120 }} placeholder="new hot signer 0x…" value={signer} onChange={(e) => setSigner(e.target.value)} />
          <button className="btn ghost small" disabled={busy || !isAddress(signer.trim())}
            onClick={() => act("Set signer", () => signed.venues.setSigner(v.id, signer.trim()))}>Set signer</button>
        </div>
        <div className="btn-row" style={{ flexWrap: "wrap" }}>
          <input style={{ flex: 1, minWidth: 120 }} placeholder="update name / profile" value={profile} onChange={(e) => setProfile(e.target.value)} />
          <button className="btn ghost small" disabled={busy || !profile}
            onClick={() => act("Set profile", () => signed.venues.setMetadata(v.id, `demo://${profile}`))}>Save</button>
        </div>
        <div className="btn-row" style={{ flexWrap: "wrap" }}>
          <button className="btn ghost small" type="button" onClick={() => setMapOpen(true)}>◎ Move pin</button>
          <button className="btn ghost small" type="button"
            onClick={async () => { try { setPos(await getPosition()); } catch (e: any) { say(e.message, true); } }}>Use GPS</button>
          {pos && (
            <button className="btn small" disabled={busy}
              onClick={() => act("Move pin", () => signed.venues.setLocation(v.id, pos.lat, pos.lon))}>
              Save {fmtCoord(pos)}
            </button>
          )}
        </div>
        {mapOpen && (
          <PinMap initial={pos ?? { lat: v.lat, lon: v.lon }}
            onConfirm={(m) => { setPos(m); setMapOpen(false); }} onCancel={() => setMapOpen(false)} />
        )}
      </details>
      <MenuEditor {...{ v, act, busy, signed, say }} />
    </div>
  );
}

function MenuEditor({ v, act, busy, signed, say }: any) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [desc, setDesc] = useState("");
  useEffect(() => {
    fetchMenu(v.metadataURI)
      .then((m) => setMenu(m ?? emptyMenu(v.metadataURI?.replace(/^\w+:\/\//, "") ?? "")))
      .catch(() => setMenu(emptyMenu()));
  }, [v.metadataURI]);
  if (!menu) return null;

  const addItem = () => {
    if (!name || !price) return say("Item needs a name and price", true);
    setMenu({ ...menu, items: [...menu.items, { id: newItemId(), name, price, desc: desc || undefined, available: true }] });
    setName(""); setPrice(""); setDesc("");
  };
  const removeItem = (id: string) => setMenu({ ...menu, items: menu.items.filter((i: MenuItem) => i.id !== id) });
  const publish = async () => {
    try {
      const { uri, shared } = await publishMenu(menu);
      await act("Publish menu", () => signed.venues.setMetadata(v.id, uri));
      say(shared ? "Menu published to IPFS ✓" : "Menu saved locally (IPFS not configured — single device only)", !shared);
    } catch (e: any) {
      say(e?.message ?? String(e), true);
    }
  };

  return (
    <details className="payload-details">
      <summary>menu · {menu.items.length} items</summary>
      <label className="field"><span>menu name</span>
        <input value={menu.name} onChange={(e) => setMenu({ ...menu, name: e.target.value })} /></label>
      {menu.items.map((it: MenuItem) => (
        <div className="kv" key={it.id}>
          <span className="k">{it.name} <span className="hint">· {it.price} PAS{it.desc ? ` · ${it.desc}` : ""}</span></span>
          <span className="v"><button className="btn ghost small" type="button" onClick={() => removeItem(it.id)}>remove</button></span>
        </div>
      ))}
      <div className="btn-row" style={{ flexWrap: "wrap" }}>
        <input style={{ flex: 2, minWidth: 110 }} placeholder="item name" value={name} onChange={(e) => setName(e.target.value)} />
        <input style={{ flex: 1, minWidth: 60 }} placeholder="PAS" value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" />
        <button className="btn small" type="button" onClick={addItem}>Add</button>
      </div>
      <input style={{ width: "100%", marginTop: 6 }} placeholder="description (optional)" value={desc} onChange={(e) => setDesc(e.target.value)} />
      <div className="btn-row" style={{ marginTop: 6 }}>
        <button className="btn" disabled={busy} onClick={publish}>Publish menu</button>
      </div>
    </details>
  );
}

function VenueRegister({ act, busy, signed, say }: any) {
  const [name, setName] = useState("");
  const [pos, setPos] = useState<MicroDeg | null>(null);
  const [mapOpen, setMapOpen] = useState(false);
  return (
    <div className="card">
      <h2>Register a venue <span className="tag">public pin</span></h2>
      <label className="field"><span>name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Golden Gate Grill" /></label>
      <label className="field">
        <span>location pin (public — pickups are geo-checked against it)</span>
        <div className="btn-row">
          <button className="btn ghost small" type="button" onClick={() => setMapOpen(true)}>
            ◎ Drop pin on map
          </button>
          <button className="btn ghost small" type="button"
            onClick={async () => { try { setPos(await getPosition()); } catch (e: any) { say(e.message, true); } }}>
            Use my GPS
          </button>
        </div>
        <GeoPill pos={pos} />
      </label>
      {mapOpen && (
        <PinMap
          initial={pos}
          onConfirm={(m) => { setPos(m); setMapOpen(false); }}
          onCancel={() => setMapOpen(false)}
        />
      )}
      <div className="btn-row">
        <button className="btn" disabled={busy || !pos || !name}
          onClick={() =>
            act("Register venue", () =>
              signed.venues.registerVenue(
                pos!.lat, pos!.lon,
                "0x0000000000000000000000000000000000000000",
                "0x0000000000000000000000000000000000000000",
                `demo://${name}`
              )
            )}>
          Register
        </button>
      </div>
    </div>
  );
}

function VenuePickup({ o, venues, session, say }: any) {
  const [payload, setPayload] = useState("");
  return (
    <div className="order">
      <div className="order-head">
        <span className="order-id">Order #{String(o.id)}</span>
        <ExpiryBadge o={o} />
        <span className={`badge ${badgeClass(o.status)}`}>{STATUS[o.status]}</span>
      </div>
      <OrderMeta o={o} venues={venues} />
      <p className="hint">
        Handing the goods to driver {short(o.driver)}? Sign the pickup — your GPS position is
        checked against your registered pin, and the order value releases to your payout address.
      </p>
      <div className="btn-row">
        <button className="btn" disabled={!session}
          onClick={async () => {
            try {
              const pos = await getPosition();
              const att = {
                orderId: o.id.toString(), phase: 1, actor: session.address,
                lat: pos.lat, lon: pos.lon, timestamp: Math.floor(Date.now() / 1000),
              };
              const sig = await signLocation(session, att);
              setPayload(encodePayload("pickup-venue", att, sig));
              say("Pickup signed — give the code to the driver");
            } catch (e: any) { say(e.message, true); }
          }}>
          Sign pickup release
        </button>
      </div>
      {payload && (
        <>
          <p className="hint">Have the driver scan this (or paste the code below):</p>
          <QRShow value={payload} />
          <details className="payload-details">
            <summary>show code text</summary>
            <div className="payload-box">{payload}</div>
          </details>
        </>
      )}
    </div>
  );
}
