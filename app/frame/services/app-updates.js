import {state} from '../core/state.js';
import {updateBlockReason} from '../core/app-update.js';
import {saveDraft} from './drafts.js';

export async function watchAppUpdates(changed) {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.register('/frame/sw.js', {
    scope: '/frame/', updateViaCache: 'none',
  });
  const inspect = () => {
    // First installation has no old app to replace and needs no notification.
    if (!state.updating && navigator.serviceWorker.controller) {
      if (state.updateWorker !== registration.waiting) state.updateError = '';
      state.updateWorker = registration.waiting;
      changed();
    }
  };
  const watchInstalling = () => {
    registration.installing?.addEventListener('statechange', inspect);
    inspect();
  };
  registration.addEventListener('updatefound', watchInstalling);
  watchInstalling();
  let checking = false;
  const check = async () => {
    inspect();
    if (checking || !navigator.onLine || document.visibilityState !== 'visible') return;
    checking = true;
    try {await registration.update();} catch { /* Keep the cached app usable offline. */ }
    finally {checking = false; inspect();}
  };
  window.addEventListener('online', check);
  document.addEventListener('visibilitychange', check);
  setInterval(check, 5 * 60 * 1000);
}

function activate(worker) {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const finish = error => {
      clearTimeout(timer);
      navigator.serviceWorker.removeEventListener('controllerchange', controlled);
      channel.port1.close();
      if (error) reject(error); else resolve();
    };
    const controlled = () => {
      if (navigator.serviceWorker.controller === worker) finish();
    };
    const timer = setTimeout(() => finish(new Error('The update did not finish. Try Reload again.')), 15000);
    navigator.serviceWorker.addEventListener('controllerchange', controlled);
    channel.port1.onmessage = event => {
      if (event.data?.error) finish(new Error(event.data.error));
    };
    try {worker.postMessage({type: 'APPLY_APP_UPDATE'}, [channel.port2]);}
    catch (error) {finish(error);}
  });
}

export async function reloadApp(changed) {
  if (!state.updateWorker || state.updating || updateBlockReason(state)) return;
  const worker = state.updateWorker;
  state.updating = true; state.busy = true; state.updateError = ''; changed();
  try {
    if (state.draft) {
      try {await saveDraft(state.draft);}
      catch {throw new Error('Your draft could not be saved. Keep this app open and try Reload again.');}
    }
    await activate(worker);
    window.location.reload();
  } catch (error) {
    state.updating = false; state.busy = false; state.updateError = error.message; changed();
  }
}
