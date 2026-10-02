// Offline support: the app shell is cached; timetable data is fetched fresh when
// online and falls back to the last copy when not (e.g. in a basement lecture hall).
const CACHE = 'orar-v2';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'core.js', 'manifest.webmanifest', 'icon.svg', 'icon-180.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Network first for everything, so updates show up immediately; cache is the fallback.
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});

// Morning summary sent by .github/workflows/morning.yml
self.addEventListener('push', e => {
  let msg = { title: 'Orar', body: '' };
  try { msg = e.data.json(); } catch { if (e.data) msg.body = e.data.text(); }
  e.waitUntil(self.registration.showNotification(msg.title, { body: msg.body, icon: 'icon-180.png', tag: msg.tag || 'orar', data: { url: msg.url || './' } }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const open = list.find(c => c.url.startsWith(self.registration.scope));
    return open ? open.focus() : self.clients.openWindow(e.notification.data?.url || './');
  }));
});
