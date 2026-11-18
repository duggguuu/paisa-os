// Paisa service worker: notifications, and a copy of the app so it opens offline.
//
// Pages are network-first: online you always get the latest version; the saved copy is only used
// when there's no connection. Built files under /assets/ have content hashes in their names, so they
// are cached once and reused. Your data (/api/...) is never cached here; the app keeps its own
// offline copy (src/offline.ts) and clears it when you log out.
const SHELL = 'paisa-shell-v1';
const ASSETS = 'paisa-assets-v1';
const KEEP = [SHELL, ASSETS];
const PRECACHE = ['/', '/manifest.webmanifest', '/logo-mark.png', '/icon-192.png', '/apple-touch-icon.png', '/favicon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).catch(() => undefined).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (!KEEP.includes(k)) await caches.delete(k);
  await self.clients.claim();
})()));

async function trimAssets() {
  const c = await caches.open(ASSETS);
  const keys = await c.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - 80))) await c.delete(k); // oldest first
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/ocr/')) return;

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) { const c = await caches.open(SHELL); await c.put('/', res.clone()); }
        return res;
      } catch {
        return (await caches.match('/', { cacheName: SHELL })) || new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } });
      }
    })());
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith((async () => {
      const hit = await caches.match(req, { cacheName: ASSETS });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) { const c = await caches.open(ASSETS); await c.put(req, res.clone()); trimAssets(); }
      return res;
    })());
    return;
  }
  // Icons, manifest and the like: fresh when online, saved copy when not.
  event.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok) { const c = await caches.open(SHELL); await c.put(req, res.clone()); }
      return res;
    } catch {
      return (await caches.match(req, { cacheName: SHELL })) || Response.error();
    }
  })());
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'Paisa', body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Paisa', {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag,
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin) { await w.focus(); return w.navigate(url); }
    }
    return self.clients.openWindow(url);
  })());
});
