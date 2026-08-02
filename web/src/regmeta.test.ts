import { describe, it, expect } from "vitest";
import { Wallet } from "ethers";
import { pubKeyOf } from "./msg";

// Encrypted registration metadata (docs/PRIVACY-TIERS.md §5).

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
(globalThis as any).localStorage = new MemStorage();

const {
  commitProfile, isCommitted, verifyProfile, describeProfile,
  sealProfile, openProfile, saveSelfProfile, loadSelfProfile, profilePayload, verifyPayload,
} = await import("./regmeta");

const DRIVER = { name: "Sam Vega", vehicle: "Honda PCX", plate: "8KLM221", contact: "sig:@samv" };
const CUSTOMER = { name: "Rae", phone: "+1 555 0100", buzzer: "4B", instructions: "side door, ring twice" };
const VENUE = { name: "Golden Gate Grill", contact: "+1 555 0111", pickup: "counter at the back" };

describe("profile commitments", () => {
  // Driver commitments are LIVE in FareDrivers.metadataURI on Paseo. If the
  // canonical form ever changes, every registered driver's profile stops
  // verifying and they must re-register — silently, at handoff. This pins it.
  it("has not changed the driver canonical form", () => {
    expect(commitProfile("driver", DRIVER)).toBe(
      "fare-meta:v1:099c64bb012e030ec3889d3f4973351a1b261fafa5915313fea67886e85caa2b"
    );
  });

  it("publishes a hash, not the details", () => {
    const uri = commitProfile("driver", DRIVER);
    expect(isCommitted(uri)).toBe(true);
    for (const secret of Object.values(DRIVER)) {
      expect(uri.toLowerCase()).not.toContain(secret.toLowerCase().replace(/\s/g, ""));
    }
    expect(uri).not.toContain("Sam");
  });

  it("is stable across key order and cosmetic whitespace", () => {
    // Otherwise a profile could fail to verify against its own commitment.
    const a = commitProfile("driver", DRIVER);
    const b = commitProfile("driver", { contact: " sig:@samv ", plate: "8KLM221", name: "Sam Vega ", vehicle: "Honda PCX" });
    expect(b).toBe(a);
  });

  it("distinguishes an absent field from an empty one", () => {
    expect(commitProfile("driver", { name: "A" })).toBe(commitProfile("driver", { name: "A", plate: "" }));
    expect(commitProfile("driver", { name: "A", plate: "X" })).not.toBe(commitProfile("driver", { name: "A" }));
  });

  it("does not mistake a demo or menu URI for a commitment", () => {
    expect(isCommitted("demo://sam")).toBe(false);
    expect(isCommitted("ipfs://Qm...")).toBe(false);
    expect(isCommitted("fare-meta:v1:nothex")).toBe(false);
    expect(isCommitted(undefined)).toBe(false);
  });

  it("tells an onlooker nothing", () => {
    expect(describeProfile(commitProfile("driver", DRIVER))).toMatch(/private/);
    expect(describeProfile("demo://sam")).toBe("sam");
  });
});

describe("order-scoped reveal", () => {
  const driver = Wallet.createRandom();
  const customer = Wallet.createRandom();
  const stranger = Wallet.createRandom();

  it("reveals to the counterparty and verifies against the registry", async () => {
    const uri = commitProfile("driver", DRIVER);
    const sealed = await sealProfile("driver", driver.privateKey, pubKeyOf(customer.privateKey), 42n, DRIVER);
    const got = await openProfile("driver", customer.privateKey, pubKeyOf(driver.privateKey), 42n, sealed, uri);
    expect(got).toEqual(DRIVER);
  });

  it("rejects a profile that isn't the one registered", async () => {
    // The binding is the point: a driver who can present any profile has only
    // moved the problem off-chain.
    const uri = commitProfile("driver", DRIVER);
    const lie = { ...DRIVER, plate: "0000000" };
    const sealed = await sealProfile("driver", driver.privateKey, pubKeyOf(customer.privateKey), 42n, lie);
    await expect(
      openProfile("driver", customer.privateKey, pubKeyOf(driver.privateKey), 42n, sealed, uri)
    ).rejects.toThrow(/commitment/);
  });

  it("does not open for a third party", async () => {
    const sealed = await sealProfile("driver", driver.privateKey, pubKeyOf(customer.privateKey), 42n, DRIVER);
    await expect(
      openProfile("driver", stranger.privateKey, pubKeyOf(driver.privateKey), 42n, sealed, commitProfile("driver", DRIVER))
    ).rejects.toThrow();
  });

  it("does not cross order threads", async () => {
    // Per-order salt: the same profile revealed on order 42 must not open under
    // order 43, so two orders' reveals can't be tied together by ciphertext.
    const sealed = await sealProfile("driver", driver.privateKey, pubKeyOf(customer.privateKey), 42n, DRIVER);
    await expect(
      openProfile("driver", customer.privateKey, pubKeyOf(driver.privateKey), 43n, sealed, commitProfile("driver", DRIVER))
    ).rejects.toThrow();
  });

  it("yields unrelatable ciphertexts for the same profile on different orders", async () => {
    const a = await sealProfile("driver", driver.privateKey, pubKeyOf(customer.privateKey), 1n, DRIVER);
    const b = await sealProfile("driver", driver.privateKey, pubKeyOf(customer.privateKey), 2n, DRIVER);
    expect(a.ct).not.toBe(b.ct);
  });
});

