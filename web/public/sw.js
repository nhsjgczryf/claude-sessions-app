// Minimal service worker. Its main job is to make the page installable
// as a PWA (Chromium requires a registered SW with a fetch handler);
// it also caches the static shell so the UI chrome still appears
// during transient network loss — though anything terminal-related is
// inherently online-only (it depends on the WebSocket and the API).

// Bump this version string on every static-asset change. The activate
// handler deletes any cache whose key != CACHE, so bumping forces every
// returning visitor to re-fetch the shell (scripts are cache-first and
// would otherwise serve stale JS forever).
const CACHE = 'claude-sessions-shell-v4';
const SHELL = [
  '/',
  '/style.css',
  '/renderer.js',
  '/terminal-search.js',
  '/file-preview.js',
  '/manifest.webmanifest',
  '/icon.svg',
  '/vendor/xterm/xterm/css/xterm.css',
  '/vendor/xterm/xterm/lib/xterm.js',
  '/vendor/xterm/addon-fit/lib/addon-fit.js',
  '/vendor/xterm/addon-web-links/lib/addon-web-links.js',
  '/vendor/xterm/addon-unicode11/lib/addon-unicode11.js',
  '/vendor/xterm/addon-search/lib/addon-search.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Never intercept the API, auth, the proxied /p/* tabs, or WebSocket
  // upgrades — those must always go to the network and reflect live state.
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/p/') ||
    req.headers.get('upgrade') === 'websocket'
  ) {
    return;
  }

  // Network-first for the HTML so updates ship immediately; fall back to
  // cache when offline. For static assets use cache-first since they're
  // versioned by URL (or hashed in node_modules paths).
  if (req.destination === 'document' || url.pathname === '/') {
    event.respondWith(
      fetch(req).then((r) => {
        const copy = r.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return r;
      }).catch(() => caches.match(req).then((r) => r || caches.match('/')))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((r) => {
        if (r && r.status === 200 && r.type === 'basic') {
          const copy = r.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return r;
      });
    })
  );
});
