import { describe, it, expect } from "vitest";
import { Wallet } from "ethers";
import { newPhotoKey, sealPhoto, openPhoto } from "./photo";
import { pubKeyOf, sealMessage, openMessage } from "./msg";

// Proof-of-delivery photo sealing (photo.ts) + its composition with the E2E key
// transport (msg.ts). Proves: round-trip, wrong-key rejection, tamper rejection,
// crypto-shred expiry (a forgotten key is unrecoverable), and the full flow —
// driver seals a photo and wraps the key to the customer, who unwraps + opens.
describe("proof-of-delivery photo (crypto-shred)", () => {
  const photo = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4, 5, 6, 7, 8]); // fake PNG bytes

  it("round-trips photo bytes under its key", async () => {
    const key = newPhotoKey();
    const sealed = await sealPhoto(key, photo);
    expect(new Uint8Array(await openPhoto(key, sealed))).toEqual(photo);
  });

  it("a different key cannot open it (crypto-shred: forget the key → gone)", async () => {
    const sealed = await sealPhoto(newPhotoKey(), photo);
    await expect(openPhoto(newPhotoKey(), sealed)).rejects.toThrow();
  });

  it("rejects tampered ciphertext (GCM authentication)", async () => {
    const key = newPhotoKey();
    const sealed = await sealPhoto(key, photo);
    const flip = sealed.ct.slice(0, -2) + (sealed.ct.endsWith("00") ? "11" : "00");
    await expect(openPhoto(key, { ...sealed, ct: flip })).rejects.toThrow();
  });

  it("full flow: driver seals photo, wraps the key to the customer over the E2E channel", async () => {
    const driver = Wallet.createRandom();
    const customer = Wallet.createRandom();
    const orderId = 99n;

    // Driver: fresh key, encrypt photo (ciphertext → Bulletin/IPFS), wrap key to customer.
    const key = newPhotoKey();
    const sealedPhoto = await sealPhoto(key, photo);
    const wrappedKey = await sealMessage(driver.privateKey, pubKeyOf(customer.privateKey), orderId, key);

    // Customer: unwrap the key, decrypt the photo.
    const recoveredKey = await openMessage(customer.privateKey, pubKeyOf(driver.privateKey), orderId, wrappedKey);
    expect(recoveredKey).toBe(key);
    expect(new Uint8Array(await openPhoto(recoveredKey, sealedPhoto))).toEqual(photo);

    // A third party with the ciphertext + wrapped key but not a participant key can't get in.
    const eve = Wallet.createRandom();
    await expect(
      openMessage(eve.privateKey, pubKeyOf(driver.privateKey), orderId, wrappedKey)
    ).rejects.toThrow();
  });
});
