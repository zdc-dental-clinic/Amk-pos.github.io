/* ============================================================
   AMK POS — Service Worker (v1.1.0 - PWA Ready)
   Handles: Offline Caching, Background Sync, Push Notifications
   ============================================================ */
const VERSION = 'v1.1.0';
const CACHE_NAME = 'amk-pos-shell-' + VERSION;
const SHELL = ['./', './index.html', './manifest.json'];
const NOTIF_ICON = 'data:image/svg+xml;charset=utf-8,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"%3E%3Crect width="100" height="100" fill="%23FF6B00" rx="20"/%3E%3Ctext x="50" y="50" font-size="60" text-anchor="middle" dominant-baseline="middle" fill="%23ffffff"%3E%F0%9F%8D%94%3C/text%3E%3C/svg%3E';

/* ---------- IndexedDB helpers (For Background Sync) ---------- */
const IDB_NAME = 'amk-pos-sw';
const IDB_VERSION = 1;
const IDB_STORE = 'kv';

function openIDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  try {
    const db = await openIDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch { return null; }
}

async function idbSet(key, value) {
  try {
    const db = await openIDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const req = tx.objectStore(IDB_STORE).put(value, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {}
}

/* ---------- Install & Activate (Caching) ---------- */
self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    try {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(SHELL).catch(() => {});
    } catch {}
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    } catch {}
    await self.clients.claim();
  })());
});

/* ---------- Fetch Strategy (Offline Resilience) ---------- */
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;

  const isNav = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  if (isNav) {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE_NAME);
        cache.put('./index.html', fresh.clone()).catch(() => {});
        return fresh;
      } catch {
        const cached = (await caches.match('./index.html')) || (await caches.match('./'));
        return cached || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      }
    })());
    return;
  }

  e.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try {
      const fresh = await fetch(req);
      const len = fresh.headers.get('content-length');
      if (fresh.ok && (!len || +len < 300000)) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(req, fresh.clone()).catch(() => {});
      }
      return fresh;
    } catch {
      return new Response('Offline', { status: 503 });
    }
  })());
});

/* ---------- Web Push ---------- */
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch {}
  const title = data.title || '🍔 AMK POS Alert';
  const body  = data.body  || 'You have a new notification';
  e.waitUntil(self.registration.showNotification(title, {
    body, tag: data.tag || 'amk-push', renotify: true, vibrate: [200, 100, 200],
    data: data.data || { url: './' }, icon: NOTIF_ICON, badge: NOTIF_ICON
  }).catch(() => {}));
});

/* ---------- Notification Click ---------- */
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  const targetUrl = data.url || './';
  e.waitUntil((async () => {
    try {
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const c of clientList) {
        try {
          if ('focus' in c) {
            c.postMessage({ type: 'NOTIFICATION_CLICKED', tag: e.notification.tag, data });
            return c.focus();
          }
        } catch {}
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    } catch {}
  })());
});

/* ---------- Messages from index.html ---------- */
self.addEventListener('message', (e) => {
  const msg = e.data || {};
  if (msg.type === 'SHOW_NOTIFICATION') {
    e.waitUntil((async () => {
      try {
        await self.registration.showNotification(msg.title || 'Alert', {
          body: msg.body || '', tag: msg.tag || 'amk-fg', renotify: true, vibrate: [200, 100, 200],
          data: msg.data || { url: './' }, icon: NOTIF_ICON, badge: NOTIF_ICON
        });
      } catch (err) { console.error('SW Notification Error:', err); }
    })());
  } 
  else if (msg.type === 'SYNC_LOWSTOCK') {
    e.waitUntil((async () => {
      try {
        const state = (await idbGet('state')) || {};
        state.lowStock = Array.isArray(msg.items) ? msg.items : [];
        state.updatedAt = Date.now();
        await idbSet('state', state);
      } catch {}
    })());
  } 
  else if (msg.type === 'SKIP_WAITING') {
    e.waitUntil(self.skipWaiting());
  }
});

/* ---------- Periodic Background Sync ---------- */
self.addEventListener('periodicsync', (e) => {
  if (e.tag !== 'amk-lowstock-check') return;
  e.waitUntil(runBackgroundCheck());
});

async function runBackgroundCheck() {
  try {
    const state = (await idbGet('state')) || {};
    const low = Array.isArray(state.lowStock) ? state.lowStock : [];
    if (!low.length) return;
    const notified = state.notified || {};
    const now = Date.now();
    const HOUR = 3600000;
    const toNotify = [];
    for (const item of low) {
      const key = item.id + ':' + item.severity;
      if (now - (notified[key] || 0) > HOUR) {
        toNotify.push(item);
        notified[key] = now;
      }
    }
    if (!toNotify.length) return;
    state.notified = notified;
    await idbSet('state', state);

    const outs = toNotify.filter(i => i.severity === 'out');
    const lows = toNotify.filter(i => i.severity === 'low');
    let title, body;
    if (outs.length) {
      title = `🚨 ${outs.length} item${outs.length === 1 ? '' : 's'} still OUT OF STOCK`;
      body  = outs.slice(0, 4).map(i => i.name).join(' · ');
    } else {
      title = `⚠️ ${lows.length} item${lows.length === 1 ? '' : 's'} still low`;
      body  = lows.slice(0, 4).map(i => `${i.name}: ${i.stock} ${i.unit}`).join(' · ');
    }
    await self.registration.showNotification(title, {
      body, tag: 'amk-lowstock-bg', renotify: true, vibrate: [200, 100, 200],
      data: { url: './' }, icon: NOTIF_ICON, badge: NOTIF_ICON
    });
  } catch {}
}
