#!/usr/bin/env node
// FARE region push service — background notifications (B4 P2).
//
// The venue node is the natural push host: it already watches the chain (F3) and
// is region-local. This service watches order events and sends Web Push (VAPID)
// to subscribed devices BY REGION — it never learns which order is a device's.
// Devices subscribe with only their coarse region(s); the service pushes every
// region-relevant event; the client's service worker filters locally. So the
// push service (and the browser push service) see only "a device in region X" —
// per-order burners stay unlinkable (see docs/NOTIFICATIONS.md).
//
//   POST /subscribe { subscription, regions }   register a device + its regions
//   GET  /vapid                                 the VAPID public key
//   GET  /health
//
// Run:  node --env-file=.env push.mjs   (Node 22+; `npm install` for web-push)

import http from "node:http";
import { readFileSync } from "node:fs";
import { JsonRpcProvider, Contract, AbiCoder, keccak256 } from "ethers";
import webpush from "web-push";

const PORT = Number(process.env.PUSH_PORT || 8791);
const RPC = process.env.PUSH_RPC_URL || process.env.AGENT_RPC_URL || "https://eth-rpc-testnet.polkadot.io/";
const ADDRESS_BOOK = process.env.ADDRESS_BOOK || "../deployed-addresses.json";
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:ops@fare.example";
const START_BLOCK = Number(process.env.PUSH_START_BLOCK || 0);
const POLL_MS = Number(process.env.PUSH_POLL_MS || 15_000);
const LOG_RANGE = Number(process.env.PUSH_LOG_RANGE || 5_000);
const SUB_TTL_MS = Number(process.env.PUSH_SUB_TTL_MS || 30 * 24 * 3_600_000); // 30 days
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim());

const book = JSON.parse(readFileSync(new URL(ADDRESS_BOOK, import.meta.url), "utf8"));
const addr = book.addresses ?? book;
const ordersAddr = process.env.ORDERS_ADDRESS || addr.orders;
const venuesAddr = process.env.VENUES_ADDRESS || addr.venues;

const ORDERS_ABI = [
  "event OrderRegion(bytes32 indexed region, uint256 indexed orderId)",
  "event OrderAssigned(uint256 indexed orderId, address indexed driver, uint96 fare, uint64 pickupDeadline)",
  "event OrderPickedUp(uint256 indexed orderId, uint64 deliveryDeadline)",
  "event OrderDelivered(uint256 indexed orderId, uint96 driverPaid, uint96 protocolFee)",
  "function orders(uint256) view returns (address customer, uint64 venueId, uint8 status, address driver, uint96 orderValue, uint96 tip, uint96 fare, uint96 maxFare, uint96 escrow, bytes32 dropCommit, uint64 createdAt, uint64 pickupWindowSecs, uint64 deliveryWindowSecs, uint64 pickupDeadline, uint64 deliveryDeadline)",
];
const VENUES_ABI = ["function locationOf(uint64) view returns (int32 lat, int32 lon)"];

const provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: true });
const orders = new Contract(ordersAddr, ORDERS_ABI, provider);
const venues = venuesAddr ? new Contract(venuesAddr, VENUES_ABI, provider) : null;

// region math — MUST match GeoLib.regionOf / web (as in agent.mjs)
const REGION_CELL = 500_000;
const coder = AbiCoder.defaultAbiCoder();
const cellRegion = (a, b) => keccak256(coder.encode(["int256", "int256"], [a, b]));
const regionOf = (lat, lon) => cellRegion(Math.trunc(lat / REGION_CELL), Math.trunc(lon / REGION_CELL));

// ── subscriptions ─────────────────────────────────────────────────────────────
const subs = new Map(); // endpoint → { sub, regions:Set<string>, exp }
const orderRegion = new Map(); // orderId → region (from OrderRegion; cache for status events)
let lastBlock = START_BLOCK ? START_BLOCK - 1 : -1;
let stats = { pushed: 0, failed: 0, events: 0 };

function pruneSubs() {
  const now = Date.now();
  for (const [k, v] of subs) if (v.exp < now) subs.delete(k);
}

async function regionForOrder(orderId) {
  const key = String(orderId);
  if (orderRegion.has(key)) return orderRegion.get(key);
  // fallback: derive from the order's venue pin (created before we were watching)
  try {
    const o = await orders.orders(orderId);
    const [lat, lon] = await venues.locationOf(o.venueId);
    const r = regionOf(Number(lat), Number(lon));
    orderRegion.set(key, r);
    return r;
  } catch {
    return null;
  }
}

