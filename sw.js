/**
 * ============================================================================
 * POS AL-KAUTSAR BUMINDO v3.1.0 — SERVICE WORKER (PWA)
 * File: sw.js
 * ============================================================================
 */

const CACHE_NAME = "pos-alkautsar-v3.1.1";

const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./manifest.json",
  "./js/config.js",
  "./js/api.js",
  "./js/auth.js",
  "./js/retail.js",
  "./js/receipt.js",
  "./js/driver_customer.js",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.allSettled(
        STATIC_ASSETS.map((url) =>
          cache.add(new Request(url, { cache: "reload" })).catch(() => null)
        )
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames.map((name) => {
          if (name !== CACHE_NAME) {
            return caches.delete(name);
          }
          return null;
        })
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 1. Jangan pernah cache request non-GET (POST API ke GAS) atau domain Google Apps Script
  if (
    req.method !== "GET" ||
    url.hostname.includes("script.google.com") ||
    url.hostname.includes("script.googleusercontent.com")
  ) {
    return;
  }

  // 2. Untuk navigasi halaman (index.html): Network-First dengan fallback cache
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((networkRes) => {
          const clone = networkRes.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put("./index.html", clone));
          return networkRes;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  // 3. Untuk aset lokal (CSS, JS, ikon): Stale-While-Revalidate
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cachedRes) => {
        const fetchPromise = fetch(req)
          .then((networkRes) => {
            if (networkRes && networkRes.status === 200) {
              const clone = networkRes.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
            }
            return networkRes;
          })
          .catch(() => cachedRes);

        return cachedRes || fetchPromise;
      })
    );
  }
});