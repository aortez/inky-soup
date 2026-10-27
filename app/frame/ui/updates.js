import {androidApp} from '../core/platform.js';
import {state} from '../core/state.js';
import {allowed} from '../core/operations.js';
import {updateCheckDue, rememberUpdateCheck, rememberedRelease, resolveUpdate} from '../core/app-update.js';
import {reloadApp} from '../services/app-updates.js';
import {saveDraft} from '../services/drafts.js';
import {installedApp, checkForUpdate, downloadUpdate, installUpdate, cancelDownload} from '../services/native-updates.js';
import {controls} from './render.js';

// The last answer still describes a pending or already downloaded release without the network.
function rememberedUpdate() {
  const remembered = rememberedRelease(localStorage);
  const result = remembered && state.installed && resolveUpdate(state.installed, remembered);
  return result && ['available', 'downloaded'].includes(result.status) ? result : null;
}

export async function checkForUpdates({automatic = false} = {}) {
  if (!state.updates || !state.installed || ['checking', 'downloading', 'installing'].includes(state.update?.status)) return;
  if (automatic && (!updateCheckDue(localStorage) || !navigator.onLine)) {
    if (!state.update) state.update = rememberedUpdate();
    controls(); return;
  }
  const previous = state.update;
  state.update = {status: 'checking'}; controls();
  try {
    const result = await checkForUpdate(state.updates);
    rememberUpdateCheck(localStorage, result.release);
    state.installed = result.installed;
    state.update = automatic && result.status === 'current' ? null : result;
  } catch (error) {
    // A failed check never hides a release that was already offered or downloaded; manual checks report the problem.
    const remembered = rememberedUpdate();
    if (automatic) state.update = previous || remembered;
    else state.update = remembered ? {...remembered, error: error.message} : {status: 'error', error: error.message};
  } finally {controls();}
}

export async function startDownload() {
  const update = state.update;
  if (update?.status === 'downloading') {if (update.cancelReady) await cancelDownload(state.updates); return;}
  if (update?.status !== 'available') return;
  Object.assign(update, {status: 'downloading', received: 0, total: update.release.apk_size, error: '', cancelReady: false}); controls();
  // A second tap right after starting is more likely a double tap than a cancellation.
  setTimeout(() => {if (state.update === update && update.status === 'downloading') {update.cancelReady = true; controls();}}, 600);
  try {
    await downloadUpdate(state.updates, update.release, (received, total) => {
      if (state.update !== update) return;
      update.received = received; update.total = total; controls();
    });
    if (state.update !== update) return;
    update.status = 'downloaded';
  } catch (error) {
    if (state.update !== update) return;
    update.status = 'available'; update.error = error.message;
  } finally {controls();}
}

export async function startInstall() {
  const update = state.update;
  if (update?.status !== 'downloaded' || !allowed(state, 'update')) return;
  Object.assign(update, {status: 'installing', error: '', notice: ''}); controls();
  let status = 'downloaded';
  try {
    // Android replaces the process, so unsaved work is written before the installer opens.
    if (state.draft) await saveDraft(state.draft);
    const outcome = await installUpdate(state.updates, update.release);
    update.notice = outcome === 'permission'
      ? 'Allow Sparkle Duck to install updates in Android Settings, then tap Install again.'
      : 'Confirm the update in the Android installer. The app reopens as the new version.';
  } catch (error) {
    update.error = error.message;
    // A missing or rejected package goes back to a downloadable release instead of a stuck Install.
    try {state.installed = await installedApp(state.updates);} catch { /* Keep the last known description. */ }
    const resolved = resolveUpdate(state.installed, update.release);
    status = resolved.status; update.reason = resolved.reason;
  } finally {if (state.update === update) update.status = status; controls();}
}

// The banner reloads the website into its waiting version, or downloads and then
// installs an Android release.
export function applyUpdate() {
  if (!androidApp) return reloadApp(controls);
  return state.update?.status === 'downloaded' ? startInstall() : startDownload();
}
