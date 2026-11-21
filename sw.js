// Кэш только статики приложения. Запросы к Supabase всегда идут в сеть.
const CACHE = 'adal-crm-v5';
const ASSETS = ['./', 'index.html', 'style.css?v=3', 'app.js?v=5', 'config.js?v=2', 'vendor/supabase.js', 'manifest.webmanifest', 'icons/icon-192.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  // публичная форма заявки — всегда напрямую из сети, без кэша и подмены на index.html
  if (u.pathname.endsWith('/zayavka.html')) return;
  // network-first, чтобы обновления приходили сразу; кэш — когда нет сети
  e.respondWith(fetch(e.request).then(r => { const cp = r.clone(); caches.open(CACHE).then(c => c.put(e.request, cp)); return r; })
    .catch(() => caches.match(e.request).then(r => r || caches.match('index.html'))));
});
