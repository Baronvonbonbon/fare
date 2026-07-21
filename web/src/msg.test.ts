import { describe, it, expect } from "vitest";
import { Wallet } from "ethers";
import { pubKeyOf, recoverPubKey, sealMessage, openMessage } from "./msg";

// The messaging crypto layer (msg.ts). Transport-agnostic: proves the
// secp256k1-ECDH → HKDF → AES-256-GCM construction round-trips, is confined to
// the two order participants, is per-order scoped, is tamper-evident, and can
// bootstrap the counterparty pubkey from a handoff signature.
describe("messaging crypto (secp256k1 ECDH + AES-GCM)", () => {
  it("round-trips both directions between customer and driver", async () => {
    const cust = Wallet.createRandom();
    const drv = Wallet.createRandom();
    const custPub = pubKeyOf(cust.privateKey);
    const drvPub = pubKeyOf(drv.privateKey);

    const s1 = await sealMessage(cust.privateKey, drvPub, 42n, "meet me at the side gate");
    expect(await openMessage(drv.privateKey, custPub, 42n, s1)).toBe("meet me at the side gate");

    const s2 = await sealMessage(drv.privateKey, custPub, 42n, "omw · 3 min");
    expect(await openMessage(cust.privateKey, drvPub, 42n, s2)).toBe("omw · 3 min");
  });

  it("a third party cannot decrypt (E2E confined to the two participants)", async () => {
    const cust = Wallet.createRandom(), drv = Wallet.createRandom(), eve = Wallet.createRandom();
    const sealed = await sealMessage(cust.privateKey, pubKeyOf(drv.privateKey), 1n, "home is 4B");
    await expect(openMessage(eve.privateKey, pubKeyOf(cust.privateKey), 1n, sealed)).rejects.toThrow();
  });

  it("is per-order scoped: a message for one order won't open under another", async () => {
    const cust = Wallet.createRandom(), drv = Wallet.createRandom();
    const sealed = await sealMessage(cust.privateKey, pubKeyOf(drv.privateKey), 1n, "order-1 note");
    await expect(openMessage(drv.privateKey, pubKeyOf(cust.privateKey), 2n, sealed)).rejects.toThrow();
  });

  it("rejects tampered ciphertext (GCM authentication)", async () => {
    const cust = Wallet.createRandom(), drv = Wallet.createRandom();
    const sealed = await sealMessage(cust.privateKey, pubKeyOf(drv.privateKey), 7n, "hi");
    const flip = sealed.ct.slice(0, -2) + (sealed.ct.endsWith("00") ? "11" : "00");
    await expect(
      openMessage(drv.privateKey, pubKeyOf(cust.privateKey), 7n, { ...sealed, ct: flip })
    ).rejects.toThrow();
  });

  it("recovers the counterparty pubkey from a handoff signature", async () => {
    const drv = Wallet.createRandom();
    const digest = "0x" + "ab".repeat(32);
    const sig = drv.signingKey.sign(digest).serialized;
    expect(recoverPubKey(digest, sig)).toBe(pubKeyOf(drv.privateKey));
  });
});
