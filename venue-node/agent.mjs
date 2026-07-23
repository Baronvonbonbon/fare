#!/usr/bin/env node
// FARE replication agent — chain-indexed region pinning + manifest publish (F3).
//
// The data-layer half of the venue appliance (see docs/NETWORK-ARCHITECTURE.md
// §2). The chain is already the replication index: `VenueRegistered(id, operator,
// lat, lon, metadataURI)` gives every venue's coordinates *and* menu CID, and
// `GeoLib.regionOf` groups them into ~0.5° cells. So this agent:
//
//   1. Reads VenueRegistered (backfill + live) → the full venue set.
//   2. Watches VenueMetadataUpdated (F1) → re-pins on menu change, event-driven.
//   3. Pins its home region(s) generously + a small global sample to local Kubo.
//      Menus are <64 KB JSON, so a node pins thousands of menus in <100 MB.
//   4. Publishes a region manifest (served CIDs + this node's gateway/RPC) and
//      pins it, so F4 clients can build a gateway/RPC fallback pool.
//
// Availability never depends on one node being up: pinned CIDs resolve via the
// DHT through any public gateway even when the origin venue is offline.
//
// Trust: read-only against the chain; holds no keys, moves no funds. Talks only
// to a local Kubo RPC (never raw-expose Kubo — front it with the reverse proxy).
//
// Run:  node --env-file=.env agent.mjs   (Node 22+)

import http from "node:http";
import { readFileSync } from "node:fs";
import { Contract, AbiCoder, keccak256 } from "ethers";
import { buildReadPool } from "./rpc.mjs";

// AGENT_RPC_URL may be a comma-separated failover list; PINE_RPC (a local
// light client) is prepended automatically. See rpc.mjs / docs F4.
const RPC = process.env.AGENT_RPC_URL || process.env.RELAY_RPC_URL || "https://eth-rpc-testnet.polkadot.io/";
const KUBO = (process.env.KUBO_API_URL || "http://127.0.0.1:5001").replace(/\/$/, "");
const ADDRESS_BOOK = process.env.ADDRESS_BOOK || "../deployed-addresses.json";
const PORT = Number(process.env.AGENT_PORT || 8789);
const REGION_RADIUS_KM = Number(process.env.REGION_RADIUS_KM || 60); // pin home region ± this
const GLOBAL_SAMPLE = Number(process.env.GLOBAL_SAMPLE || 50); // extra global venues to pin
const START_BLOCK = Number(process.env.START_BLOCK || 0);
const POLL_MS = Number(process.env.POLL_MS || 15_000);
const LOG_RANGE = Number(process.env.LOG_RANGE || 5_000); // getLogs page size
// This node's public service endpoints, echoed into the manifest for F4/F8.
const PUBLIC_GATEWAY = process.env.PUBLIC_GATEWAY || ""; // e.g. https://venue.example/ipfs/
const PUBLIC_RPC = process.env.PUBLIC_RPC || ""; // e.g. https://venue.example/rpc
const PUBLIC_RELAY = process.env.PUBLIC_RELAY || ""; // e.g. https://venue.example/relay (gasless relay)

// Home centers (microdegrees). A single self-hosted venue sets HOME_LAT/HOME_LON;
// a HOSTED SUPER-NODE (F7) serving many venues sets HOME_COORDS to a
// semicolon-separated list "lat1,lon1;lat2,lon2;…" — the agent pins the union of
// all their regions from one box. HOME_COORDS wins when both are set.
export function parseCenters(env) {
  const list = (env.HOME_COORDS || "").trim();
  if (list) {
    return list
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((pair) => {
        const [lat, lon] = pair.split(",").map((x) => Number(x.trim()));
        return { lat, lon };
      })
      .filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lon));
  }
  const lat = Number(env.HOME_LAT ?? "NaN");
  const lon = Number(env.HOME_LON ?? "NaN");
  return Number.isFinite(lat) && Number.isFinite(lon) ? [{ lat, lon }] : [];
}

const CENTERS = parseCenters(process.env);

const venuesAddr = (() => {
  const book = JSON.parse(readFileSync(new URL(ADDRESS_BOOK, import.meta.url), "utf8"));
  return process.env.VENUES_ADDRESS || book.venues || book.addresses?.venues;
})();

const VENUES_ABI = [
  "event VenueRegistered(uint64 indexed venueId, address indexed operator, int32 lat, int32 lon, string metadataURI)",
  "event VenueMetadataUpdated(uint64 indexed venueId, string metadataURI)",
  "function venues(uint64) view returns (address operator, address signer, address payout, int32 lat, int32 lon, bool active, uint32 pickups, string metadataURI)",
];