async function pushRegion(region, payload) {
  pruneSubs();
  const body = JSON.stringify(payload);
  await Promise.all(
    [...subs.values()]
      .filter((s) => s.regions.has(region))
      .map(async (s) => {
        try {
          await webpush.sendNotification(s.sub, body);
          stats.pushed += 1;
        } catch (e) {
          stats.failed += 1;
          if (e?.statusCode === 404 || e?.statusCode === 410) subs.delete(s.sub.endpoint); // gone
        }
      })
  );
}

// ── chain watch ───────────────────────────────────────────────────────────────
async function scanTo(head) {
  for (let from = lastBlock + 1; from <= head; from += LOG_RANGE) {
    const to = Math.min(from + LOG_RANGE - 1, head);
    const [regs, asg, pick, del] = await Promise.all([
      orders.queryFilter(orders.filters.OrderRegion(), from, to),
      orders.queryFilter(orders.filters.OrderAssigned(), from, to),
      orders.queryFilter(orders.filters.OrderPickedUp(), from, to),
      orders.queryFilter(orders.filters.OrderDelivered(), from, to),
    ]);
    const evs = [
      ...regs.map((e) => ({ e, kind: "new" })),
      ...asg.map((e) => ({ e, kind: "assigned" })),
      ...pick.map((e) => ({ e, kind: "pickedup" })),
      ...del.map((e) => ({ e, kind: "delivered" })),
    ].sort((a, b) => a.e.blockNumber - b.e.blockNumber || a.e.index - b.e.index);

    for (const { e, kind } of evs) {
      stats.events += 1;
      const orderId = e.args.orderId.toString();
      let region;
      if (kind === "new") {
        region = e.args.region;
        orderRegion.set(orderId, region);
      } else {
        region = await regionForOrder(orderId);
      }
      if (region) await pushRegion(region, { orderId, kind });
    }
    lastBlock = to;
  }
}

async function loop() {
  try {
    const head = await provider.getBlockNumber();
    if (head > lastBlock) await scanTo(head);
  } catch (e) {
    console.warn(`[push] scan error: ${e?.message ?? e}`);
  } finally {
    setTimeout(loop, POLL_MS);
  }
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
function send(res, status, body, origin) {
  const allow = ALLOWED_ORIGINS.includes("*") ? "*" : (ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": allow ?? "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type", vary: "Origin" });
  res.end(JSON.stringify(body));
}
async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 32 * 1024) throw new Error("body too large"); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
const okRegion = (r) => typeof r === "string" && /^0x[0-9a-fA-F]{64}$/.test(r);

function startServer() {
  http
    .createServer(async (req, res) => {
      const origin = req.headers.origin;
      if (req.method === "OPTIONS") return send(res, 204, {}, origin);
      const url = new URL(req.url, "http://localhost");
      try {
        if (req.method === "GET" && url.pathname === "/vapid") return send(res, 200, { publicKey: VAPID_PUBLIC }, origin);
        if (req.method === "GET" && url.pathname === "/health") { pruneSubs(); return send(res, 200, { ok: true, subs: subs.size, lastBlock, stats }, origin); }
        if (req.method === "POST" && url.pathname === "/subscribe") {
          const { subscription, regions } = await readJson(req);
          if (!subscription?.endpoint || !Array.isArray(regions)) return send(res, 400, { error: "bad subscription" }, origin);
          const clean = regions.filter(okRegion).slice(0, 64);
          subs.set(subscription.endpoint, { sub: subscription, regions: new Set(clean), exp: Date.now() + SUB_TTL_MS });
          return send(res, 200, { ok: true, regions: clean.length }, origin);
        }
        return send(res, 404, { error: "not found" }, origin);
      } catch (e) {
        return send(res, 500, { error: e?.message ?? String(e) }, origin);
      }
    })
    .listen(PORT, () => {
      console.log(`[push] FARE region push service on :${PORT}`);
      console.log(`[push] orders:  ${ordersAddr}`);
      console.log(`[push] vapid:   ${VAPID_PUBLIC ? VAPID_PUBLIC.slice(0, 12) + "…" : "(missing!)"}`);
      loop();
    });
}

setInterval(pruneSubs, 3_600_000).unref?.();

if (import.meta.filename === process.argv[1]) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    console.error("[push] VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY required (npx web-push generate-vapid-keys). Exiting.");
    process.exit(1);
  }
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  startServer();
}

export { regionOf, pushRegion, subs, orderRegion };
