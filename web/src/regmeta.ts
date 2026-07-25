// Encrypted registration metadata (docs/PRIVACY-TIERS.md §5).
//
// `FareDrivers.metadataURI` is world-readable, so a driver's name, vehicle,
// plate and contact route are published to everyone forever — for the benefit of
// the one customer per order who actually needs them. This module keeps the
// details off-chain and reveals them only to the counterparty of a live order.
//
//   on-chain   `fare-meta:v1:<keccak256(canonical profile)>` — a commitment.
//              Nothing to read; enough to prove what was shown was the real one.
//   off-chain  the profile sealed to the counterparty with the per-order ECDH
//              key from msg.ts, delivered over the existing message transport.
//
// Binding matters as much as secrecy: a driver who could hand the customer any
// profile has only moved the problem. `openProfile` refuses a payload that
// doesn't hash to the on-chain commitment, so what the customer sees is what the
// driver committed to at registration.
//
// NOT applied to venues: their metadataURI carries the public menu, which
// discovery and ordering both need (§2 — the venue's location and identity are
// public by design). A venue's private contact details belong in an order-scoped
// message, not in the registry.
import { keccak256, toUtf8Bytes } from "ethers";
import { sealMessage, openMessage, type Sealed } from "./msg";

const PREFIX = "fare-meta:v1:";
const SELF_KEY = "fare.profile.self"; // this device's plaintext profile

/// What a counterparty needs to complete a handoff, and nothing else.
export interface DriverProfile {
  name: string;
  vehicle?: string;
  plate?: string;
  contact?: string;
}

/// Canonical serialization — key order and absent-vs-empty must not change the
/// hash, or a profile would fail to verify against its own commitment.
function canonical(p: DriverProfile): string {
  const clean: Record<string, string> = {};
  for (const k of ["name", "vehicle", "plate", "contact"] as const) {
    const v = (p[k] ?? "").trim();
    if (v) clean[k] = v;
  }
  return JSON.stringify(clean, Object.keys(clean).sort());
}

/// The on-chain value: a commitment, not a document.
export function commitProfile(p: DriverProfile): string {
  return PREFIX + keccak256(toUtf8Bytes(canonical(p))).slice(2);
}

/// Is this registry entry a commitment rather than a plaintext/demo URI?
export function isCommitted(uri: string | undefined): boolean {
  return !!uri && uri.startsWith(PREFIX) && /^[0-9a-f]{64}$/.test(uri.slice(PREFIX.length));
}

/// Does `p` match what the registry committed to?
export function verifyProfile(uri: string, p: DriverProfile): boolean {
  return isCommitted(uri) && commitProfile(p) === uri;
}

/// What to show someone who has no right to the details.
export function describeProfile(uri: string | undefined): string {
  if (isCommitted(uri)) return "private — shared with your driver/customer at assignment";
  return (uri ?? "").replace(/^\w+:\/\//, "") || "—";
}

// ── device-local plaintext ───────────────────────────────────────────────────
// The committed profile is only recoverable from this device: the chain holds a
// hash, so losing it means re-registering a new commitment.
export function loadSelfProfile(): DriverProfile | null {
  try { return JSON.parse(localStorage.getItem(SELF_KEY) || "null"); } catch { return null; }
}
export function saveSelfProfile(p: DriverProfile): void {
  localStorage.setItem(SELF_KEY, JSON.stringify(p));
}

// ── order-scoped reveal ──────────────────────────────────────────────────────

/// The exact bytes to reveal — the same canonical form the commitment is over,
/// so the receiver can hash what it got and compare. Use with a transport that
/// already seals per order (channel.ts `sendProfile`).
export function profilePayload(p: DriverProfile): string {
  return canonical(p);
}

/// Check a revealed payload against the sender's registry entry. Returns null
/// rather than throwing, because a failed reveal is a UI state ("unverified"),
/// not an exception — but it must never be shown as if it were verified.
export function verifyPayload(json: string, registryURI: string): DriverProfile | null {
  try {
    const p = JSON.parse(json) as DriverProfile;
    return verifyProfile(registryURI, p) ? p : null;
  } catch {
    return null;
  }
}

/// Seal this device's profile to the order counterparty. Order-scoped, so the
/// same profile revealed on two orders yields unrelatable ciphertexts.
export async function sealProfile(
  myPrivateKey: string, theirPubKey: string, orderId: string | bigint, p: DriverProfile
): Promise<Sealed> {
  return sealMessage(myPrivateKey, theirPubKey, orderId, canonical(p));
}

/// Open a counterparty's profile and check it against their on-chain
/// commitment. Throws if the payload was tampered (GCM) or if it doesn't match
/// what they registered — an unverified profile is worth less than none.
export async function openProfile(
  myPrivateKey: string, theirPubKey: string, orderId: string | bigint,
  sealed: Sealed, registryURI: string
): Promise<DriverProfile> {
  const json = await openMessage(myPrivateKey, theirPubKey, orderId, sealed);
  const p = JSON.parse(json) as DriverProfile;
  if (!verifyProfile(registryURI, p)) {
    throw new Error("profile does not match the driver's on-chain commitment");
  }
  return p;
}