const provider = buildReadPool(RPC, "agent");
const venues = new Contract(venuesAddr, VENUES_ABI, provider);

// ── region math — MUST match GeoLib.regionOf / web/src/chain.ts exactly ───────
const REGION_CELL = 500_000; // microdegrees (~0.5°), == GeoLib.REGION_CELL
const coder = AbiCoder.defaultAbiCoder();
export const cellRegion = (latCell, lonCell) => keccak256(coder.encode(["int256", "int256"], [latCell, lonCell]));
export const regionOf = (lat, lon) => cellRegion(Math.trunc(lat / REGION_CELL), Math.trunc(lon / REGION_CELL));

// Region set: every cell overlapping REGION_RADIUS_KM around EACH center, padded
// a cell each way so truncation at edges can't miss one (mirrors regionsCovering).
// The union over centers is what makes one hosted super-node serve many venues.
export function regionSetFor(centers, radiusKm) {
  const r = radiusKm * 1000;
  const dLat = (r / 111_320) * 1e6;
  const set = new Set();
  for (const c of centers) {
    if (!Number.isFinite(c.lat) || !Number.isFinite(c.lon)) continue;
    const cosLat = Math.max(Math.cos(((c.lat / 1e6) * Math.PI) / 180), 1e-6);
    const dLon = (r / (111_320 * cosLat)) * 1e6;
    const latMin = Math.trunc((c.lat - dLat) / REGION_CELL) - 1;
    const latMax = Math.trunc((c.lat + dLat) / REGION_CELL) + 1;
    const lonMin = Math.trunc((c.lon - dLon) / REGION_CELL) - 1;
    const lonMax = Math.trunc((c.lon + dLon) / REGION_CELL) + 1;
    for (let la = latMin; la <= latMax; la++) for (let lo = lonMin; lo <= lonMax; lo++) set.add(cellRegion(la, lo));
  }
  return set;
}
const HOME_REGIONS = regionSetFor(CENTERS, REGION_RADIUS_KM);

