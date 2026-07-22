import { describe, it, expect, beforeEach } from "vitest";

// pool.ts persists to localStorage (a browser API); vitest runs in node, so
// stand up a minimal Map-backed shim before importing the module under test.
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
(globalThis as any).localStorage = new MemStorage();

const { learnFromManifest, gatewayPool, rpcPool, relayPool, clearPool } = await import("./pool");

// F4 fallback pool: the client learns venue/region service endpoints from menu
// and region manifests, building a gateway/RPC pool for free. Proves: discovery,
// gateway normalization, dedup + cap, and rejection of unsafe endpoints.
describe("manifest-driven endpoint pool (F4)", () => {
  beforeEach(() => clearPool());

  it("learns gateway + rpc + relay from a manifest's services", () => {
    const grew = learnFromManifest({
      services: {
        ipfsGateway: "https://venue.example/ipfs/",
        rpcUrl: "https://venue.example/rpc",
        relayUrl: "https://venue.example/relay/",
      },
    });
    expect(grew).toBe(true);
    expect(gatewayPool()).toEqual(["https://venue.example/ipfs/"]);
    expect(rpcPool()).toEqual(["https://venue.example/rpc"]);
    // relay is trailing-slash trimmed (the client appends /forward, /fund, …)
    expect(relayPool()).toEqual(["https://venue.example/relay"]);
  });

  it("rejects a non-https relay endpoint", () => {
    expect(learnFromManifest({ services: { relayUrl: "http://insecure.example/relay" } })).toBe(false);
    expect(relayPool()).toEqual([]);
  });

  it("normalizes a gateway to a trailing slash (gateways resolve `${gw}${cid}`)", () => {
    learnFromManifest({ services: { ipfsGateway: "https://gw.example/ipfs" } });
    expect(gatewayPool()).toEqual(["https://gw.example/ipfs/"]);
  });

  it("dedupes across manifests and reports no growth on a repeat", () => {
    expect(learnFromManifest({ services: { ipfsGateway: "https://a.example/ipfs/" } })).toBe(true);
    expect(learnFromManifest({ services: { ipfsGateway: "https://a.example/ipfs/" } })).toBe(false);
    expect(gatewayPool()).toEqual(["https://a.example/ipfs/"]);
  });

  it("rejects non-https and non-URL endpoints (mixed content / injection)", () => {
    expect(learnFromManifest({ services: { ipfsGateway: "http://insecure.example/ipfs/" } })).toBe(false);
    expect(learnFromManifest({ services: { rpcUrl: "javascript:alert(1)" } as any })).toBe(false);
    expect(learnFromManifest({ services: { rpcUrl: "not a url" } })).toBe(false);
    expect(gatewayPool()).toEqual([]);
    expect(rpcPool()).toEqual([]);
  });

  it("ignores manifests with no services block", () => {
    expect(learnFromManifest({})).toBe(false);
    expect(learnFromManifest(null)).toBe(false);
    expect(learnFromManifest(undefined)).toBe(false);
  });

  it("caps the pool so a hostile manifest can't grow it unbounded", () => {
    for (let i = 0; i < 30; i++) {
      learnFromManifest({ services: { ipfsGateway: `https://gw${i}.example/ipfs/` } });
    }
    expect(gatewayPool().length).toBe(20); // MAX
  });
});
