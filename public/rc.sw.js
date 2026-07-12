// webtmux RC service worker — Web Push handler + notification click.
self.addEventListener('push', (e) => {
  const d = (() => { try { return e.data.json(); } catch { return { title: 'webtmux', body: '' }; } })();
  e.waitUntil(self.registration.showNotification(d.title || 'webtmux', {
    body: d.body || '', tag: d.tag, data: { url: d.url || '/rc/' }, badge: '/rc/icons/icon-192.png', icon: '/rc/icons/icon-192.png',
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || '/rc/';
  e.waitUntil(clients.matchAll({ type: 'window' }).then((wins) => {
    for (const w of wins) { if (w.url.includes('/rc') && 'focus' in w) { w.navigate(url); return w.focus(); } }
    return clients.openWindow(url);
  }));
});
