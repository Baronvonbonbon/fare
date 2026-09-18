// Settlement hand-offs that work without a GPS fix (docs/POLKADOT-PLATFORM-PLAN.md §4.10).
//
// The contract never sensed location: what releases money is two signatures from
// parties whose interests oppose each other at that moment (docs/GPS.md). A fix is
// evidence on top. So when the runtime gives no fix — the Polkadot app's Android
// WebView, issue #7 — each step falls back to coordinates that make the geometry
// hold by construction, and the signature that actually protects the step is
// unchanged:
//
//   pickup   the driver and the venue sign the venue's registered pin. The venue's
//            signature is still the guarantee: it hands over goods it loses if the
//            pickup is fake.
//   dropoff  the customer builds the driver's position commitment from the drop
//            position and a fresh salt, and shows it as a QR (`dropoff-request`).
//            The driver signs that commitment without learning the drop. The
//            customer proves (driver position = drop) and submits — the customer's
//            own act of releasing the fare, exactly as with a fix.
//
// What is lost without a fix is dispute evidence, not settlement; the mode is
// returned everywhere so the UI can say which one a delivery used.

import { GeoError, getPosition, snapToGrid, type MicroDeg } from "./geo";
import { decodePayload, encodePayload, randomSalt, signDriverCommit, type DriverCommitAtt, type Session } from "./chain";
import { positionCommit } from "./zk";

export type FixMode = "gps" | "pin";

/// Position to sign at pickup: the device fix (snapped to the ~33 m grid, geo.ts)
/// when there is one, otherwise the venue's registered pin. Only a missing fix
/// falls back — a GPS fix far from the pin is still reported by the caller.
export async function pickupPosition(
  venuePin: MicroDeg,
  fix: () => Promise<MicroDeg> = getPosition
): Promise<{ pos: MicroDeg; mode: FixMode; why?: string }> {
  try {
    return { pos: snapToGrid(await fix()), mode: "gps" };
  } catch (e) {
    if (!(e instanceof GeoError)) throw e;
    return { pos: { lat: venuePin.lat, lon: venuePin.lon }, mode: "pin", why: e.message };
  }
}

// ── dropoff without a driver fix ────────────────────────────────────────────

export const DROPOFF_REQUEST = "dropoff-request";
export const DROPOFF_DRIVER = "dropoff-driver";

export interface DropSecret {
  lat: number;
  lon: number;
  salt: string;
}

/// The customer's half, kept on this device until the driver's signed code comes back.
export interface PendingRequest {
  orderId: string;
  posCommit: string;
  salt: string;
}

const pendingKey = (orderId: string | bigint) => `fare:dropreq:${orderId}`;

/// Customer: commit to the drop position under a fresh salt, for the driver to sign.
/// The QR carries only the commitment — no coordinate reaches the driver.
export function makeDropoffRequest(orderId: string | bigint, drop: DropSecret): { payload: string; pending: PendingRequest } {
  const salt = randomSalt();
  const pending = { orderId: orderId.toString(), posCommit: positionCommit(drop.lat, drop.lon, salt), salt };
  try {
    localStorage.setItem(pendingKey(orderId), JSON.stringify(pending));
  } catch {
    /* private mode: the request still works within this page */
  }
  return { payload: encodePayload(DROPOFF_REQUEST, { orderId: pending.orderId, posCommit: pending.posCommit }, ""), pending };
}

export function loadPendingRequest(orderId: string | bigint): PendingRequest | null {
  try {
    const p = JSON.parse(localStorage.getItem(pendingKey(orderId)) || "null");
    return p && p.orderId === orderId.toString() ? p : null;
  } catch {
    return null;
  }
}

export function clearPendingRequest(orderId: string | bigint): void {
  try {
    localStorage.removeItem(pendingKey(orderId));
  } catch {
    /* nothing stored */
  }
}

/// Driver: sign the customer's commitment. Refuses a request for another order,
/// so a code from a previous door cannot be replayed onto this job.
export async function signDropoffRequest(session: Session, orderId: string | bigint, requestPayload: string): Promise<string> {
  const req = decodePayload(requestPayload);
  if (req.kind !== DROPOFF_REQUEST) throw new Error("That's not a customer handoff request");
  if (String(req.att?.orderId) !== orderId.toString()) throw new Error("That request is for a different order");
  if (!/^0x[0-9a-f]{64}$/i.test(req.att?.posCommit ?? "")) throw new Error("The request carries no position commitment");
  const att: DriverCommitAtt = {
    orderId: orderId.toString(),
    phase: 2,
    actor: session.address,
    posCommit: req.att.posCommit,
    timestamp: Math.floor(Date.now() / 1000),
  };
  return encodePayload(DROPOFF_DRIVER, att, await signDriverCommit(session, att));
}

/// Customer: the driver-position witness for the proof. A code with `pos` is the
/// GPS handoff; one without must answer this device's pending request, and the
/// witness is then the drop itself.
export function driverWitness(
  driverPayload: { att: any; pos?: DropSecret },
  drop: DropSecret,
  pending: PendingRequest | null
): { driver: DropSecret; mode: FixMode } {
  if (driverPayload.pos) return { driver: driverPayload.pos, mode: "gps" };
  if (!pending) throw new Error("This driver code answers a handoff request this device didn't make");
  if (String(driverPayload.att?.posCommit).toLowerCase() !== pending.posCommit.toLowerCase()) {
    throw new Error("The driver signed a different request — show them your current code");
  }
  return { driver: { lat: drop.lat, lon: drop.lon, salt: pending.salt }, mode: "pin" };
}
