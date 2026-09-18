// The Polkadot app host — the fourth runtime (docs/POLKADOT-PLATFORM-PLAN.md §4.7).
//
// Everything here is optional. Outside the app every function reports "no host"
// and the caller keeps its existing path (Cloudflare KV, venue relays, the
// browser's own permission prompt), so the PWA and dev-dot.li builds behave
// exactly as before.
//
// Host calls can stall rather than reject (S1: an upload hung 180 s with no
// error), so nothing crosses to the host without a deadline.

import {
  formatHostError,
  getPreimageManager,
  isInsideContainer,
  requestDevicePermission,
  requestPermission,
  requestResourceAllocation,
  type PreimageManager,
} from "@parity/product-sdk-host";

/// Container detection is a message round-trip; outside the app nobody answers.
const DETECT_MS = 1_500;

let inside: Promise<boolean> | null = null;

/// True when running as a Product inside the Polkadot app (mobile or Desktop).
export function inHost(): Promise<boolean> {
  return (inside ??= withTimeout(isInsideContainer(), DETECT_MS, "host detection").catch(() => false));
}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no answer in ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// ── location ────────────────────────────────────────────────────────────────

/// What the host said when asked for Location. `"no-host"` outside the app.
export type HostLocationGrant = "granted" | "declined" | "error" | "no-host";

let locationAsked: Promise<HostLocationGrant> | null = null;

/// Ask the host for the device Location permission, once a session.
///
/// Issue #7: in the Android WebView, navigator.geolocation fails "User denied"
/// with the permission left at `prompt` — the host never answers the WebView's
/// callback. truapi declares `requestDevicePermission("Location")`, which may be
/// the intended route. Whether granting it unblocks the web API is what sonde's
/// `host.permissions.location` measures; this calls it either way, because it
/// costs one prompt and a grant can only help.
export function askHostLocation(): Promise<HostLocationGrant> {
  return (locationAsked ??= (async (): Promise<HostLocationGrant> => {
    if (!(await inHost())) return "no-host";
    try {
      const r = await withTimeout(requestDevicePermission("Location"), ASK_MS, "location permission");
      if (!r.ok) {
        console.warn("host Location permission:", formatHostError(r.error));
        return "error";
      }
      return r.value ? "granted" : "declined";
    } catch (e) {
      console.warn("host Location permission:", e);
      return "error";
    }
  })());
}

// ── Bulletin, through the host ──────────────────────────────────────────────

/// Asking the user: long enough to read a prompt and tap it.
const ASK_MS = 60_000;
/// almanac P6c: 1 MiB took 41 s on a phone. A delivery photo is ~3 KiB.
const PUT_MS = 120_000;
/// almanac P7: a blob the host holds comes back in under a second.
const GET_MS = 30_000;

let preimages: Promise<PreimageManager> | null = null;

/// The host's preimage manager, with the Bulletin allowance and the
/// `PreimageSubmit` permission requested first.
///
/// Not `cloudStorage.upload`: that signs with the product account, which holds
/// no Bulletin authorization, and is refused `Invalid: Payment` (almanac P6).
/// The allowance lands on a slot account only the host can sign with, and this
/// is the call that asks the host to sign (almanac P6b, measured 2026-09-16).
function openPreimages(): Promise<PreimageManager> {
  return (preimages ??= (async () => {
    if (!(await inHost())) throw new Error("not inside the Polkadot app");
    // Each step has a deadline: a host on another wire codec never answers at all (sonde,
    // 2026-09-18), and a caller waiting here would never reach its relay fallback.
    // The type spells it "BulletInAllowance", which throws; only this spelling allocates (sonde).
    await withTimeout(requestResourceAllocation([{ tag: "BulletinAllowance", value: undefined } as never]), ASK_MS, "Bulletin allowance");
    const permission = await withTimeout(requestPermission({ tag: "PreimageSubmit", value: undefined }), ASK_MS, "storage permission");
    if (!permission.ok) throw new Error(`storage permission: ${formatHostError(permission.error)}`);
    if (!permission.value) throw new Error("the Polkadot app did not allow FARE to store data");
    const manager = await withTimeout(getPreimageManager(), DETECT_MS * 4, "storage manager");
    if (!manager) throw new Error("this Polkadot app offers no storage");
    return manager;
  })()).catch((e: unknown) => {
    preimages = null;
    throw e;
  });
}

/// Store bytes on Bulletin through the host. Returns the BLAKE2b-256 key as hex —
/// the host's lookup finds BLAKE2b content only (almanac P7). Lasts ~2 weeks.
export async function hostPut(bytes: Uint8Array): Promise<string> {
  const manager = await openPreimages();
  return withTimeout(manager.submit(bytes), PUT_MS, "Bulletin upload");
}

/// Fetch bytes by the key hostPut returned; null when not found in time.
export async function hostGet(key: string): Promise<Uint8Array | null> {
  const manager = await openPreimages();
  // The host answers a lookup with a subscription that stays silent until it has the bytes.
  return new Promise((resolve) => {
    let done = false;
    let sub: { unsubscribe(): void } | undefined;
    const finish = (v: Uint8Array | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        sub?.unsubscribe();
      } catch {
        /* already gone */
      }
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), GET_MS);
    try {
      sub = manager.lookup((key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`, (bytes) => bytes && finish(bytes));
    } catch {
      finish(null);
    }
  });
}

/// For tests: forget cached detection and grants.
export function _resetHostForTests(): void {
  inside = null;
  locationAsked = null;
  preimages = null;
}