describe("device-local profile", () => {
  it("round-trips the plaintext the chain does not hold", () => {
    saveSelfProfile("driver", DRIVER);
    expect(loadSelfProfile("driver")).toEqual(DRIVER);
  });

  it("keeps each role's profile separate", () => {
    saveSelfProfile("driver", DRIVER);
    saveSelfProfile("customer", CUSTOMER);
    expect(loadSelfProfile("driver")).toEqual(DRIVER);
    expect(loadSelfProfile("customer")).toEqual(CUSTOMER);
    expect(loadSelfProfile("venue")).toBeNull();
  });

  it("migrates a bare driver profile written by the previous version", () => {
    localStorage.setItem("fare.profile.self", JSON.stringify(DRIVER));
    expect(loadSelfProfile("driver")).toEqual(DRIVER);
  });
});

describe("customer and venue profiles", () => {
  const a = Wallet.createRandom();
  const b = Wallet.createRandom();

  it("commits and reveals a customer's door details", async () => {
    const commit = commitProfile("customer", CUSTOMER);
    const sealed = await sealProfile("customer", a.privateKey, pubKeyOf(b.privateKey), 7n, CUSTOMER);
    expect(await openProfile("customer", b.privateKey, pubKeyOf(a.privateKey), 7n, sealed, commit)).toEqual(CUSTOMER);
  });

  it("commits and reveals a venue's private pickup details", async () => {
    const commit = commitProfile("venue", VENUE);
    const sealed = await sealProfile("venue", a.privateKey, pubKeyOf(b.privateKey), 7n, VENUE);
    expect(await openProfile("venue", b.privateKey, pubKeyOf(a.privateKey), 7n, sealed, commit)).toEqual(VENUE);
  });

  it("does not verify a customer payload against a driver commitment", () => {
    // The roles read different fields, so the same object hashes differently —
    // which is what stops a profile being replayed across roles.
    const shared = { name: "Rae" };
    expect(commitProfile("customer", shared)).toBe(commitProfile("driver", shared));
    expect(verifyPayload("driver", profilePayload("customer", CUSTOMER), commitProfile("customer", CUSTOMER)))
      .toBeNull();
  });

  it("drops fields that do not belong to the role rather than hashing them", () => {
    // A client that learns a new field must not invalidate an older peer's
    // commitment by including it.
    expect(commitProfile("venue", { ...VENUE, plate: "8KLM221" } as any)).toBe(commitProfile("venue", VENUE));
  });
});

describe("payload verification (what the chat transport hands back)", () => {
  it("accepts the committed profile and rejects anything else", () => {
    const uri = commitProfile("driver", DRIVER);
    expect(verifyPayload("driver", profilePayload("driver", DRIVER), uri)).toEqual(DRIVER);
    expect(verifyPayload("driver", profilePayload("driver", { ...DRIVER, plate: "XXX" }), uri)).toBeNull();
    expect(verifyPayload("driver", "not json", uri)).toBeNull();
    expect(verifyPayload("driver", profilePayload("driver", DRIVER), "demo://sam")).toBeNull();
  });
});
