// Disclosure capsules (docs/PRIVACY-TIERS.md §7).
//
// Everything else in the privacy work makes order data unreadable to outsiders.
// That is the right default and the wrong absolute: a dispute has to be
// resolvable, and a safety incident has to have a route to the facts. A capsule
// is the escape hatch — the ORDER THREAD's key, encrypted to the arbiter, posted
// at assignment and opened only if a dispute is filed.
//
// Scope is the point. A capsule discloses one order's messages. It is not an
// account key: it cannot sign, cannot spend, and cannot open any other order,
// because the thread key is derived per order (msg.ts `orderContext`).
//
// Correctness of the ciphertext is NOT proved. Proving "this really encrypts the
// right key" needs a ZK proof of correct encryption, which is expensive; instead
// the rule is **fail closed** — a dispute in which a party's capsule is missing
// or doesn't open resolves against that party. The incentive does the work the
// proof would have done, and it costs nothing.
import { SigningKey, Wallet, computeAddress, getBytes, hexlify, keccak256, concat } from "ethers";
import { exportOrderKey } from "./msg";

export interface Capsule {
  epk: string; // ephemeral public key (the sender is anonymous; this is not their identity key)
  iv: string;
  ct: string;
}

const PREFIX = "fare-capsule:v1:";

function toBuf(src: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(src.length);
  out.set(src);
  return out;
}
const buf = (hex: string): Uint8Array<ArrayBuffer> => toBuf(getBytes(hex));

async function capsuleKey(privateKey: string, theirPubKey: string) {
  const shared = new SigningKey(privateKey).computeSharedSecret(theirPubKey);
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey("raw", buf(shared), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: enc.encode(PREFIX), info: enc.encode("fare-capsule") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/// Is `pubKey` really the arbiter the disputes contract names? Encrypting to an
/// unverified key would hand the order thread to whoever supplied it, so this is
/// checked before every seal rather than trusted from config.
export function arbiterKeyMatches(pubKey: string, arbiterAddress: string): boolean {
  try {
    return computeAddress(pubKey).toLowerCase() === arbiterAddress.toLowerCase();
  } catch {
    return false;
  }
}

/// Seal this order's thread key to the arbiter. A fresh ephemeral keypair per
/// capsule means the capsule itself carries no link to the party who posted it —
/// two orders' capsules from the same driver are unrelatable.
export async function sealCapsule(
  arbiterPubKey: string, myPrivateKey: string, theirPubKey: string, orderId: string | bigint
): Promise<Capsule> {
  const orderKey = await exportOrderKey(myPrivateKey, theirPubKey, orderId);
  const eph = Wallet.createRandom();
  const key = await capsuleKey(eph.privateKey, arbiterPubKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, buf(orderKey));
  return { epk: new SigningKey(eph.privateKey).publicKey, iv: hexlify(iv), ct: hexlify(new Uint8Array(ct)) };
}

/// Arbiter side: recover the order thread key. Throws on a capsule that was
/// tampered with or sealed to a different arbiter — both are "does not open",
/// which under the fail-closed rule resolves against whoever posted it.
export async function openCapsule(arbiterPrivateKey: string, capsule: Capsule): Promise<string> {
  const key = await capsuleKey(arbiterPrivateKey, capsule.epk);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(capsule.iv) }, key, buf(capsule.ct));
  return hexlify(new Uint8Array(pt));
}

/// A binding digest over the capsules escrowed for an order, for anchoring
/// on-chain in `openDispute`'s evidenceURI. Without an anchor the transport
/// could swap a capsule after the fact and the fail-closed rule would punish an
/// honest party.
export function capsuleDigest(capsules: Capsule[]): string {
  const parts = [...capsules]
    .map((c) => keccak256(concat([c.epk, c.iv, c.ct])))
    .sort(); // order-independent: the two parties post independently
  return keccak256(concat(parts));
}

/// The string to pass to `FareDisputes.openDispute` — the field is free-form, so
/// anchoring needs no contract change.
export function evidenceURI(capsules: Capsule[], extra?: string): string {
  return PREFIX + capsuleDigest(capsules).slice(2) + (extra ? `:${extra}` : "");
}

/// Check an on-chain evidenceURI against the capsules the arbiter actually
/// fetched. A mismatch means the bundle is not the one the dispute was opened
/// over — treat it as no evidence at all.
export function evidenceMatches(uri: string, capsules: Capsule[]): boolean {
  if (!uri?.startsWith(PREFIX)) return false;
  return uri.slice(PREFIX.length).split(":")[0] === capsuleDigest(capsules).slice(2);
}
