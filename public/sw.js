// App-shell service worker. Caches static assets so the PWA installs and the
// UI loads instantly/offline. It never touches /api (must be live) or /ws
// (a WebSocket — not interceptable here anyway).
const VERSION = 'webtmux-v47';
const SHELL = [
  '/',
  '/term',
  '/css/style.css',
  '/js/dashboard.js',
  '/js/dashboard/sessions.js',
  '/js/dashboard/ralph.js',
  '/js/term.js',
  '/vendor/xterm.js',
  '/vendor/xterm.css',
  '/vendor/addon-fit.js',
  '/vendor/qrcode.min.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // Live data and sockets always go straight to the network.
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/ws') || url.pathname === '/healthz') return;

  // Navigations: network-first so updates land, cache as offline fallback.
  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request)
        .then((res) => { update(request, res.clone()); return res; })
        .catch(() => caches.match(request).then((c) => c || caches.match('/')))
    );
    return;
  }

  // Our own app code (JS/CSS) is network-first so an update always lands and the
  // HTML never ends up paired with a stale script; cache is the offline fallback.
  const isAppCode = url.origin === self.location.origin
    && /\.(js|css)$/.test(url.pathname) && !url.pathname.startsWith('/vendor/');
  if (isAppCode) {
    e.respondWith(
      fetch(request).then((res) => { update(request, res.clone()); return res; })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Everything else (vendor libs, icons): cache-first, refresh in background.
  e.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request).then((res) => { update(request, res.clone()); return res; }).catch(() => cached);
      return cached || network;
    })
  );
});

function update(request, res) {
  if (res && res.ok) caches.open(VERSION).then((c) => c.put(request, res));
}

// --- Web Push ---------------------------------------------------------------
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'webtmux', {
    body: d.body || '',
    tag: d.tag || undefined,
    data: { url: d.url || '/' },
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
  }));
});

// Focus an existing window (navigating it to the target) or open a new one.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cl) => {
    for (const c of cl) {
      if ('focus' in c) { if ('navigate' in c) c.navigate(url); return c.focus(); }
    }
    return self.clients.openWindow(url);
  }));
});
