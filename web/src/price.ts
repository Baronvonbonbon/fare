// PAS/USDC pricing, from Asset Hub's own asset-conversion DEX via the relay.
//
// The browser cannot open a Substrate WebSocket, so the relay's `/quote` is the
// only path to a rate. It reads `assetConversionApi.quotePriceExactTokensForTokens`
// and serves it from a 5-minute cache.
//
// ⚠ THIS IS NOT AN ORACLE. It is a market rate off a thin testnet pool, with no
// TWAP, no manipulation resistance, and no guarantee anyone will honour it. Two
// rules follow, and both are load-bearing:
//
//   1. It may drive DISPLAY ("about $12.40") and the SIZING of a swap the user
//      initiates. Nothing else.
//   2. No on-chain value may be computed from it. Order values, fares, tips and
//      the service fee are all denominated in USDC directly, so none of them
//      needs a rate — that is precisely why USDC-denominated escrow is worth
//      having. If you find yourself converting a quote into an amount a contract
//      will enforce, stop: you have reintroduced an oracle dependency the design
//      does not have.
//
// A quote that cannot be fetched FAILS CLOSED — callers get null and must hide
// the USD figure rather than show a stale or invented one.
import { activeRelayUrl } from "./relay";

export interface Quote {
  token: string;
  assetId: number;
  decimals: number;
  /// Native (PAS, 18dp as the EVM sees it) per ONE whole token, exact fraction.
  nativePerToken: { num: bigint; den: bigint };
  quotedAt: number;
  ttlMs: number;
  source: string;
}

const cache = new Map<string, Quote>();

const fresh = (q: Quote): boolean => Date.now() - q.quotedAt < q.ttlMs;

/// Age of the cached quote in ms, or null if there is none. Show this next to a
/// converted figure — a rate the user cannot date is a rate they cannot judge.
export function quoteAgeMs(token: string): number | null {
  const q = cache.get(token.toLowerCase());
  return q ? Date.now() - q.quotedAt : null;
}

/// Fetch (or reuse) the rate for `token`. Returns null when no relay is
/// reachable, the pool has no liquidity, or Asset Hub is down.
export async function fetchQuote(token: string, decimals = 6): Promise<Quote | null> {
  const key = token.toLowerCase();
  const hit = cache.get(key);
  if (hit && fresh(hit)) return hit;

  const relay = activeRelayUrl();
  if (!relay) return null;
  try {
    const res = await fetch(`${relay}/quote?token=${token}&decimals=${decimals}`);
    if (!res.ok) return null;
    const j = await res.json();
    if (!j?.nativePerToken?.num || !j?.nativePerToken?.den) return null;
    const q: Quote = {
      token: j.token, assetId: j.assetId, decimals: j.decimals,
      nativePerToken: { num: BigInt(j.nativePerToken.num), den: BigInt(j.nativePerToken.den) },
      quotedAt: j.quotedAt ?? Date.now(), ttlMs: j.ttlMs ?? 300_000, source: j.source ?? "unknown",
    };
    cache.set(key, q);
    return q;
  } catch {
    return null; // fail closed
  }
}

/// Smallest-units of `token` → native wei, at `q`. Integer math throughout: a
/// float here would round money.
export function tokenToNative(amount: bigint, q: Quote): bigint {
  const oneToken = 10n ** BigInt(q.decimals);
  return (amount * q.nativePerToken.num * 10n ** 18n) / (q.nativePerToken.den * oneToken);
}

/// Native wei → smallest-units of `token`, at `q`. Rounds UP, because every
/// caller is asking "how much do I need?" and being a unit short is a failed
/// order while being a unit over is dust.
export function nativeToToken(wei: bigint, q: Quote): bigint {
  const oneToken = 10n ** BigInt(q.decimals);
  const num = wei * q.nativePerToken.den * oneToken;
  const den = q.nativePerToken.num * 10n ** 18n;
  return den === 0n ? 0n : (num + den - 1n) / den;
}

/// Display helper: "12.40" from smallest-units, or null if there is no rate.
/// Deliberately returns null rather than a placeholder — a missing price should
/// be visibly missing.
export function formatNativeAsToken(wei: bigint, q: Quote | null, dp = 2): string | null {
  if (!q) return null;
  const units = nativeToToken(wei, q);
  const one = 10n ** BigInt(q.decimals);
  const whole = units / one;
  const frac = ((units % one) * 10n ** BigInt(dp)) / one;
  return `${whole}.${frac.toString().padStart(dp, "0")}`;
}

/// Test seam and cache reset (a new relay means a new rate source).
export const _resetQuoteCache = () => cache.clear();
