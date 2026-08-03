// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tokenToNative, nativeToToken, formatNativeAsToken, fetchQuote, quoteAgeMs, _resetQuoteCache, type Quote } from "./price";

// Live rate on Paseo at the time of writing: 1 USDC ≈ 0.25 PAS. As a fraction,
// native-per-whole-token = num/den with den = 10^chainDecimals (10 on substrate).
const QUOTE: Quote = {
  token: "0x0000053900000000000000000000000001200000",
  assetId: 1337,
  decimals: 6,
  nativePerToken: { num: 2_500_000_000n, den: 10_000_000_000n }, // 0.25
  quotedAt: Date.now(),
  ttlMs: 300_000,
  source: "test",
};

const USDC = (n: number) => BigInt(Math.round(n * 1e6));
const PAS = (n: number) => BigInt(Math.round(n * 1e6)) * 10n ** 12n; // 18dp, via 6dp to dodge float

describe("DEX price conversion", () => {
  beforeEach(() => _resetQuoteCache());
  afterEach(() => vi.unstubAllGlobals());

  it("converts token units to native wei", () => {
    expect(tokenToNative(USDC(1), QUOTE)).toBe(PAS(0.25));
    expect(tokenToNative(USDC(100), QUOTE)).toBe(PAS(25));
    expect(tokenToNative(0n, QUOTE)).toBe(0n);
  });

  it("converts native wei back to token units", () => {
    expect(nativeToToken(PAS(0.25), QUOTE)).toBe(USDC(1));
    expect(nativeToToken(PAS(25), QUOTE)).toBe(USDC(100));
  });

  it("rounds UP when asking how much token a native amount needs", () => {
    // Being one unit short is a failed order; being one unit over is dust.
    const justUnder = PAS(0.25) - 1n;
    expect(nativeToToken(justUnder, QUOTE)).toBe(USDC(1));
  });

  it("never loses money to floating point on awkward amounts", () => {
    // 1/3 of a PAS has no exact decimal form. Integer math must still round-trip
    // within one smallest unit rather than drifting.
    const odd = PAS(1) / 3n;
    const back = tokenToNative(nativeToToken(odd, QUOTE), QUOTE);
    expect(back).toBeGreaterThanOrEqual(odd);
    expect(back - odd).toBeLessThan(tokenToNative(1n, QUOTE) + 1n);
  });

  it("formats a native amount as a token figure", () => {
    expect(formatNativeAsToken(PAS(25), QUOTE)).toBe("100.00");
    expect(formatNativeAsToken(PAS(0.25), QUOTE)).toBe("1.00");
  });

  it("shows nothing rather than something wrong when there is no quote", () => {
    // A missing price must be VISIBLY missing. A placeholder like "$0.00" or a
    // stale figure is worse than a blank, because the user acts on it.
    expect(formatNativeAsToken(PAS(25), null)).toBe(null);
  });

  // The relay pool is a JSON array under this key (pool.ts RELAY_KEY). Setting
  // anything else leaves activeRelayUrl() undefined and every case below would
  // pass through the no-relay branch instead of the one it names.
  const withRelay = () =>
    localStorage.setItem("fare.pool.relays", JSON.stringify(["https://relay.example"]));

  it("fails closed when no relay is configured", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    localStorage.clear();
    expect(await fetchQuote(QUOTE.token)).toBe(null);
    expect(f, "must not even try to fetch without a relay").not.toHaveBeenCalled();
    expect(quoteAgeMs(QUOTE.token)).toBe(null);
  });

  it("fails closed when the relay answers with an error", async () => {
    withRelay();
    const f = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    vi.stubGlobal("fetch", f);
    expect(await fetchQuote(QUOTE.token)).toBe(null);
    expect(f).toHaveBeenCalled();
  });

  it("fails closed when the relay answers with a malformed quote", async () => {
    withRelay();
    const f = vi.fn(async () => ({ ok: true, json: async () => ({ token: QUOTE.token }) }));
    vi.stubGlobal("fetch", f);
    expect(await fetchQuote(QUOTE.token)).toBe(null);
    expect(f).toHaveBeenCalled();
  });

  it("fails closed when the fetch itself throws", async () => {
    withRelay();
    const f = vi.fn(async () => { throw new Error("network down"); });
    vi.stubGlobal("fetch", f);
    expect(await fetchQuote(QUOTE.token)).toBe(null);
    expect(f).toHaveBeenCalled();
  });

  it("parses a well-formed quote and caches it", async () => {
    withRelay();
    const body = {
      token: QUOTE.token, assetId: 1337, decimals: 6,
      nativePerToken: { num: "2500000000", den: "10000000000" },
      quotedAt: Date.now(), ttlMs: 300_000, source: "assetConversion",
    };
    const f = vi.fn(async () => ({ ok: true, json: async () => body }));
    vi.stubGlobal("fetch", f);

    const q = await fetchQuote(QUOTE.token);
    expect(q?.nativePerToken).toEqual({ num: 2_500_000_000n, den: 10_000_000_000n });
    expect(tokenToNative(USDC(1), q!)).toBe(PAS(0.25));

    // Second call is served from cache — a quote is a WebSocket round trip on
    // the relay side, so it must not happen per render.
    await fetchQuote(QUOTE.token);
    expect(f).toHaveBeenCalledTimes(1);
    expect(quoteAgeMs(QUOTE.token)).toBeGreaterThanOrEqual(0);
  });
});
