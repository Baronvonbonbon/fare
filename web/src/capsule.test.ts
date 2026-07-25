import { describe, it, expect } from "vitest";
import { Wallet } from "ethers";
import { pubKeyOf, sealMessage, openMessage, exportOrderKey, openWithOrderKey } from "./msg";
import {
  sealCapsule, openCapsule, arbiterKeyMatches, capsuleDigest, evidenceURI, evidenceMatches,
} from "./capsule";

// Disclosure capsules (docs/PRIVACY-TIERS.md §7) — selective disclosure, so a
// dispute stays resolvable without making order data readable by default.

const driver = Wallet.createRandom();
const customer = Wallet.createRandom();
const arbiter = Wallet.createRandom();
const outsider = Wallet.createRandom();
const ORDER = 77n;

describe("exported order keys", () => {
  it("open exactly what the participants sealed", async () => {
    const sealed = await sealMessage(driver.privateKey, pubKeyOf(customer.privateKey), ORDER, "at the door");
    const key = await exportOrderKey(customer.privateKey, pubKeyOf(driver.privateKey), ORDER);
    expect(await openWithOrderKey(key, sealed)).toBe("at the door");
  });

  it("are the same key from either side", async () => {
    const a = await exportOrderKey(driver.privateKey, pubKeyOf(customer.privateKey), ORDER);
    const b = await exportOrderKey(customer.privateKey, pubKeyOf(driver.privateKey), ORDER);
    expect(a).toBe(b);
  });

  it("are scoped to ONE order — the whole point of selective disclosure", async () => {
    // Handing over order 77's key must not expose order 78.
    const key77 = await exportOrderKey(driver.privateKey, pubKeyOf(customer.privateKey), 77n);
    const other = await sealMessage(driver.privateKey, pubKeyOf(customer.privateKey), 78n, "unrelated order");
    await expect(openWithOrderKey(key77, other)).rejects.toThrow();
  });
});

describe("capsules", () => {
  it("let the arbiter read the thread, and nobody else", async () => {
    const capsule = await sealCapsule(
      pubKeyOf(arbiter.privateKey), driver.privateKey, pubKeyOf(customer.privateKey), ORDER
    );
    const sealed = await sealMessage(driver.privateKey, pubKeyOf(customer.privateKey), ORDER, "left at door");

    const key = await openCapsule(arbiter.privateKey, capsule);
    expect(await openWithOrderKey(key, sealed)).toBe("left at door");

    await expect(openCapsule(outsider.privateKey, capsule)).rejects.toThrow();
  });

  it("disclose the thread key and nothing else — not an account key", async () => {
    // The recovered material must not be, or yield, either party's private key.
    const capsule = await sealCapsule(
      pubKeyOf(arbiter.privateKey), driver.privateKey, pubKeyOf(customer.privateKey), ORDER
    );
    const key = await openCapsule(arbiter.privateKey, capsule);
    expect(key.toLowerCase()).not.toBe(driver.privateKey.toLowerCase());
    expect(key.toLowerCase()).not.toBe(customer.privateKey.toLowerCase());
    // ...and it can't open the counterparty's OTHER orders (see scoping above).
    const otherOrder = await sealMessage(customer.privateKey, pubKeyOf(driver.privateKey), 5n, "another job");
    await expect(openWithOrderKey(key, otherOrder)).rejects.toThrow();
  });

  it("carry no link to the party who posted them", async () => {
    // Fresh ephemeral key per capsule: two capsules from the same driver on two
    // orders must not be relatable by anything an observer can see.
    const a = await sealCapsule(pubKeyOf(arbiter.privateKey), driver.privateKey, pubKeyOf(customer.privateKey), 1n);
    const b = await sealCapsule(pubKeyOf(arbiter.privateKey), driver.privateKey, pubKeyOf(customer.privateKey), 2n);
    expect(a.epk).not.toBe(b.epk);
    expect(a.ct).not.toBe(b.ct);
    expect(a.epk).not.toBe(pubKeyOf(driver.privateKey));
  });

  it("fail to open when tampered — which fail-closed treats as no capsule", async () => {
    const capsule = await sealCapsule(
      pubKeyOf(arbiter.privateKey), driver.privateKey, pubKeyOf(customer.privateKey), ORDER
    );
    const flipped = { ...capsule, ct: capsule.ct.slice(0, -2) + (capsule.ct.endsWith("00") ? "01" : "00") };
    await expect(openCapsule(arbiter.privateKey, flipped)).rejects.toThrow();
  });

  it("are sealed only to the arbiter the contract names", () => {
    // Encrypting to an unverified key would hand the thread to whoever supplied
    // it, so the pubkey is checked against the on-chain arbiter address.
    expect(arbiterKeyMatches(pubKeyOf(arbiter.privateKey), arbiter.address)).toBe(true);
    expect(arbiterKeyMatches(pubKeyOf(outsider.privateKey), arbiter.address)).toBe(false);
    expect(arbiterKeyMatches("0xdeadbeef", arbiter.address)).toBe(false);
  });
});

describe("on-chain evidence anchor", () => {
  const mk = (n: number) => ({ epk: `0x${"11".repeat(33)}`, iv: `0x${String(n).padStart(24, "0")}`, ct: `0x${"22".repeat(48)}` });

  it("does not depend on the order the two parties posted in", () => {
    expect(capsuleDigest([mk(1), mk(2)])).toBe(capsuleDigest([mk(2), mk(1)]));
  });

  it("detects a bundle that isn't the one the dispute was opened over", () => {
    // Without the anchor the transport could swap a capsule after the fact and
    // fail-closed would punish an honest party.
    const uri = evidenceURI([mk(1), mk(2)]);
    expect(evidenceMatches(uri, [mk(2), mk(1)])).toBe(true);
    expect(evidenceMatches(uri, [mk(1), mk(3)])).toBe(false);
    expect(evidenceMatches(uri, [mk(1)])).toBe(false);
    expect(evidenceMatches("ipfs://Qm...", [mk(1), mk(2)])).toBe(false);
  });

  it("still round-trips with a human evidence pointer appended", () => {
    const uri = evidenceURI([mk(1)], "ipfs://QmEvidence");
    expect(evidenceMatches(uri, [mk(1)])).toBe(true);
    expect(uri).toContain("ipfs://QmEvidence");
  });
});
