// Background push subscription (B4 P2). Opt-in Web Push: subscribe this DEVICE
// (an opaque endpoint) with the venue-node push service, tell it only our coarse
// REGION(s), and sync the set of watched order ids into IndexedDB so the service
// worker can filter locally. The push service never learns which order is ours —
// it broadcasts by region; the SW filters. See docs/NOTIFICATIONS.md.

import { relayPool } from "./pool";

const VAPID_PUBLIC = (import.meta as any).env?.VITE_VAPID_PUBLIC_KEY as string | undefined;
const SUBSCRIBED_KEY = "fare.push.subscribed";

/// Background push is possible only when a VAPID public key is configured and the
/// browser supports Push + service workers. Otherwise the app stays P1
/// (foreground/local) only.
export function pushConfigured(): boolean {
  return !!VAPID_PUBLIC && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export function pushSubscribed(): boolean {
  return localStorage.getItem(SUBSCRIBED_KEY) === "1";
}

function urlB64ToU8(base64: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// Push-service endpoints: discovered venue relays first (region-local, the P2
// design), then the same-origin Cloudflare fallback.
function pushEndpoints(path: string): string[] {
  return [...relayPool().map((b) => `${b}${path}`), `/api/push${path}`];
}

/// Subscribe this device and register our region(s) with the push service.
/// Idempotent — re-call to refresh regions. Returns true if registered.
export async function subscribePush(regions: string[]): Promise<boolean> {
  if (!pushConfigured()) return false;
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToU8(VAPID_PUBLIC!),
    });
  }
  for (const url of pushEndpoints("/subscribe")) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscription: sub, regions }),
      });
      if (res.ok) {
        localStorage.setItem(SUBSCRIBED_KEY, "1");
        return true;
      }
    } catch {
      /* try next endpoint */
    }
  }
  return false;
}

// ── IndexedDB: the watched-order set the SW reads to filter pushes ──────────────
function idbSet(key: string, value: unknown): Promise<void> {
  return new Promise((resolve) => {
    let open: IDBOpenDBRequest;
    try { open = indexedDB.open("fare-push", 1); } catch { return resolve(); }
    open.onupgradeneeded = () => open.result.createObjectStore("kv");
    open.onsuccess = () => {
      try {
        const tx = open.result.transaction("kv", "readwrite");
        tx.objectStore("kv").put(value, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch { resolve(); }
    };
    open.onerror = () => resolve();
  });
}

/// Sync the order ids this device cares about (already role-scoped) so the SW can
/// surface only relevant background pushes.
export async function syncWatched(orderIds: string[]): Promise<void> {
  await idbSet("watched", orderIds);
}
