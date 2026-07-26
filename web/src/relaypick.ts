// Relay selection and request shaping (privacy phase 3b, docs/PRIVACY-TIERS.md §7).
//
// The chain-side work makes a payout unlinkable on-chain. The transport can hand
// that back: a relay that sees BOTH halves of a flow learns the pairing the
// cryptography exists to hide. Two concrete cases in this codebase:
//
//   • shield notes — the insert names the account, the spend names the
//     commitment. One relay seeing both knows whose note it is, even though the
//     proof reveals nothing.
//   • order actions — every request from one order through one relay gives that
//     relay the whole order's activity graph.
//
// So: spread requests across the discovered relay pool, and make the two halves
// of an unlinkable pair go to DIFFERENT relays whenever more than one exists.
//
// This defeats a curious relay OPERATOR, which is the threat model (§1). It does
// not defeat a global passive network observer — that needs mixnet-grade
// transport, and is explicitly out of scope.
import { relayPool } from "./pool";

/// FNV-1a — a stable, cheap, non-cryptographic spread. Selection must not leak
/// anything, but it also must not be predictable-per-user in a way that pins one
/// user to one relay, hence keying on the request's own subject.
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/// A relay for `purpose`+`key`, chosen deterministically so retries land on the
/// same one (a retry that hops relays doubles who sees the request).
export function pickRelay(purpose: string, key: string, pool = relayPool()): string | undefined {
  if (pool.length === 0) return undefined;
  return pool[hash32(`${purpose}:${key}`) % pool.length];
}

/// Like `pickRelay`, but never returns `avoid` when the pool has an alternative.
/// This is what keeps the two halves of a shield-note flow apart.
export function pickRelayAvoiding(
  purpose: string, key: string, avoid: string | undefined, pool = relayPool()
): string | undefined {
  if (pool.length === 0) return undefined;
  if (!avoid || pool.length === 1) return pickRelay(purpose, key, pool);

  const others = pool.filter((r) => r !== avoid);
  if (others.length === 0) return pool[0]; // only `avoid` is available — caller decides
  return others[hash32(`${purpose}:${key}`) % others.length];
}

/// True when the pool is too small to keep an unlinkable pair apart. Callers
/// should surface this rather than pretend: one relay seeing both halves is a
/// real weakening, and the user is entitled to know.
export function relaySplitAvailable(pool = relayPool()): boolean {
  return pool.length >= 2;
}

// ── request shaping ─────────────────────────────────────────────────────────

const PAD_BLOCK = 512;

/// Pad a JSON body up to a multiple of `PAD_BLOCK` so its SIZE carries no
/// information. Without this, a relay (or anyone reading TLS record sizes)
/// distinguishes a note insert from a proof submission without reading either.
///
/// The relay ignores the `_pad` field; it exists only to make bodies uniform.
export function padBody(body: Record<string, unknown>): string {
  // Measure with an EMPTY pad rather than estimating the field's overhead: the
  // separator differs for an empty object, and one wrong character means the
  // sizes still differ by request type, which is the whole thing this prevents.
  const base = JSON.stringify({ ...body, _pad: "" }).length;
  const target = Math.ceil(base / PAD_BLOCK) * PAD_BLOCK;
  // Each fill character adds exactly one byte, so this lands on `target` exactly.
  return JSON.stringify({ ...body, _pad: "0".repeat(target - base) });
}

/// POST a padded JSON body to a relay.
export async function postPadded(url: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: padBody(body),
  });
}
