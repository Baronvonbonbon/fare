// Commitment-backed profiles (docs/PRIVACY-TIERS.md §5).
//
// A counterparty needs to know things about you to complete a delivery — a
// driver's vehicle and plate, a customer's buzzer code, a venue's back-door
// instructions. None of that needs to be world-readable, and all of it was:
// `FareDrivers.metadataURI` is public storage, and the customer had no way to
// pass their details at all.
//
//   commitment  `fare-meta:v1:<keccak256(canonical profile)>` — nothing to read;
//               enough to prove what was shown was the real one.
//   plaintext   sealed to the counterparty with the per-order ECDH key from
//               msg.ts, delivered over the existing message transport.
//
// Binding matters as much as secrecy: a party who could hand over any profile
// has only moved the problem. `openProfile` refuses a payload that doesn't hash
// to the commitment, so what you see is what they committed to.
//
// Where the commitment LIVES differs by role, because only the driver has a
// registry slot for it:
//
//   driver    `FareDrivers.metadataURI` — on-chain, authoritative.
//   customer  the authenticated `hello` on the order thread, SIGNED by the order
//             wallet (channel.ts). A burner has no registry entry, and adding one
//             would give the per-order wallet a persistent identity, which is the
//             thing it exists to avoid.
//   venue     the venue's menu JSON, which `metadataURI` already anchors — only
//             the operator can `setMetadata`, so the chain says which document
//             counts. The menu itself stays public; it carries the public menu.
import { keccak256, toUtf8Bytes } from "ethers";
import { sealMessage, openMessage, type Sealed } from "./msg";

const PREFIX = "fare-meta:v1:";
const SELF_KEY = "fare.profile.self"; // this device's plaintext profiles, by role

export type ProfileRole = "driver" | "customer" | "venue";

/// What each role's counterparty needs to complete a handoff, and nothing else.
///
/// The field LIST is part of the commitment scheme: canonicalization reads
/// exactly these keys in this order, so adding a field to a role changes every
/// hash for that role. `driver` is frozen — its commitments are live on-chain.
const FIELDS: Record<ProfileRole, readonly string[]> = {
  driver: ["name", "vehicle", "plate", "contact"],
  customer: ["name", "phone", "buzzer", "instructions"],
  venue: ["name", "contact", "pickup"],
};

export interface DriverProfile {
  name: string;
  vehicle?: string;
  plate?: string;
  contact?: string;
}

/// The details a driver needs at the door and nobody else ever should. `buzzer`
/// and `instructions` are exactly the information the ZK drop commitment keeps
/// off-chain, so they must not leak anywhere the coordinates don't.
export interface CustomerProfile {
  name: string;
  phone?: string;
  buzzer?: string;
  instructions?: string;
}

/// A venue's private operational details — the counter phone, where the driver
/// actually collects. Distinct from the menu, which is public by design.
export interface VenueProfile {
  name: string;
  contact?: string;
  pickup?: string;
}

export type Profile = DriverProfile | CustomerProfile | VenueProfile;

/// Canonical serialization — key order and absent-vs-empty must not change the
/// hash, or a profile would fail to verify against its own commitment. Unknown
/// keys are dropped rather than hashed, so a client that learns a new field
/// can't silently invalidate an older peer's commitment.
function canonical(role: ProfileRole, p: Profile): string {
  const clean: Record<string, string> = {};
  for (const k of FIELDS[role]) {
    const v = ((p as unknown as Record<string, string | undefined>)[k] ?? "").trim();
    if (v) clean[k] = v;
  }
  return JSON.stringify(clean, Object.keys(clean).sort());
}

/// The committed value: a commitment, not a document.
export function commitProfile(role: ProfileRole, p: Profile): string {
  return PREFIX + keccak256(toUtf8Bytes(canonical(role, p))).slice(2);
}

/// Is this a commitment rather than a plaintext/demo URI?
export function isCommitted(uri: string | undefined): boolean {
  return !!uri && uri.startsWith(PREFIX) && /^[0-9a-f]{64}$/.test(uri.slice(PREFIX.length));
}

/// Does `p` match what was committed to?
export function verifyProfile(role: ProfileRole, uri: string, p: Profile): boolean {
  return isCommitted(uri) && commitProfile(role, p) === uri;
}

/// What to show someone who has no right to the details.
export function describeProfile(uri: string | undefined): string {
  if (isCommitted(uri)) return "private — shared with your counterparty at assignment";
  return (uri ?? "").replace(/^\w+:\/\//, "") || "—";
}

// ── device-local plaintext ───────────────────────────────────────────────────
// The commitment is only recoverable from this device: the chain (or the thread)
// holds a hash, so losing it means committing to a new one.

type SelfStore = Partial<Record<ProfileRole, Profile>>;

function loadStore(): SelfStore {
  try {
    const raw = JSON.parse(localStorage.getItem(SELF_KEY) || "null");
    if (!raw || typeof raw !== "object") return {};
    // Migration: this key used to hold a bare DriverProfile.
    if ("name" in raw && !("driver" in raw || "customer" in raw || "venue" in raw)) {
      return { driver: raw as DriverProfile };
    }
    return raw as SelfStore;
  } catch {
    return {};
  }
}

export function loadSelfProfile<T extends Profile = Profile>(role: ProfileRole): T | null {
  return (loadStore()[role] as T) ?? null;
}

export function saveSelfProfile(role: ProfileRole, p: Profile): void {
  localStorage.setItem(SELF_KEY, JSON.stringify({ ...loadStore(), [role]: p }));
}

// ── order-scoped reveal ──────────────────────────────────────────────────────

/// The exact bytes to reveal — the same canonical form the commitment is over,
/// so the receiver can hash what it got and compare. Use with a transport that
/// already seals per order (channel.ts `sendProfile`).
export function profilePayload(role: ProfileRole, p: Profile): string {
  return canonical(role, p);
}

/// Check a revealed payload against the sender's commitment. Returns null rather
/// than throwing, because a failed reveal is a UI state ("unverified"), not an
/// exception — but it must never be shown as if it were verified.
export function verifyPayload<T extends Profile = Profile>(
  role: ProfileRole, json: string, commitment: string
): T | null {
  try {
    const p = JSON.parse(json) as T;
    return verifyProfile(role, commitment, p) ? p : null;
  } catch {
    return null;
  }
}

/// Seal this device's profile to the order counterparty. Order-scoped, so the
/// same profile revealed on two orders yields unrelatable ciphertexts.
export async function sealProfile(
  role: ProfileRole, myPrivateKey: string, theirPubKey: string, orderId: string | bigint, p: Profile
): Promise<Sealed> {
  return sealMessage(myPrivateKey, theirPubKey, orderId, canonical(role, p));
}

/// Open a counterparty's profile and check it against their commitment. Throws
/// if the payload was tampered (GCM) or doesn't match what they committed to —
/// an unverified profile is worth less than none.
export async function openProfile<T extends Profile = Profile>(
  role: ProfileRole, myPrivateKey: string, theirPubKey: string, orderId: string | bigint,
  sealed: Sealed, commitment: string
): Promise<T> {
  const json = await openMessage(myPrivateKey, theirPubKey, orderId, sealed);
  const p = JSON.parse(json) as T;
  if (!verifyProfile(role, commitment, p)) {
    throw new Error("profile does not match the sender's commitment");
  }
  return p;
}
