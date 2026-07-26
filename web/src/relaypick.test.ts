import { describe, it, expect } from "vitest";
import { pickRelay, pickRelayAvoiding, relaySplitAvailable, padBody } from "./relaypick";

// Relay selection + request shaping (privacy phase 3b).
//
// The property that matters: a relay must not see BOTH halves of an unlinkable
// pair. On-chain the halves are unlinkable by construction; the transport is
// where that gets handed back.

const POOL = ["https://a.example", "https://b.example", "https://c.example"];

describe("relay selection", () => {
  it("is stable, so a retry does not widen who saw the request", () => {
    const first = pickRelay("shield-note", "0xabc", POOL);
    for (let i = 0; i < 5; i++) expect(pickRelay("shield-note", "0xabc", POOL)).toBe(first);
  });

  it("spreads different subjects across the pool", () => {
    const seen = new Set(
      Array.from({ length: 60 }, (_, i) => pickRelay("shield-note", `note-${i}`, POOL))
    );
    expect(seen.size).toBeGreaterThan(1);
  });

  it("never sends the spend to the relay that saw the insert", () => {
    // The insert names the account; the spend names the commitment. One relay
    // holding both learns exactly what the proof hides.
    for (let i = 0; i < 50; i++) {
      const key = `commitment-${i}`;
      const insertedVia = pickRelay("shield-note", key, POOL)!;
      const spendVia = pickRelayAvoiding("shield-spend", key, insertedVia, POOL);
      expect(spendVia).not.toBe(insertedVia);
      expect(POOL).toContain(spendVia);
    }
  });

  it("degrades honestly when only one relay is known", () => {
    const solo = ["https://only.example"];
    expect(relaySplitAvailable(solo)).toBe(false);
    // Still returns something usable — the caller surfaces the weakening rather
    // than silently failing to shield.
    expect(pickRelayAvoiding("shield-spend", "k", solo[0], solo)).toBe(solo[0]);
    expect(relaySplitAvailable(POOL)).toBe(true);
  });

  it("returns nothing when no relay is known", () => {
    expect(pickRelay("shield-note", "k", [])).toBeUndefined();
    expect(pickRelayAvoiding("shield-spend", "k", undefined, [])).toBeUndefined();
  });
});

describe("request padding", () => {
  it("makes different request types indistinguishable by size", () => {
    // A note insert and a proof submission differ hugely in natural length; the
    // relay should not be able to tell them apart without reading them.
    const insert = padBody({ account: "0x" + "11".repeat(20), bucket: "1000000000000000000", commitment: "123" });
    const spend = padBody({ proof: "0x" + "ab".repeat(200), root: "456", nullifierHash: "789" });
    expect(insert.length % 512).toBe(0);
    expect(spend.length % 512).toBe(0);
  });

  it("keeps every field intact and adds only padding", () => {
    const body = { a: 1, b: "two", c: ["three"] };
    const parsed = JSON.parse(padBody(body));
    expect(parsed.a).toBe(1);
    expect(parsed.b).toBe("two");
    expect(parsed.c).toEqual(["three"]);
    expect(typeof parsed._pad).toBe("string");
  });

  it("pads a body that already exceeds one block to the next block", () => {
    const big = padBody({ blob: "x".repeat(600) });
    expect(big.length % 512).toBe(0);
    expect(big.length).toBeGreaterThan(600);
  });
});
