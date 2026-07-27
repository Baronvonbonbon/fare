import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { OrderThread, topicOf } from "./channel";
import { publishMenu, fetchMenu, hasMenuURI } from "./menu";
import { Wallet } from "ethers";

// Degradation matrix (TEST-PLAN D3).
//
// The app is designed to run with five optional backends missing — the KV
// channel, a venue relay, IPFS, the push key, and shielded funding — and
// REMAINING-ACTIONS §1 promises that each one merely degrades. Nothing tested
// that, which is the awkward part: a graceful-degradation claim is only worth
// anything if someone has actually removed the thing.
//
// Every case here removes a backend and asserts the DOCUMENTED behaviour, not
// just "it didn't throw". Where the promise is that a feature quietly turns
// itself off, the test also checks the feature reports itself as off, because a
// silent no-op and a silent failure look identical from the outside.

// ── test doubles ────────────────────────────────────────────────────────────

/// Everything unreachable: fetch rejects the way a dead host does.
function allEndpointsDown() {
  (globalThis as any).fetch = vi.fn(async () => {
    throw new TypeError("fetch failed");
  });
}

/// The shape an unbound Cloudflare KV binding actually produces: the Function is
/// deployed and answers, but reports itself unconfigured.
function kvUnbound(then?: (url: string, init?: any) => any) {
  (globalThis as any).fetch = vi.fn(async (url: string, init?: any) => {
    if (String(url).startsWith("/api/")) {
      return { ok: false, status: 503, json: async () => ({ configured: false }) } as any;
    }
    if (then) return then(String(url), init);
    throw new TypeError("fetch failed");
  });
}

function memoryLocalStorage() {
  const m = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
}

const realFetch = globalThis.fetch;
beforeEach(() => memoryLocalStorage());
afterEach(() => {
  (globalThis as any).fetch = realFetch;
  vi.restoreAllMocks();
});

// ── 1. the order channel, with no KV and no relay ───────────────────────────

