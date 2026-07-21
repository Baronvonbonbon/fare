// End-to-end encrypted, order-scoped messaging crypto — transport-agnostic.
//
// Reuses the Polkadot account-key encryption PATTERN (derive an encryption key
// from the account key → E2E-encrypt content → carry ciphertext over a separate
// transport), adapted from sr25519/x25519/NaCl-box to FARE's secp256k1/EVM keys:
//
//     secp256k1 ECDH (ethers SigningKey.computeSharedSecret)
//       → HKDF-SHA256 (per-order salt)
//       → AES-256-GCM (authenticated).
//
// The shared key is symmetric: each side derives it from its OWN private key and
// the counterparty's PUBLIC key. The counterparty's pubkey needs no extra
// exchange — it's recoverable from a signature they already produced at handoff
// (recoverPubKey). Content is never readable by the transport/relay; only the
// two order participants hold the key.
//
// The relay/transport is deliberately NOT in this file — it's the one part that
// needs infra. See docs/MESSAGING.md for the deferred relay design + the privacy
// and resiliency recommendations.

import { SigningKey, getBytes, hexlify } from "ethers";

export interface Sealed {
  iv: string; // hex, 12 bytes
  ct: string; // hex, AES-GCM ciphertext + auth tag
}

/// This wallet's secp256k1 public key (uncompressed). Either share it directly or
/// let the counterparty recover it from a signature via recoverPubKey.
export function pubKeyOf(privateKey: string): string {
  return new SigningKey(privateKey).publicKey;
}

/// Recover the counterparty's public key from a signature they made over
/// `digest` — e.g. the EIP-712 handoff attestation both parties already exchange,
/// so no dedicated key-exchange step is needed.
export function recoverPubKey(digest: string, signature: string): string {
  return SigningKey.recoverPublicKey(digest, signature);
}

/// Per-order key-derivation context, so each order's thread gets a distinct key
/// and threads never cross (privacy) or decrypt each other.
export function orderContext(orderId: string | bigint): string {
  return `fare-msg:v1:${orderId}`;
}

// Web Crypto's BufferSource requires a plain-ArrayBuffer-backed view; copy into a
// freshly-allocated one so the (otherwise ArrayBufferLike) bytes typecheck.
function toBuf(src: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(src.length);
  out.set(src);
  return out;
}
const buf = (hex: string): Uint8Array<ArrayBuffer> => toBuf(getBytes(hex));

async function deriveAesKey(privateKey: string, theirPubKey: string, context: string) {
  const shared = new SigningKey(privateKey).computeSharedSecret(theirPubKey);
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey("raw", buf(shared), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode(context), info: enc.encode("fare-msg") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/// Encrypt `plaintext` to the counterparty for a given order.
export async function sealMessage(
  myPrivateKey: string,
  theirPubKey: string,
  orderId: string | bigint,
  plaintext: string
): Promise<Sealed> {
  const key = await deriveAesKey(myPrivateKey, theirPubKey, orderContext(orderId));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = toBuf(new TextEncoder().encode(plaintext));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  return { iv: hexlify(iv), ct: hexlify(new Uint8Array(ct)) };
}

/// Decrypt a Sealed message from the counterparty for a given order. Throws if
/// the key/order is wrong or the ciphertext was tampered (GCM authentication).
export async function openMessage(
  myPrivateKey: string,
  theirPubKey: string,
  orderId: string | bigint,
  sealed: Sealed
): Promise<string> {
  const key = await deriveAesKey(myPrivateKey, theirPubKey, orderContext(orderId));
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(sealed.iv) }, key, buf(sealed.ct));
  return new TextDecoder().decode(pt);
}
