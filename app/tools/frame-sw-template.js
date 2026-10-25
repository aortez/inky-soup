const CACHE = '__CACHE__';
const FILES = __FILES__;
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES)));
});
self.addEventListener('message', event => {
  if (event.data?.type !== 'APPLY_APP_UPDATE' || !event.source || !event.ports[0]) return;
  event.waitUntil((async () => {
    const windows = (await self.clients.matchAll({type: 'window', includeUncontrolled: true}))
      .filter(client => client.url.startsWith(self.registration.scope));
    // Switching versions affects the whole scope. Another window may be saving
    // a photo or using an older app without the update UI, so never interrupt it.
    if (windows.length !== 1 || windows[0].id !== event.source.id) {
      event.ports[0].postMessage({error: 'Close other frame app tabs or windows, then try Reload again.'});
      return;
    }
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith('frame-app-') && name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Photo and API requests go directly to the local frame and are never cached here.
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (event.request.mode === 'navigate' && url.pathname.startsWith('/frame/')) {
    // Keep the shell and processing code on the active worker's version. A new
    // worker takes over after all app windows close; launching never waits on WiFi.
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      return (await cache.match('/frame/index.html', {ignoreVary: true})) || fetch(event.request);
    })());
  } else if (FILES.includes(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      return (await cache.match(event.request, {ignoreVary: true})) || fetch(event.request);
    })());
  }
});
