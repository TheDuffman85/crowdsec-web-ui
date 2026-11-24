/*
 * Service worker for the installed app and Web Push.
 * It caches only the offline page: no API response or page that shows data is ever stored.
 */
const CACHE = 'shell-v1';
const OFFLINE_URL = './offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add(OFFLINE_URL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE_URL)));
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'Notification';
  event.waitUntil(self.registration.showNotification(title, {
    body: typeof data.body === 'string' ? data.body : '',
    icon: './android-chrome-192x192.png',
    badge: './favicon-96x96.png',
    tag: typeof data.tag === 'string' ? data.tag : undefined,
    requireInteraction: data.severity === 'critical',
    data: { url: typeof data.url === 'string' ? data.url : '' },
  }));
});

/** Only paths inside this app are opened, whatever the message says. */
function targetUrl(path) {
  const clean = typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') ? path.slice(1) : '';
  return new URL(clean, self.registration.scope).href;
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = targetUrl(event.notification.data && event.notification.data.url);
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const existing = windows.find((client) => client.url.startsWith(self.registration.scope));
      if (existing) return existing.navigate(url).then((client) => client && client.focus());
      return self.clients.openWindow(url);
    }),
  );
});
