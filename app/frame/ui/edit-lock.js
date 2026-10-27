import {elements as el} from '../core/dom.js';
import {state} from '../core/state.js';
import {begin, end} from '../core/operations.js';
import {jsonPost} from '../services/frame-client.js';
import {controls} from './render.js';

export async function releaseEditLock(remote = state.connected) {
  const lock = state.lock; state.lock = null;
  if (lock) {
    clearInterval(lock.timer);
    if (remote) await jsonPost(lock.base, '/api/unlock-image', {filename: lock.filename, session_id: state.session}).catch(() => {});
  }
  el['lock-notice'].hidden = true;
}

function showLock(lock, message) {
  if (state.lock !== lock) return;
  el['lock-notice'].hidden = false;
  el['lock-notice'].dataset.readOnly = String(!lock.owned);
  el['lock-status'].textContent = message;
  el['retry-edit'].hidden = lock.owned;
  controls();
}

export async function acquireEditLock() {
  const draft = state.draft;
  if (!state.connected || draft?.sourceFrame !== state.frame?.base || !draft?.sourceFilename) return;
  await releaseEditLock();
  const lock = {base: state.frame.base, filename: draft.sourceFilename, owned: false, refreshing: false};
  state.lock = lock;
  const renew = async (refreshOnly) => {
    if (state.lock !== lock || lock.refreshing) return;
    lock.refreshing = true;
    try {
      const result = await jsonPost(lock.base, '/api/lock-image', {filename: lock.filename, session_id: state.session, refresh_only: refreshOnly});
      if (state.lock !== lock) return;
      lock.owned = result.locked;
      showLock(lock, lock.owned ? 'Editing this photo. Your changes stay on this phone until you save.' : 'Read only: another editor has this photo, or your editing session expired.');
    } catch {
      lock.owned = false;
      showLock(lock, 'Editing connection lost. Your draft is kept on this phone. Reconnect before saving.');
    } finally {lock.refreshing = false;}
    if (!lock.owned) clearInterval(lock.timer);
  };
  await renew(false);
  if (state.lock === lock && lock.owned) lock.timer = setInterval(() => renew(true), 10000);
}

export async function retryEditLock() {
  if (el['retry-edit'].disabled) return;
  begin(state, 'lock'); controls(); await acquireEditLock(); end(state, 'lock'); controls();
}
