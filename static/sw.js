// Service worker for Jim's admin: shows push notifications and opens the request when tapped.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) {}
  event.waitUntil(self.registration.showNotification(data.title || 'Car Deal Club', {
    body: data.body || 'You have a new message.',
    icon: '/favicon-180.png',
    badge: '/favicon-32.png',
    data: { url: data.url || '/admin/#/admin' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data.url, self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if (c.url.startsWith(self.location.origin + '/admin')) return c.navigate(url).then((w) => w && w.focus());
    return self.clients.openWindow(url);
  }));
});