describe("channel: KV unbound and no venue relay", () => {
  it("sending reports failure instead of throwing, and reading yields an empty thread", async () => {
    // MESSAGING.md P1 is /api/msg (KV); P2 is a venue relay. With neither, chat
    // has nowhere to go — but an order must remain usable without chat.
    kvUnbound();
    const cust = Wallet.createRandom();
    const drv = Wallet.createRandom();
    const t = new OrderThread(7n, cust.privateKey, cust.address, drv.address);

    // open() is the pubkey handshake; with no transport it must resolve, not
    // reject — the order card renders chat beside everything else.
    await expect(t.open()).resolves.toBeUndefined();
    expect(t.ready).toBe(false); // and it knows the peer never arrived
    await expect(t.poll()).resolves.toEqual([]);

    // Sending before a peer is known is a *friendly* wait, not a transport
    // crash — the same message a user sees when the other party simply has
    // not opened the chat yet.
    await expect(t.send("hello")).rejects.toThrow(/waiting for the other party/i);
  });

  it("survives a hard network failure the same way", async () => {
    allEndpointsDown();
    const w = Wallet.createRandom();
    const t = new OrderThread(9n, w.privateKey, w.address, Wallet.createRandom().address);
    await expect(t.open()).resolves.toBeUndefined();
    await expect(t.poll()).resolves.toEqual([]);
    await expect(t.sendLoc(1, 2)).resolves.toBe(false); // tracking simply reports "not shared"
  });

  it("still derives a stable topic with no backend at all", async () => {
    // The topic is a local hash — order identity must not depend on a service.
    allEndpointsDown();
    expect(topicOf(7n)).toEqual(topicOf("7"));
    expect(topicOf(7n)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

// ── 2. IPFS unconfigured ────────────────────────────────────────────────────

describe("menu: IPFS unconfigured", () => {
  it("publishes device-locally and says so, rather than failing", async () => {
    // The documented degradation: a `local://` URI, single-device, and `shared`
    // false so the UI can tell the venue their menu is not replicated.
    kvUnbound();
    const { uri, shared } = await publishMenu({ items: [{ id: "a", name: "Pho", price: "12" }] } as any);

    expect(shared).toBe(false);
    expect(uri.startsWith("local://")).toBe(true);
    expect(hasMenuURI(uri)).toBe(true); // still a valid metadataURI to put on-chain
  });

  it("also falls back when the publish endpoint is unreachable, not merely unbound", async () => {
    // Two distinct failure modes reach the same fallback and they are NOT the
    // same code path: an unbound KV binding answers 503 (the `res.ok` branch),
    // while a dead host rejects (the `catch` branch). A mutation that removed
    // the catch survived a suite that only exercised the first.
    allEndpointsDown();
    const { uri, shared } = await publishMenu({ items: [{ id: "b", name: "Bun", price: "9" }] } as any);
    expect(shared).toBe(false);
    expect(uri.startsWith("local://")).toBe(true);
    expect((await fetchMenu(uri))?.items?.[0]?.name).toBe("Bun");
  });

  it("reads back what it published, so the venue is usable on that device", async () => {
    kvUnbound();
    const menu = { items: [{ id: "a", name: "Pho", price: "12" }] } as any;
    const { uri } = await publishMenu(menu);
    const back = await fetchMenu(uri);
    expect(back?.items?.[0]?.name).toBe("Pho");
  });

  it("falls back to the cached copy when every gateway is unreachable", async () => {
    // An ipfs:// menu that was read once stays readable offline.
    let allow = true;
    (globalThis as any).fetch = vi.fn(async (url: string) => {
      if (String(url).startsWith("/api/")) {
        return { ok: true, json: async () => ({ cid: "bafyTest" }) } as any;
      }
      if (!allow) throw new TypeError("fetch failed");
      return { ok: true, json: async () => ({ items: [{ id: "a", name: "Pho", price: "12" }] }) } as any;
    });

    const { uri, shared } = await publishMenu({ items: [{ id: "a", name: "Pho", price: "12" }] } as any);
    expect(shared).toBe(true);
    expect(uri.startsWith("ipfs://")).toBe(true);

    allow = false; // gateways die
    const offline = await fetchMenu(uri);
    expect(offline?.items?.[0]?.name).toBe("Pho");
  });

  it("returns null for a legacy non-menu URI instead of guessing", async () => {
    allEndpointsDown();
    expect(await fetchMenu("demo://old")).toBeNull();
    expect(await fetchMenu(undefined)).toBeNull();
    expect(hasMenuURI("demo://old")).toBe(false);
  });
});

// ── 3. no venue relay ───────────────────────────────────────────────────────

describe("relay: none configured", () => {
  it("reports itself unavailable so callers take the direct, gas-paying path", async () => {
    vi.resetModules();
    const relay = await import("./relay");
    // No VITE_RELAY_URL in the test env and an empty discovered pool.
    expect(relay.relayConfigured()).toBe(false);
    expect(relay.forwarderAvailable()).toBe(false);
  });

  it("sponsorGas declines cleanly — there is no faucet to fall back to", async () => {
    // Relay-or-nothing, by design. There is no central faucet to fall back to:
    // /api/drip was deleted once this test showed nothing had called it since
    // funding went KS-only (TEST-FINDINGS.md #14). This assertion is what keeps
    // a faucet from quietly reappearing as an unlinkability hole.
    vi.resetModules();
    allEndpointsDown();
    const relay = await import("./relay");
    const r = await relay.sponsorGas("0x" + "11".repeat(20));
    expect(r.funded).toBe(false);
    expect(String(r.reason)).toMatch(/no-faucet/);
  });

  it("burner funding fails loudly, because failing quietly would break unlinkability", async () => {
    // The one case that must NOT degrade silently: a burner funded outside the
    // shielded pool would carry an on-chain edge back to the customer, so the
    // absence of shielded funding has to be an error rather than a fallback.
    vi.resetModules();
    allEndpointsDown();
    const relay = await import("./relay");
    await expect(relay.fundBurner("0x" + "11".repeat(20), 10n)).rejects.toThrow(/shielded funding unavailable/i);
  });
});

// ── 4. push not configured ──────────────────────────────────────────────────

describe("push: no VAPID key", () => {
  it("reports itself off and subscribing is a no-op, not a crash", async () => {
    // Checked before any DOM access, which is also why this is testable without
    // a browser environment: with no key, push never reaches `navigator`.
    vi.resetModules();
    const push = await import("./push");
    expect(push.pushConfigured()).toBe(false);
    await expect(push.subscribePush(["sf"])).resolves.toBe(false);
  });
});
