async function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('sparkle-frame', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

let pendingSave = Promise.resolve();

export function saveDraft(draft) {
  // Keep rapid edits ordered; the final save before an update must finish last.
  const saved = pendingSave.catch(() => {}).then(() => writeDraft(draft));
  pendingSave = saved;
  return saved;
}

async function writeDraft(draft) {
  const db = await database();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('drafts', 'readwrite');
      tx.objectStore('drafts').put(draft, 'current');
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
  } finally { db.close(); }
}

export async function readDraft() {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('drafts').objectStore('drafts').get('current');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}
