// Offline for the client-side reader:
//  app shell (same-origin)            -> network-first, cache fallback (updates propagate; works offline)
//  manga CDN images (cross-origin)    -> cache-first, version-independent (the downloaded pages; opaque OK)
//  mangacopy API / reader pages       -> network-first, version-independent cache (so a downloaded
//                                        chapter's image list + page HTML are readable offline)
const VERSION = 'v1';
const SHELL = `shell-${VERSION}`, IMG = 'img', DATA = 'data';
const SHELL_FILES = ['./', 'index.html', 'app.js', 'styles.css', 'manifest.webmanifest',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];

const IMG_HOST = /(^|\.)mangafun[a-z]?\.(fun|xyz)$/i;
const DATA_HOST = /(^|\.)(mangacopy\.com|2026copy\.com|copy2000\.online)$/i;

self.addEventListener('install', (e) => e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', (e) => e.waitUntil((async () => {
  const keep = new Set([SHELL, IMG, DATA]);
  for (const k of await caches.keys()) if (!keep.has(k)) await caches.delete(k);
  await self.clients.claim();
})()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) { e.respondWith(networkFirst(req, SHELL, true)); return; }
  if (IMG_HOST.test(url.hostname)) { e.respondWith(cacheFirst(req, IMG)); return; }
  if (DATA_HOST.test(url.hostname)) { e.respondWith(networkFirst(req, DATA, false)); return; }
  // other cross-origin: passthrough
});

async function cacheFirst(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);                 // may be opaque (no-cors image) — still cacheable
    if (res && (res.ok || res.type === 'opaque')) await cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch { return hit || new Response('', { status: 504 }); }
}

async function networkFirst(req, name, navFallback) {
  const cache = await caches.open(name);
  try {
    const res = await fetch(req);
    if (res && res.ok) await cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch {
    const hit = await cache.match(req);
    if (hit) return hit;
    if (navFallback && req.mode === 'navigate') return (await cache.match('index.html')) || new Response('offline', { status: 503 });
    return new Response('', { status: 504 });
  }
}
