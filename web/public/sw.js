// FARE PWA service worker. Hashed build assets (content-addressed by Vite)
// are cache-first and safe forever; the HTML shell is network-first so a new
// deploy is visible on next load instead of being stuck behind a stale cache
// entry with no way to invalidate itself.
const CACHE = "fare-shell-v3";
// Precache the ZK prover artifacts: a customer confirms a dropoff by BUILDING a
// proof at the doorstep, which may be a dead-signal spot. Fetch them up front so
// proving works offline rather than failing when it matters. (~2.9 MB, one time.)
const SHELL = [
  "/manifest.webmanifest",
  "/icon.svg",
  "/zk/proximity.wasm",
  "/zk/proximity.zkey",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// ── B4 P2: background push ───────────────────────────────────────────────────
// The venue-node push service region-BROADCASTS order events (it never learns
// which order is yours). This SW filters LOCALLY: the page syncs the set of
// order ids this device is watching into IndexedDB; a push for a watched order
// shows a specific notification, everything else collapses into one quiet
// "activity nearby" nudge. Payload: { orderId, kind }.
function idbGet(key) {
  return new Promise((resolve) => {
    let open;
    try { open = indexedDB.open("fare-push", 1); } catch { return resolve(undefined); }
    open.onupgradeneeded = () => open.result.createObjectStore("kv");
    open.onsuccess = () => {
      try {
        const req = open.result.transaction("kv", "readonly").objectStore("kv").get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(undefined);
      } catch { resolve(undefined); }
    };
    open.onerror = () => resolve(undefined);
  });
}
const PUSH_TEXT = {
  new: (id) => ["New order nearby", `Order #${id} is open for bids`],
  assigned: (id) => ["Driver assigned", `Order #${id} was accepted`],
  pickedup: (id) => ["Picked up 🛵", `Order #${id} is on the way`],
  delivered: (id) => ["Delivered ✅", `Order #${id} was delivered`],
};
self.addEventListener("push", (e) => {
  e.waitUntil((async () => {
    let p = {};
    try { p = e.data ? e.data.json() : {}; } catch { /* opaque */ }
    const id = String(p.orderId ?? "");
    const watched = (await idbGet("watched")) || [];
    if (id && Array.isArray(watched) && watched.includes(id)) {
      const [title, body] = (PUSH_TEXT[p.kind] || ((x) => ["Order update", `Order #${x}`]))(id);
      await self.registration.showNotification(title, { body, tag: `order-${id}`, data: { url: "/" } });
    } else {
      await self.registration.showNotification("Activity nearby", { body: "Open FARE to see new orders", tag: "area", silent: true, data: { url: "/" } });
    }
  })());
});
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || "/";
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of wins) if ("focus" in c) return c.focus();
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Never intercept RPC or cross-origin (fonts handle their own caching)
  if (e.request.method !== "GET" || url.origin !== location.origin) return;

  const isShellDoc = e.request.mode === "navigate" || url.pathname === "/index.html";
  if (isShellDoc) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(
      (hit) =>
        hit ||
        fetch(e.request).then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
    )
  );
});
