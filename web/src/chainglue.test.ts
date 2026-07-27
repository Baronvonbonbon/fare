import { describe, it, expect, beforeAll } from "vitest";

// chain.ts's pure helpers (TEST-PLAN D2).
//
// chain.ts is 512 lines and most of it is provider plumbing that needs a node.
// These are the parts that do not: the QR hand-off codec, the region cover the
// driver board queries with, the salt, and the amount formatters. All of them
// are on a path where being wrong is quiet rather than loud.
//
// The module builds providers and reads node preferences at import, so
// localStorage has to exist before it loads — hence the dynamic import below
// rather than a top-level one.

let chain: typeof import("./chain");

beforeAll(async () => {
  const m = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
  // btoa/atob are browser globals; node has them, but be explicit since the
  // payload codec depends on them entirely.
  expect(typeof globalThis.btoa).to.equal("function");
  chain = await import("./chain");
});

describe("attestation hand-off payloads", () => {
  const att = { orderId: "7", phase: 1, actor: "0x" + "ab".repeat(20), lat: 37_774_900, lon: -122_419_400 };
  const sig = "0x" + "cd".repeat(65);

  it("round-trips an attestation and its signature", () => {
    const back = chain.decodePayload(chain.encodePayload("pickup", att, sig));
    expect(back.kind).to.equal("pickup");
    expect(back.att).to.deep.equal(att);
    expect(back.sig).to.equal(sig);
  });

  it("carries the driver's plaintext position when one is attached", () => {
    // This is the face-to-face ZK handoff: the driver's coordinates and salt
    // travel inside the QR so the customer can build the proximity proof
    // locally. Losing `pos` in transit means the proof cannot be built at all,
    // and the failure appears at the door.
    const pos = { lat: 37_784_940, lon: -122_419_400, salt: "12345678901234567890" };
    const back = chain.decodePayload(chain.encodePayload("dropoff", att, sig, pos));
    expect(back.pos).to.deep.equal(pos);
    // The salt is a decimal string, not a number: past 2^53 a JSON number would
    // round, and a rounded salt opens no commitment.
    expect(typeof back.pos!.salt).to.equal("string");
  });

  it("survives the whitespace a copy-paste adds", () => {
    // The payload is pasted between parties by hand as often as it is scanned,
    // and a trailing newline is the normal result.
    const encoded = chain.encodePayload("pickup", att, sig);
    expect(chain.decodePayload(`  ${encoded}\n`).kind).to.equal("pickup");
  });

  it("refuses a payload from a future version rather than misreading it", () => {
    // A version bump means the shape changed; decoding it as v1 would produce
    // an attestation with silently missing fields.
    const future = btoa(JSON.stringify({ v: 2, kind: "pickup", att, sig }));
    expect(() => chain.decodePayload(future)).to.throw(/version/i);
  });

  it("throws on rubbish rather than returning a half-object", () => {
    expect(() => chain.decodePayload("not base64 at all!!")).to.throw();
    expect(() => chain.decodePayload(btoa("{not json"))).to.throw();
  });
});

