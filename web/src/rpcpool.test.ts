import { describe, it, expect } from "vitest";
import { readEndpoints, broadcastTargets, firstSuccess } from "./rpcpool";

// RPC fallback-pool logic (F4, provider half). Proves the trust-model rules:
// venue RPCs augment reads ONLY in hosted mode and only as lower-priority
// fallbacks behind the hosted anchor; broadcasts target several endpoints; and
// the broadcast fall-over resolves on the first success.
describe("rpc fallback pool (F4)", () => {
  const HOSTED = "https://eth-rpc-testnet.polkadot.io/";
  const V1 = "https://venueA.example/rpc";
  const V2 = "https://venueB.example/rpc";

  describe("readEndpoints", () => {
    it("hosted mode: hosted anchor first (prio 1), venue RPCs as prio-2 fallbacks", () => {
      const eps = readEndpoints("hosted", HOSTED, [V1, V2]);
      expect(eps).toEqual([
        { url: HOSTED, priority: 1 },
        { url: V1, priority: 2 },
        { url: V2, priority: 2 },
      ]);
    });

    it("light-client modes keep venue RPCs OUT of reads (trustless primary)", () => {
      expect(readEndpoints("pine-embedded", HOSTED, [V1, V2])).toEqual([{ url: HOSTED, priority: 1 }]);
      expect(readEndpoints("pine-daemon", "http://127.0.0.1:8545", [V1])).toEqual([
        { url: "http://127.0.0.1:8545", priority: 1 },
      ]);
    });

    it("dedupes a venue RPC that equals the hosted anchor", () => {
      expect(readEndpoints("hosted", HOSTED, [HOSTED, V1])).toEqual([
        { url: HOSTED, priority: 1 },
        { url: V1, priority: 2 },
      ]);
    });

    it("no venue RPCs: just the hosted anchor (single provider, no fallback)", () => {
      expect(readEndpoints("hosted", HOSTED, [])).toEqual([{ url: HOSTED, priority: 1 }]);
    });
  });

  describe("broadcastTargets", () => {
    it("hosted first, all distinct venue RPCs, deduped", () => {
      expect(broadcastTargets(HOSTED, [V1, V1, V2, HOSTED])).toEqual([HOSTED, V1, V2]);
    });
    it("hosted is always included even with no venue RPCs", () => {
      expect(broadcastTargets(HOSTED, [])).toEqual([HOSTED]);
    });
  });

  describe("firstSuccess", () => {
    it("resolves with the first fulfilled even if others reject", async () => {
      const r = await firstSuccess([
        Promise.reject(new Error("hosted down")),
        Promise.resolve("venue-ok"),
      ]);
      expect(r).toBe("venue-ok");
    });

    it("rejects only when every submission rejects", async () => {
      await expect(
        firstSuccess([Promise.reject(new Error("a")), Promise.reject(new Error("b"))])
      ).rejects.toThrow();
    });

    it("throws on an empty submitter set", async () => {
      await expect(firstSuccess([])).rejects.toThrow("no submitters");
    });
  });
});
