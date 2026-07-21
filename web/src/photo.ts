// Proof-of-delivery photo sealing with crypto-shred expiry.
//
// A photo must NOT be permanent — it's only useful during delivery + the dispute
// window. It's encrypted under a FRESH random AES-256-GCM key, so it expires two
// independent ways:
//   1. Storage TTL — on the Polkadot Bulletin Chain the ciphertext is auto-pruned
//      after ~2 weeks unless `renew`ed (content-addressed; reads via IPFS gateway).
//   2. Crypto-shred — discard the random key after the order + dispute window;
//      the ciphertext becomes unrecoverable even if some copy lingers.
//
// The key is transported to the customer (and, for a dispute, the arbiter) over
// the E2E message channel (web/src/msg.ts) — so the photo is E2E-private in the
// meantime and only the intended parties can ever view it. The upload/submitter
// and the expiry job are deferred infra — see docs/PHOTOS.md.

import { hexlify, getBytes } from "ethers";

export interface SealedPhoto {
  iv: string; // hex, 12 bytes
  ct: string; // hex, AES-GCM ciphertext + auth tag
}

// Web Crypto BufferSource needs a plain-ArrayBuffer-backed view.
function toBuf(u8: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(u8.length);
  out.set(u8);
  return out;
}

/// A fresh random 256-bit photo key — the crypto-shred handle. Deleting every
/// copy of this key (and not renewing the storage) is what expires the photo.
export function newPhotoKey(): string {
  return hexlify(crypto.getRandomValues(new Uint8Array(32)));
}

async function importAes(keyHex: string) {
  return crypto.subtle.importKey("raw", toBuf(getBytes(keyHex)), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/// Encrypt photo bytes under `keyHex`. The ciphertext is what goes to storage
/// (Bulletin Chain / IPFS); the key travels separately over the E2E channel.
export async function sealPhoto(keyHex: string, bytes: Uint8Array): Promise<SealedPhoto> {
  const key = await importAes(keyHex);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, toBuf(bytes));
  return { iv: hexlify(iv), ct: hexlify(new Uint8Array(ct)) };
}

/// Decrypt a sealed photo. Throws if the key/ciphertext is wrong or tampered
/// (GCM authentication). Once the key is shredded this can never succeed again —
/// that irreversibility IS the expiry.
export async function openPhoto(keyHex: string, sealed: SealedPhoto): Promise<Uint8Array> {
  const key = await importAes(keyHex);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toBuf(getBytes(sealed.iv)) },
    key,
    toBuf(getBytes(sealed.ct))
  );
  return new Uint8Array(pt);
}
