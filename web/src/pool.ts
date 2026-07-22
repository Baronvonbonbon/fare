// Manifest-driven endpoint discovery — the gateway/RPC fallback pool (F4).
//
// The chain carries venue identity + a menu pointer; the manifest behind that
// pointer carries *services* (see docs/NETWORK-ARCHITECTURE.md §2). A venue's
// menu JSON, and the region manifest an appliance publishes (venue-node/agent.mjs,
// F3), can both advertise:
//
//   { "services": { "ipfsGateway": "https://…/ipfs/", "rpcUrl": "https://…/rpc" } }
//
// As the client loads menus it learns these endpoints, building a regional
// fallback pool for free — no extra registry contract. This module owns the
// pool: it accumulates gateways (used now, by menu.ts) and RPCs (surfaced for
// the provider layer).
//
// Trust note (§4/§5): discovered IPFS gateways are safe — content is
// CID-addressed, so a bad gateway can withhold but never forge a menu. Venue
// RPCs are a different matter: a plain RPC is NOT finality-verified, so the pool
// exposes them but the provider layer must keep the in-app light client primary
// and never treat a venue RPC as a sole, trusted read path.

export interface ServiceEndpoints {
  ipfsGateway?: string;
  rpcUrl?: string;
  relayUrl?: string; // a region's gasless relay (venue-node/relay.mjs) — F8 discovery
}

/// Anything that may advertise services: a menu JSON or a region manifest.
export interface WithServices {
  services?: ServiceEndpoints;
}

const GW_KEY = "fare.pool.gateways";
const RPC_KEY = "fare.pool.rpcs";
const RELAY_KEY = "fare.pool.relays";
const MAX = 20; // cap the pool so a hostile manifest can't grow it unbounded

/// Only https endpoints — an http URL would fail as mixed content on the PWA,
/// and js:/data: URLs must never enter a fetch/RPC pool.
function isSafeUrl(u: unknown): u is string {
  if (typeof u !== "string" || u.length > 300) return false;
  try {
    return new URL(u).protocol === "https:";
  } catch {
    return false;
  }
}

/// Gateways resolve `${gw}${cid}`, so normalize to a trailing slash.
function normGateway(u: string): string {
  return u.endsWith("/") ? u : `${u}/`;
}

function load(key: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/// Append new entries (deduped, capped) and persist. Returns true if it grew.
function merge(key: string, incoming: string[]): boolean {
  if (incoming.length === 0) return false;
  const have = load(key);
  const seen = new Set(have);
  let grew = false;
  for (const u of incoming) {
    if (have.length >= MAX) break;
    if (!seen.has(u)) {
      have.push(u);
      seen.add(u);
      grew = true;
    }
  }
  if (grew) localStorage.setItem(key, JSON.stringify(have));
  return grew;
}

/// Learn service endpoints from a menu or region manifest. Silently ignores
/// missing/unsafe fields. Returns true if the pool grew.
export function learnFromManifest(m: WithServices | null | undefined): boolean {
  const s = m?.services;
  if (!s) return false;
  let grew = false;
  if (isSafeUrl(s.ipfsGateway)) grew = merge(GW_KEY, [normGateway(s.ipfsGateway)]) || grew;
  if (isSafeUrl(s.rpcUrl)) grew = merge(RPC_KEY, [s.rpcUrl]) || grew;
  if (isSafeUrl(s.relayUrl)) grew = merge(RELAY_KEY, [s.relayUrl.replace(/\/$/, "")]) || grew;
  return grew;
}

/// Discovered IPFS gateways (trailing-slash normalized), for menu resolution.
export function gatewayPool(): string[] {
  return load(GW_KEY);
}

/// Discovered venue RPCs. Surfaced for the provider layer — the caller MUST keep
/// the light client primary and multiplex these; never a sole trusted read path.
export function rpcPool(): string[] {
  return load(RPC_KEY);
}

/// Discovered region gasless relays (trailing-slash trimmed). Safe to prefer: a
/// relay can only pay gas / forward a user-signed request — the forwarder verifies
/// the signature, so a bad relay can't act as the user or move funds (F8).
export function relayPool(): string[] {
  return load(RELAY_KEY);
}

/// Test/utility: forget every discovered endpoint.
export function clearPool(): void {
  localStorage.removeItem(GW_KEY);
  localStorage.removeItem(RPC_KEY);
  localStorage.removeItem(RELAY_KEY);
}