// ── metadataURI → CID ─────────────────────────────────────────────────────────
// Accepts ipfs://<cid>[/path], /ipfs/<cid>, or a gateway URL; skips local://.
function cidOf(metadataURI) {
  if (!metadataURI || metadataURI.startsWith("local://")) return null;
  const m = metadataURI.match(/(?:ipfs:\/\/|\/ipfs\/)([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

// ── Kubo RPC ──────────────────────────────────────────────────────────────────
async function kubo(path, { body, timeoutMs = 30_000 } = {}) {
  const ctl = AbortSignal.timeout(timeoutMs);
  const res = await fetch(`${KUBO}/api/v0/${path}`, { method: "POST", body, signal: ctl });
  if (!res.ok) throw new Error(`kubo ${path} → ${res.status} ${await res.text().catch(() => "")}`);
  return res.json();
}
const pinAdd = (cid) => kubo(`pin/add?arg=${encodeURIComponent(cid)}&recursive=true`);
async function addJson(name, obj) {
  const form = new FormData();
  form.append("file", new Blob([JSON.stringify(obj)], { type: "application/json" }), name);
  const out = await kubo("add?cid-version=1&pin=true", { body: form });
  return out.Hash;
}

// ── state ─────────────────────────────────────────────────────────────────────
const known = new Map(); // venueId(string) → { lat, lon, region, cid }
const pinned = new Set(); // CIDs successfully pinned
let globalPins = 0;
let lastBlock = START_BLOCK ? START_BLOCK - 1 : -1;
let manifestCid = null;
let stats = { registered: 0, updates: 0, pinFails: 0 };

// Decide whether this node should serve a venue, and pin it if so.
async function consider(venueId, lat, lon, metadataURI) {
  const region = regionOf(lat, lon);
  const inRegion = HOME_REGIONS.has(region);
  const cid = cidOf(metadataURI);
  const prev = known.get(venueId);
  known.set(venueId, { lat, lon, region, cid });

  if (!cid) return; // device-local menu, nothing to pin
  if (prev?.cid === cid && pinned.has(cid)) return; // unchanged + already served

  const takeGlobal = !inRegion && globalPins < GLOBAL_SAMPLE && !pinned.has(cid);
  if (!inRegion && !takeGlobal) return;

  try {
    await pinAdd(cid);
    pinned.add(cid);
    if (takeGlobal) globalPins += 1;
    console.log(`[agent] pinned venue #${venueId} ${cid} (${inRegion ? "home-region" : "global-sample"})`);
    await publishManifest();
  } catch (e) {
    stats.pinFails += 1;
    console.warn(`[agent] pin failed venue #${venueId} ${cid}: ${e?.message ?? e}`);
  }
}

// Build + pin the region manifest F4 clients discover (served CIDs + endpoints).
let manifestDirty = false, manifesting = false;
async function publishManifest() {
  manifestDirty = true;
  if (manifesting) return;
  manifesting = true;
  try {
    while (manifestDirty) {
      manifestDirty = false;
      const manifest = {
        kind: "fare-region-manifest",
        version: 1,
        venuesContract: venuesAddr,
        homes: CENTERS, // one center (self-host) or many (hosted super-node, F7)
        regions: [...HOME_REGIONS],
        services: {
          ...(PUBLIC_GATEWAY ? { ipfsGateway: PUBLIC_GATEWAY } : {}),
          ...(PUBLIC_RPC ? { rpcUrl: PUBLIC_RPC } : {}),
          ...(PUBLIC_RELAY ? { relayUrl: PUBLIC_RELAY } : {}),
        },
        servedCids: [...pinned],
        updatedAt: new Date().toISOString(),
      };
      manifestCid = await addJson("fare-region-manifest.json", manifest);
      console.log(`[agent] manifest published: ${manifestCid} (${pinned.size} CIDs)`);
    }
  } catch (e) {
    console.warn(`[agent] manifest publish failed: ${e?.message ?? e}`);
  } finally {
    manifesting = false;
  }
}

// ── chain scan: backfill in pages, then poll for new logs ─────────────────────
async function scanTo(head) {
  for (let from = lastBlock + 1; from <= head; from += LOG_RANGE) {
    const to = Math.min(from + LOG_RANGE - 1, head);
    const [regs, ups] = await Promise.all([
      venues.queryFilter(venues.filters.VenueRegistered(), from, to),
      venues.queryFilter(venues.filters.VenueMetadataUpdated(), from, to),
    ]);
    // Order by (block, logIndex) so a later update wins over its registration.
    const evs = [...regs, ...ups].sort((a, b) =>
      a.blockNumber - b.blockNumber || a.index - b.index);
    for (const ev of evs) {
      const id = ev.args.venueId.toString();
      if (ev.eventName === "VenueRegistered") {
        stats.registered += 1;
        await consider(id, Number(ev.args.lat), Number(ev.args.lon), ev.args.metadataURI);
      } else {
        stats.updates += 1;
        const v = known.get(id) ?? (await (async () => {
          const r = await venues.venues(id); // coords aren't in the update event
          return { lat: Number(r.lat), lon: Number(r.lon) };
        })());
        await consider(id, v.lat, v.lon, ev.args.metadataURI);
      }
    }
    lastBlock = to;
  }
}

async function loop() {
  try {
    const head = await provider.getBlockNumber();
    if (head > lastBlock) await scanTo(head);
  } catch (e) {
    console.warn(`[agent] scan error: ${e?.message ?? e}`);
  } finally {
    setTimeout(loop, POLL_MS);
  }
}

// ── local status API (front with the reverse proxy; never expose Kubo raw) ────
function startServer() {
  http
    .createServer((req, res) => {
      const body = JSON.stringify({
        ok: true,
        venuesContract: venuesAddr,
        homes: CENTERS,
        homeRegions: HOME_REGIONS.size,
        lastBlock,
        knownVenues: known.size,
        pinnedCids: pinned.size,
        globalPins,
        manifestCid,
        stats,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
    })
    .listen(PORT, () => {
      console.log(`[agent] FARE replication agent on :${PORT}`);
      console.log(`[agent] venues:  ${venuesAddr}`);
      console.log(`[agent] kubo:    ${KUBO}`);
      console.log(`[agent] homes:   ${CENTERS.length} center(s)  regions=${HOME_REGIONS.size}  radius=${REGION_RADIUS_KM}km`);
      loop();
    });
}

// Boot only when run directly (not when imported by a test). Config validation
// lives here so importing for tests never exits the process.
if (import.meta.filename === process.argv[1]) {
  if (CENTERS.length === 0) {
    console.error("[agent] no home center — set HOME_LAT/HOME_LON or HOME_COORDS (microdegrees). Exiting.");
    process.exit(1);
  }
  startServer();
}
