self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let payload = { title: 'Upkeep', body: 'You have pending tasks.', taskId: null };
  try { payload = event.data.json(); } catch (e) {}

  const actions = [{ action: 'later', title: 'Later' }];
  if (payload.taskId) actions.unshift({ action: 'done', title: 'Mark done' });

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: 'upkeep-nudge',
      renotify: true,
      data: { taskId: payload.taskId },
      actions
    })
  );
});

self.addEventListener('notificationclick', event => {
  const taskId = event.notification.data && event.notification.data.taskId;
  event.notification.close();

  if (event.action === 'done' && taskId) {
    event.waitUntil(fetch('/api/tasks/' + taskId + '/complete', { method: 'POST' }));
    return;
  }
  if (event.action === 'later') {
    event.waitUntil(fetch('/api/dismiss', { method: 'POST' }));
    return;
  }
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(list => {
      for (const c of list) { if ('focus' in c) return c.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow('/');
    })
  );
});
