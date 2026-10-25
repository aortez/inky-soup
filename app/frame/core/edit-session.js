function reserveSession(session) {
  return new Promise((resolve, reject) => {
    navigator.locks.request(`sparkle-edit-session:${session}`, {ifAvailable: true}, lock => {
      resolve(Boolean(lock));
      // The browser releases this reservation when the document is destroyed.
      if (lock) return new Promise(() => {});
    }).catch(reject);
  });
}

export async function editSession() {
  let session = crypto.randomUUID();
  let reserved = false;
  try {
    if (navigator.locks?.request) {
      // Duplicated tabs and opener windows inherit sessionStorage. Reuse a stored
      // identity only when no live document is using it (including on reload).
      let stored;
      try {stored = sessionStorage.getItem('sparkle-edit-session');} catch { /* Storage is optional. */ }
      session = stored || session;
      while (!await reserveSession(session)) session = crypto.randomUUID();
      reserved = true;
    }
  } catch {
    // Without coordination, a new identity is safer than sharing edit access.
    session = crypto.randomUUID();
  }
  try {
    if (reserved) sessionStorage.setItem('sparkle-edit-session', session);
    else sessionStorage.removeItem('sparkle-edit-session');
  } catch { /* Storage is optional. */ }
  return session;
}