describe("region cover for the driver board", () => {
  const SF = { lat: 37_774_900, lon: -122_419_400 };

  it("always includes the cell the driver is standing in", () => {
    // The one guarantee that matters: however the arithmetic rounds, a driver
    // must see orders at their own location. An off-by-one in the cell maths
    // would empty the board with no error anywhere.
    for (const radius of [1, 5, 25, 60]) {
      const cover = chain.regionsCovering(SF, radius);
      const here = chain.regionsCovering(SF, 0)[Math.floor(chain.regionsCovering(SF, 0).length / 2)];
      expect(cover, `radius ${radius} km lost the driver's own cell`).to.include(here);
    }
  });

  it("grows with the radius and never shrinks", () => {
    const sizes = [1, 10, 50, 100].map((r) => chain.regionsCovering(SF, r).length);
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i], `cover shrank between radii`).to.be.greaterThanOrEqual(sizes[i - 1]);
    }
  });

  it("widens in longitude as latitude approaches the pole", () => {
    // Longitude degrees narrow with the cosine of latitude, so a fixed
    // kilometre radius must span MORE longitude cells further north. Getting
    // this backwards under-covers exactly where the app is used least and is
    // therefore noticed last.
    const equator = chain.regionsCovering({ lat: 0, lon: 0 }, 50).length;
    const north = chain.regionsCovering({ lat: 60_000_000, lon: 0 }, 50).length;
    expect(north).to.be.greaterThan(equator);
  });

  it("stays bounded at the poles instead of covering the planet twice", () => {
    // TEST-FINDINGS #24. cos(90°) is 0, and the clamp that avoids the divide by
    // zero used to leave a longitude span of ~900,000 cells — 3,593,252 in
    // total for a 25 km radius. Not a wide search: a hung tab, and a
    // `Promise.all` of that many `queryFilter` calls behind it. This test hung
    // the suite before the cap went in.
    //
    // The bound is a half-turn of longitude, beyond which the cover has wrapped
    // the globe and is re-listing cells it already holds.
    for (const lat of [89_000_000, 90_000_000, -90_000_000]) {
      const cover = chain.regionsCovering({ lat, lon: 0 }, 25);
      expect(cover.length).to.be.greaterThan(0);
      expect(cover.length, `latitude ${lat} produced ${cover.length} cells`).to.be.lessThan(3_000);
    }
    // And the ordinary case is still small — the cap must not have coarsened it.
    expect(chain.regionsCovering({ lat: 37_774_900, lon: -122_419_400 }, 25).length).to.be.lessThan(30);
  });

  it("returns bytes32 region keys, all distinct", () => {
    const cover = chain.regionsCovering(SF, 10);
    for (const r of cover) expect(r).to.match(/^0x[0-9a-fA-F]{64}$/);
    expect(new Set(cover).size, "the cover repeats a cell").to.equal(cover.length);
  });
});

describe("salt", () => {
  it("is a fresh decimal string every call", () => {
    // The drop salt is the only thing standing between a published commitment
    // and a brute-force over a city's coordinates. A repeat makes two orders'
    // commitments comparable.
    const salts = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const s = chain.randomSalt();
      expect(s).to.match(/^\d+$/);
      salts.add(s);
    }
    expect(salts.size).to.equal(500);
  });

  it("stays inside the field, and is wide enough to matter", () => {
    // 16 bytes: comfortably below the BN254 field modulus, comfortably beyond
    // guessing. A salt that overflowed the field would be reduced by the
    // circuit and would not match the commitment the client computed.
    const BN254 = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    let sawLarge = false;
    for (let i = 0; i < 200; i++) {
      const v = BigInt(chain.randomSalt());
      expect(v).to.be.lessThan(BN254);
      if (v > 2n ** 100n) sawLarge = true;
    }
    expect(sawLarge, "salts look far too small — is randomBytes returning zeros?").to.equal(true);
  });
});

describe("amount display", () => {
  it("truncates to four decimals rather than rounding up", () => {
    // Never show a user more than they hold.
    expect(chain.fmt(10n ** 18n)).to.equal("1");
    expect(chain.fmt(1_999_999_999_999_999_999n)).to.equal("1.9999");
    expect(chain.fmt(0n)).to.equal("0");
  });

  it("parses an empty field as zero", () => {
    expect(chain.parse("")).to.equal(0n);
    expect(chain.parse("1.5")).to.equal(1_500_000_000_000_000_000n);
  });

  it("shortens an address without losing either end", () => {
    const a = "0x" + "ab".repeat(20);
    const s = chain.short(a);
    expect(s.startsWith(a.slice(0, 6))).to.equal(true);
    expect(s.endsWith(a.slice(-4))).to.equal(true);
    expect(chain.short("")).to.equal("—");
  });
});
