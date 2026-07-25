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

describe("profile commitments", () => {
  it("publishes a hash, not the details", () => {
    const uri = commitProfile(DRIVER);
    expect(isCommitted(uri)).toBe(true);
    for (const secret of Object.values(DRIVER)) {
      expect(uri.toLowerCase()).not.toContain(secret.toLowerCase().replace(/\s/g, ""));
    }
    expect(uri).not.toContain("Sam");
  });

  it("is stable across key order and cosmetic whitespace", () => {
    // Otherwise a profile could fail to verify against its own commitment.
    const a = commitProfile(DRIVER);
    const b = commitProfile({ contact: " sig:@samv ", plate: "8KLM221", name: "Sam Vega ", vehicle: "Honda PCX" });
    expect(b).toBe(a);
  });

  it("distinguishes an absent field from an empty one", () => {
    expect(commitProfile({ name: "A" })).toBe(commitProfile({ name: "A", plate: "" }));
    expect(commitProfile({ name: "A", plate: "X" })).not.toBe(commitProfile({ name: "A" }));
  });

  it("does not mistake a demo or menu URI for a commitment", () => {
    expect(isCommitted("demo://sam")).toBe(false);
    expect(isCommitted("ipfs://Qm...")).toBe(false);
    expect(isCommitted("fare-meta:v1:nothex")).toBe(false);
    expect(isCommitted(undefined)).toBe(false);
  });

  it("tells an onlooker nothing", () => {
    expect(describeProfile(commitProfile(DRIVER))).toMatch(/private/);
    expect(describeProfile("demo://sam")).toBe("sam");
  });
});

describe("order-scoped reveal", () => {
  const driver = Wallet.createRandom();
  const customer = Wallet.createRandom();
  const stranger = Wallet.createRandom();

  it("reveals to the counterparty and verifies against the registry", async () => {
    const uri = commitProfile(DRIVER);
    const sealed = await sealProfile(driver.privateKey, pubKeyOf(customer.privateKey), 42n, DRIVER);
    const got = await openProfile(customer.privateKey, pubKeyOf(driver.privateKey), 42n, sealed, uri);
    expect(got).toEqual(DRIVER);
  });

  it("rejects a profile that isn't the one registered", async () => {
    // The binding is the point: a driver who can present any profile has only
    // moved the problem off-chain.
    const uri = commitProfile(DRIVER);
    const lie = { ...DRIVER, plate: "0000000" };
    const sealed = await sealProfile(driver.privateKey, pubKeyOf(customer.privateKey), 42n, lie);
    await expect(
      openProfile(customer.privateKey, pubKeyOf(driver.privateKey), 42n, sealed, uri)
    ).rejects.toThrow(/commitment/);
  });

  it("does not open for a third party", async () => {
    const sealed = await sealProfile(driver.privateKey, pubKeyOf(customer.privateKey), 42n, DRIVER);
    await expect(
      openProfile(stranger.privateKey, pubKeyOf(driver.privateKey), 42n, sealed, commitProfile(DRIVER))
    ).rejects.toThrow();
  });

  it("does not cross order threads", async () => {
    // Per-order salt: the same profile revealed on order 42 must not open under
    // order 43, so two orders' reveals can't be tied together by ciphertext.
    const sealed = await sealProfile(driver.privateKey, pubKeyOf(customer.privateKey), 42n, DRIVER);
    await expect(
      openProfile(customer.privateKey, pubKeyOf(driver.privateKey), 43n, sealed, commitProfile(DRIVER))
    ).rejects.toThrow();
  });

  it("yields unrelatable ciphertexts for the same profile on different orders", async () => {
    const a = await sealProfile(driver.privateKey, pubKeyOf(customer.privateKey), 1n, DRIVER);
    const b = await sealProfile(driver.privateKey, pubKeyOf(customer.privateKey), 2n, DRIVER);
    expect(a.ct).not.toBe(b.ct);
  });
});

describe("device-local profile", () => {
  it("round-trips the plaintext the chain does not hold", () => {
    saveSelfProfile(DRIVER);
    expect(loadSelfProfile()).toEqual(DRIVER);
  });
});

describe("payload verification (what the chat transport hands back)", () => {
  it("accepts the committed profile and rejects anything else", () => {
    const uri = commitProfile(DRIVER);
    expect(verifyPayload(profilePayload(DRIVER), uri)).toEqual(DRIVER);
    expect(verifyPayload(profilePayload({ ...DRIVER, plate: "XXX" }), uri)).toBeNull();
    expect(verifyPayload("not json", uri)).toBeNull();
    expect(verifyPayload(profilePayload(DRIVER), "demo://sam")).toBeNull();
  });
});
