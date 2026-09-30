// Paketshop service worker — basic offline shell + network-first for API
const CACHE_NAME = 'paketshop-v2';
const STATIC_ASSETS = ['/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // API and streaming — always network (no caching of dynamic data)
  if (url.pathname.startsWith('/api/')) return;

  // Pages: network-first so a new deploy is never masked by a stale cached index.html
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => new Response('Offline', { status: 503 })));
    return;
  }

  // Static assets — cache-first, but never store an HTML fallback in place of a JS/CSS file
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        const type = res.headers.get('content-type') || '';
        if (res.ok && url.origin === self.location.origin && !type.includes('text/html')) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      }).catch(() => cached || new Response('Offline', { status: 503 }));
    })
  );
});
