// Service worker — cache first for core assets, network first for HTML
// Supports push notifications (for future FCM integration) and admin console
const CACHE = 'kmm-portfolio-v2';
const CORE = [
  '/',
  '/index.html',
  '/admin.html',
  '/manifest.json',
  '/admin-manifest.json',
  '/logo.webp',
  '/portrait.jpg',
  '/favicon.ico',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // HTML: network first, fallback to cache
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    e.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req).then(r => r || caches.match('/index.html')))
    );
    return;
  }
  // Static assets: cache first
  e.respondWith(
    caches.match(req).then(cached => cached || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
      return res;
    }))
  );
});

// Push notifications (ready for FCM / server push)
self.addEventListener('push', (e) => {
  let data = { title: 'New message', body: 'You have a new visitor message.', url: '/admin.html' };
  try {
    if (e.data) data = Object.assign(data, e.data.json());
  } catch(err) {
    if (e.data && e.data.text()) data.body = e.data.text();
  }
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'kmm-push-' + (data.tag || Date.now()),
      data: { url: data.url || '/admin.html' },
      vibrate: [150, 80, 150],
      renotify: true,
      requireInteraction: true
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/admin.html';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      for (const c of clients) {
        if (c.url.includes(url) || (url === '/admin.html' && c.url.includes('admin.html'))) {
          c.focus();
          c.postMessage({ type: 'focus-admin' });
          return;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
