// WebView localStorage may not reach disk before Android kills the process.
// A strict IndexedDB commit must finish before a selection is presented as saved.
export function registryStorage(storage, databases = indexedDB) {
  const key = 'sparkle-frames-v1';
  let database;
  function open() {
    database ||= new Promise((resolve, reject) => {
      const request = databases.open('sparkle-frame-registry', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('settings');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {database = null; reject(new Error('Could not open saved frame settings. Retry or free space on this phone.'));};
    });
    return database;
  }
  return {
    async restore() {
      const db = await open();
      const value = await new Promise((resolve, reject) => {
        const request = db.transaction('settings').objectStore('settings').get('registry');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      if (value === undefined) return;
      storage.setItem(key, JSON.stringify(value));
      // The durable registry is authoritative, including an explicit Forget.
      storage.removeItem('sparkle-frame');
    },
    async save(value, signal) {
      signal?.throwIfAborted();
      const db = await open();
      signal?.throwIfAborted();
      await new Promise((resolve, reject) => {
        const transaction = db.transaction('settings', 'readwrite', {durability:'strict'});
        const abort = () => transaction.abort();
        const cleanup = () => signal?.removeEventListener('abort', abort);
        signal?.addEventListener('abort', abort, {once:true});
        transaction.objectStore('settings').put(value, 'registry');
        transaction.oncomplete = () => {cleanup(); resolve();};
        transaction.onabort = () => {
          cleanup();
          reject(signal?.aborted ? signal.reason : new Error('Could not save frame settings. Retry or free space on this phone.'));
        };
      });
    },
  };
}
