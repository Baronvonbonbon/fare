// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { Wallet, verifyTypedData } from "ethers";
import { DRIVER_COMMIT_TYPES, decodePayload, eip712Domain, encodePayload, type Session } from "./chain";
import { GeoError } from "./geo";
import { positionCommit } from "./zk";
import {
  DROPOFF_DRIVER,
  DROPOFF_REQUEST,
  driverWitness,
  loadPendingRequest,
  makeDropoffRequest,
  pickupPosition,
  signDropoffRequest,
} from "./handoff";

// The no-GPS hand-offs (§4.10). The contract half — that these payloads settle
// against the real verifier — is test/gps-free-settlement.test.ts; this is the
// client half: what each QR carries, and what each side refuses.

const DROP = { lat: 37_784_900, lon: -122_419_400, salt: "12345" };
const PIN = { lat: 37_774_900, lon: -122_419_400 };
const driverWallet = new Wallet("0x" + "11".repeat(32)); // fixed: createRandom trips on jsdom's Buffer
const session = { mode: "key", address: driverWallet.address, signer: driverWallet } as unknown as Session;

beforeEach(() => localStorage.clear());

describe("pickup position", () => {
  it("uses the fix, snapped to the grid, when there is one", async () => {
    const r = await pickupPosition(PIN, async () => ({ lat: 37_774_949, lon: -122_419_351 }));
    expect(r.mode).toBe("gps");
    expect(r.pos.lat % 300).toBe(0);
  });

  it("falls back to the venue pin only when the fix fails as a GeoError", async () => {
    const r = await pickupPosition(PIN, async () => {
      throw new GeoError("host-callback-missing", "blocked by the app");
    });
    expect(r).toEqual({ pos: PIN, mode: "pin", why: "blocked by the app" });
  });

  it("does not hide an unrelated failure behind the pin", async () => {
    await expect(pickupPosition(PIN, async () => { throw new TypeError("bug"); })).rejects.toThrow("bug");
  });
});

describe("dropoff without a driver fix", () => {
  it("the request QR carries a commitment and no coordinate", () => {
    const { payload, pending } = makeDropoffRequest(7n, DROP);
    const p = decodePayload(payload);
    expect(p.kind).toBe(DROPOFF_REQUEST);
    expect(p.att).toEqual({ orderId: "7", posCommit: pending.posCommit });
    expect(p.pos).toBeUndefined();
    expect(payload).not.toContain(String(DROP.lat));
    expect(pending.posCommit).toBe(positionCommit(DROP.lat, DROP.lon, pending.salt));
    expect(loadPendingRequest(7n)).toEqual(pending); // survives a reload
  });

  it("round trip: the driver signs blind, and the witness is the drop under the request's salt", async () => {
    const { payload, pending } = makeDropoffRequest(7n, DROP);
    const reply = decodePayload(await signDropoffRequest(session, 7n, payload));
    expect(reply.kind).toBe(DROPOFF_DRIVER);
    expect(reply.pos).toBeUndefined();
    expect(reply.att.posCommit).toBe(pending.posCommit);
    expect(verifyTypedData(eip712Domain(), DRIVER_COMMIT_TYPES, reply.att, reply.sig)).toBe(driverWallet.address);

    const { driver, mode } = driverWitness(reply, DROP, loadPendingRequest(7n));
    expect(mode).toBe("pin");
    expect(driver).toEqual({ lat: DROP.lat, lon: DROP.lon, salt: pending.salt });
    expect(positionCommit(driver.lat, driver.lon, driver.salt)).toBe(reply.att.posCommit);
  });

  it("the driver refuses a request for another order", async () => {
    const { payload } = makeDropoffRequest(8n, DROP);
    await expect(signDropoffRequest(session, 7n, payload)).rejects.toThrow(/different order/);
  });

  it("the driver refuses a code that is not a request", async () => {
    await expect(signDropoffRequest(session, 7n, encodePayload("pickup-venue", { orderId: "7" }, "0x"))).rejects.toThrow(/not a customer/);
  });

  it("the customer refuses a reply to a request it has since replaced", async () => {
    const first = makeDropoffRequest(7n, DROP);
    const reply = decodePayload(await signDropoffRequest(session, 7n, first.payload));
    makeDropoffRequest(7n, DROP); // shown a new code; the old one is stale
    expect(() => driverWitness(reply, DROP, loadPendingRequest(7n))).toThrow(/different request/);
  });

  it("a reply with no pending request on this device is refused, not guessed", async () => {
    const { payload } = makeDropoffRequest(7n, DROP);
    const reply = decodePayload(await signDropoffRequest(session, 7n, payload));
    expect(() => driverWitness(reply, DROP, null)).toThrow(/didn't make/);
  });

  it("a GPS handoff still passes the driver's own position through", () => {
    const pos = { lat: 37_784_940, lon: -122_419_400, salt: "9" };
    expect(driverWitness({ att: {}, pos }, DROP, null)).toEqual({ driver: pos, mode: "gps" });
  });
});
