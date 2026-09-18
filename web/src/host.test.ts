import { describe, it, expect, beforeEach, vi } from "vitest";

// The host SDK talks to a container over postMessage; here it is replaced by a
// hand-driven double so each test decides whether we are "inside the app".
const sdk = vi.hoisted(() => ({
  inside: false,
  locationGrant: { ok: true, value: true } as { ok: boolean; value?: boolean; error?: unknown },
  submitted: [] as Uint8Array[],
  submitFails: false,
  stored: new Map<string, Uint8Array>(),
  deviceCalls: [] as string[],
}));

vi.mock("@parity/product-sdk-host", () => ({
  isInsideContainer: async () => sdk.inside,
  formatHostError: (e: unknown) => String(e),
  requestDevicePermission: async (kind: string) => {
    sdk.deviceCalls.push(kind);
    return sdk.locationGrant;
  },
  requestResourceAllocation: async () => ({ ok: true, value: ["Allocated"] }),
  requestPermission: async () => ({ ok: true, value: true }),
  getPreimageManager: async () => ({
    submit: async (bytes: Uint8Array) => {
      if (sdk.submitFails) throw new Error("Invalid: Payment");
      sdk.submitted.push(bytes);
      const key = `0x${String(sdk.submitted.length).padStart(64, "0")}`;
      sdk.stored.set(key, bytes);
      return key;
    },
    lookup: (key: string, cb: (b: Uint8Array | null) => void) => {
      queueMicrotask(() => cb(sdk.stored.get(key) ?? null));
      return { unsubscribe() {} };
    },
  }),
}));

import { _resetHostForTests, askHostLocation, inHost } from "./host";
import { classifyGeoError, getPosition, GeoError } from "./geo";
import { BULLETIN_PREFIX, fetchSealed, storeSealed } from "./photoflow";

function geoErr(code: number, message = "x"): GeolocationPositionError {
  return { code, message, PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 } as GeolocationPositionError;
}

function setPermissionState(state: PermissionState) {
  (navigator as any).permissions = { query: async () => ({ state }) };
}

function setGeolocation(impl: (ok: PositionCallback, fail: PositionErrorCallback) => void) {
  (navigator as any).geolocation = { getCurrentPosition: impl, watchPosition: vi.fn(), clearWatch: vi.fn() };
}

beforeEach(() => {
  _resetHostForTests();
  sdk.inside = false;
  sdk.locationGrant = { ok: true, value: true };
  sdk.submitted = [];
  sdk.submitFails = false;
  sdk.stored.clear();
  sdk.deviceCalls = [];
});

describe("geolocation failures say whose fault they are", () => {
  it("denied while the permission is still `prompt` is the host's missing callback (issue #7)", async () => {
    setPermissionState("prompt");
    const e = await classifyGeoError(geoErr(1, "User denied Geolocation"));
    expect(e.reason).toBe("host-callback-missing");
  });

  it("denied with the permission `denied` is the user's refusal", async () => {
    setPermissionState("denied");
    expect((await classifyGeoError(geoErr(1))).reason).toBe("denied");
  });

  it("a timeout is a timeout, whatever the permission says", async () => {
    setPermissionState("prompt");
    expect((await classifyGeoError(geoErr(3))).reason).toBe("timeout");
  });
});

describe("the host's Location permission", () => {
  it("is not asked for outside the app", async () => {
    expect(await askHostLocation()).toBe("no-host");
    expect(sdk.deviceCalls).toEqual([]);
  });

  it("is asked for once, before the first fix, inside the app", async () => {
    sdk.inside = true;
    const order: string[] = [];
    setGeolocation((ok) => {
      order.push(`gps after ${sdk.deviceCalls.length} host call(s)`);
      ok({ coords: { latitude: 1.5, longitude: -2.25 } } as GeolocationPosition);
    });
    expect(await getPosition()).toEqual({ lat: 1_500_000, lon: -2_250_000 });
    await getPosition();
    expect(sdk.deviceCalls).toEqual(["Location"]);
    expect(order[0]).toBe("gps after 1 host call(s)");
  });

  it("a host that declines still lets the web API decide, and the failure is classified", async () => {
    sdk.inside = true;
    sdk.locationGrant = { ok: true, value: false };
    setPermissionState("prompt");
    setGeolocation((_ok, fail) => fail(geoErr(1, "User denied Geolocation")));
    const e = await getPosition().catch((x) => x);
    expect(e).toBeInstanceOf(GeoError);
    expect(e.reason).toBe("host-callback-missing");
    expect(await askHostLocation()).toBe("declined");
  });
});

describe("delivery photos inside the app go to Bulletin", () => {
  const sealed = { iv: "aXY=", ct: "Y3Q=" };

  it("stores through the host and reads back by the prefixed key", async () => {
    sdk.inside = true;
    const id = await storeSealed(sealed);
    expect(id.startsWith(BULLETIN_PREFIX)).toBe(true);
    expect(sdk.submitted).toHaveLength(1);
    expect(await fetchSealed(id)).toEqual(sealed);
  });

  it("falls back to the relays when the host upload fails", async () => {
    sdk.inside = true;
    sdk.submitFails = true;
    (globalThis as any).fetch = vi.fn(async () => new Response(JSON.stringify({ id: "kv-1" }), { status: 200 }));
    expect(await storeSealed(sealed)).toBe("kv-1");
  });

  it("outside the app, never touches the host", async () => {
    (globalThis as any).fetch = vi.fn(async () => new Response(JSON.stringify({ id: "kv-2" }), { status: 200 }));
    expect(await inHost()).toBe(false);
    expect(await storeSealed(sealed)).toBe("kv-2");
    expect(sdk.submitted).toHaveLength(0);
  });

  it("a Bulletin id opened outside the app says where to open it", async () => {
    await expect(fetchSealed(`${BULLETIN_PREFIX}0xabc`)).rejects.toThrow(/Polkadot app/);
  });
});

describe("a host that never answers", () => {
  it("does not hold a photo hostage: the upload falls back to the relays", async () => {
    vi.useFakeTimers();
    try {
      sdk.inside = true;
      const never = new Promise<never>(() => {});
      const mod = await import("@parity/product-sdk-host");
      const spy = vi.spyOn(mod, "requestResourceAllocation").mockReturnValue(never as any);
      (globalThis as any).fetch = vi.fn(async () => new Response(JSON.stringify({ id: "kv-3" }), { status: 200 }));
      const stored = storeSealed({ iv: "aXY=", ct: "Y3Q=" });
      await vi.advanceTimersByTimeAsync(61_000);
      expect(await stored).toBe("kv-3");
      spy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });
});
