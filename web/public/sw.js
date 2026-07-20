// FARE PWA service worker. Hashed build assets (content-addressed by Vite)
// are cache-first and safe forever; the HTML shell is network-first so a new
// deploy is visible on next load instead of being stuck behind a stale cache
// entry with no way to invalidate itself.
const CACHE = "fare-shell-v2";
const SHELL = ["/manifest.webmanifest", "/icon.svg"];

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
