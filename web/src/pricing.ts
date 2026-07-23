// Fiat-denominated pricing (integration-plan C2).
//
// Everything on-chain is priced in native PAS. This layer converts to a display
// fiat (USD) using a PAS/USD rate and — the load-bearing part — captures the
// rate at order time into the local receipt, so a receipt shows the fiat value
// locked at checkout even if the rate later moves. That capture-at-checkout is
// the off-chain stand-in for the mainnet design (an on-chain oracle rate bound
// at bid acceptance); on mainnet this module points at a real oracle proxy.
//
// Rate sourcing, in order:
//   1. VITE_PRICE_URL — a JSON endpoint returning { usd: <number> } (a region
//      price feed or a hosted proxy over a real oracle)
//   2. VITE_PAS_USD   — a static build-time rate (demo default)
//   3. DEFAULT_RATE   — a sane fallback so the UI always renders
// Testnet PAS has no market price, so a configured/fixed rate is honest here.

import { useEffect, useState } from "react";
import { formatEther } from "ethers";

const ENV_URL = ((import.meta as any).env?.VITE_PRICE_URL as string | undefined)?.replace(/\/$/, "");
const ENV_STATIC = Number((import.meta as any).env?.VITE_PAS_USD);
const DEFAULT_RATE = 4.0; // USD per PAS — demo default (Paseo PAS has no market)
const CACHE_KEY = "fare.pasusd";
const TTL_MS = 10 * 60 * 1000; // 10 min — a display rate, not a settlement price

export type RateSource = "live" | "static" | "cached" | "default";

interface Cached {
  rate: number;
  at: number;
  source: RateSource;
}

function readCache(): Cached | null {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || "null") as Cached | null;
    return c && Number.isFinite(c.rate) && c.rate > 0 ? c : null;
  } catch {
    return null;
  }
}

/// Last-known rate, synchronously — for capturing at checkout without awaiting a
/// fetch. Prefers a fresh-enough cache, then the static env rate, then default.
export function cachedRate(): number {
  const c = readCache();
  if (c) return c.rate;
  if (Number.isFinite(ENV_STATIC) && ENV_STATIC > 0) return ENV_STATIC;
  return DEFAULT_RATE;
}

/// Resolve the current PAS/USD rate: live endpoint → static env → cache → default.
/// Caches a live/static answer so `cachedRate()` and later loads stay warm.
export async function fetchRate(): Promise<Cached> {
  if (ENV_URL) {
    try {
      const res = await fetch(ENV_URL, { signal: AbortSignal.timeout(6000) });
      const j = (await res.json()) as { usd?: number };
      if (res.ok && Number.isFinite(j.usd) && (j.usd as number) > 0) {
        const c: Cached = { rate: j.usd as number, at: Date.now(), source: "live" };
        localStorage.setItem(CACHE_KEY, JSON.stringify(c));
        return c;
      }
    } catch {
      /* fall through to static/cache */
    }
  }
  if (Number.isFinite(ENV_STATIC) && ENV_STATIC > 0) {
    const c: Cached = { rate: ENV_STATIC, at: Date.now(), source: "static" };
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
    return c;
  }
  const cached = readCache();
  if (cached) return { ...cached, source: "cached" };
  return { rate: DEFAULT_RATE, at: Date.now(), source: "default" };
}

// ── conversions + formatting ─────────────────────────────────────────────────

const usdFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/// PAS (wei) → USD number at `rate` (USD per PAS).
export function pasToUsd(wei: bigint, rate: number): number {
  return Number(formatEther(wei)) * rate;
}

/// USD → PAS decimal string at `rate`, for a fiat-first price entry.
export function usdToPas(usd: number, rate: number): string {
  if (!Number.isFinite(usd) || !Number.isFinite(rate) || rate <= 0) return "0";
  return (usd / rate).toFixed(6).replace(/\.?0+$/, "") || "0";
}

export function formatUsd(n: number): string {
  return Number.isFinite(n) ? usdFmt.format(n) : "—";
}

/// A PAS (wei) amount as a fiat label at `rate` (e.g. "$2.00"). Empty when rate
/// is unusable, so callers can render "PAS-only" gracefully.
export function fiatOf(wei: bigint, rate: number): string {
  if (!Number.isFinite(rate) || rate <= 0) return "";
  return formatUsd(pasToUsd(wei, rate));
}

// ── React hook ───────────────────────────────────────────────────────────────

/// Live PAS/USD rate for display. Seeds from cache synchronously so prices never
/// flash empty, then refreshes in the background (and on a `TTL_MS` interval).
export function usePasUsd(): { rate: number; source: RateSource } {
  const [state, setState] = useState<{ rate: number; source: RateSource }>(() => {
    const c = readCache();
    if (c) return { rate: c.rate, source: "cached" };
    return { rate: cachedRate(), source: Number.isFinite(ENV_STATIC) && ENV_STATIC > 0 ? "static" : "default" };
  });

  useEffect(() => {
    let live = true;
    const tick = () => fetchRate().then((c) => live && setState({ rate: c.rate, source: c.source }));
    // Only hit the network if the cache is stale (or there's a live endpoint).
    const c = readCache();
    if (ENV_URL || !c || Date.now() - c.at > TTL_MS) tick();
    const id = window.setInterval(tick, TTL_MS);
    return () => { live = false; window.clearInterval(id); };
  }, []);

  return state;
}
