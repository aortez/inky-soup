import {androidApp} from '../core/platform.js';
import {elements as el} from '../core/dom.js';
import {state} from '../core/state.js';
import {allowed} from '../core/operations.js';
import {settingIds} from '../core/settings.js';
import {getPhoto} from '../services/frame-client.js';
import {describeUpdate, updateBlockReason} from '../core/app-update.js';

export function activity(title, detail = '', error = false, progress = 'none', target = 'editor') {
  const prefix = target === 'test-card' ? 'test-' : '';
  el[`${prefix}activity`].hidden = false;
  el[`${prefix}activity`].dataset.error = String(error);
  el[`${prefix}activity-title`].textContent = title;
  el[`${prefix}activity-detail`].textContent = detail;
  el[`${prefix}send-progress`].hidden = progress === 'none';
  el[`${prefix}send-progress`].dataset.state = progress;
  if (progress === 'complete') el[`${prefix}send-progress`].setAttribute('aria-valuenow', '1');
  else el[`${prefix}send-progress`].removeAttribute('aria-valuenow');
}

function updateControls() {
  const update = state.update;
  const status = update?.status;
  const installBlocked = updateBlockReason(state, 'Install', 'installing');
  const detail = describeUpdate(update, installBlocked);
  el['app-version'].textContent = state.installed ? `Sparkle Duck ${state.installed.versionName} (build ${state.installed.versionCode})` : 'The app version is unavailable.';
  el['check-updates'].disabled = !state.installed || ['checking', 'downloading', 'installing'].includes(status);
  el['check-updates'].textContent = status === 'checking' ? 'Checking…' : 'Check for updates';
  el['download-update'].hidden = !['available', 'downloading'].includes(status);
  el['download-update'].textContent = status === 'downloading' ? 'Cancel download' : 'Download update';
  el['download-update'].disabled = status === 'downloading' && !update.cancelReady;
  el['install-update'].hidden = !['downloaded', 'installing'].includes(status);
  el['install-update'].disabled = status === 'installing' || Boolean(installBlocked);
  el['update-progress'].hidden = status !== 'downloading';
  el['update-progress'].max = update?.total || update?.release?.apk_size || 1;
  el['update-progress'].value = update?.received || 0;
  el['update-status'].textContent = detail;
  // The banner mirrors Settings so a pending update and its progress are visible from every view.
  el['app-update'].hidden = !['available', 'downloading', 'downloaded', 'installing'].includes(status);
  el['reload-app'].textContent = {downloading: 'Downloading…', downloaded: 'Install', installing: 'Installing…'}[status] || 'Download';
  el['reload-app'].disabled = ['downloading', 'installing'].includes(status) || (status === 'downloaded' && Boolean(installBlocked));
  el['app-update-detail'].textContent = detail;
}

export function controls() {
  if (androidApp) updateControls();
  else {
    el['app-update'].hidden = !state.updateWorker;
    const updateBlocked = updateBlockReason(state);
    el['reload-app'].disabled = state.updating || Boolean(updateBlocked);
    el['reload-app'].textContent = state.updating ? 'Reloading…' : 'Reload';
    el['app-update-detail'].textContent = state.updating ? 'Saving your draft and opening the new version…'
      : state.updateError || updateBlocked || 'A new version is ready. Reload when you’re ready; your draft will be kept.';
  }
  const can = name => allowed(state, name);
  // A display job holds back connecting until its frame is lost. Android then
  // follows the job by connecting again, or by setting the frame up again; the
  // website checks the job's status instead.
  const androidConnect = state.connected ? 'connect' : 'reconnect';
  el['frame-picker'].disabled = !can('select-frame');
  el['discover-frames'].disabled = !can('discover');
  for (const button of el['nearby-frames'].querySelectorAll('button')) button.disabled = !can('connect');
  el['frame-recovery'].hidden = !androidApp || state.connected;
  el.connect.disabled = !state.session || !can(androidApp ? androidConnect : 'connect');
  el.address.disabled = !can('connect');
  el.forget.disabled = !can('forget');
  el['pick-photo'].disabled = !can('choose') || !state.config;
  el['refresh-gallery'].disabled = !can('refresh') || !state.connected;
  for (const button of el.gallery.querySelectorAll('button')) {
    button.disabled = !can('open') || !state.connected;
  }
  const existing = state.draft?.sourceFrame === state.frame?.base && state.draft?.sourceFilename;
  const readOnly = Boolean(existing && state.connected && !state.lock?.owned);
  for (const id of settingIds) el[id].disabled = !can('adjust') || readOnly;
  el.photo_rotation_degrees.disabled ||= !state.config?.photo_rotation_supported;
  el['test-orientation'].disabled = !can('test-card') || !state.connected || !state.config?.orientation_test_supported || Number(el.orientation.value) !== state.config?.rotation_degrees;
  el.send.disabled = !can('store') || readOnly || !state.prepared || !state.connected;
  el.save.disabled = el.send.disabled;
  el.delete.hidden = !existing;
  el.delete.disabled = !can('delete') || readOnly || !state.connected;
  el['retry-edit'].disabled = !can('lock') || !state.connected;
  el['add-photos'].disabled = !can('import') || !state.connected;
  el['retry-imports'].disabled = !can('import') || !state.connected;
  el.orientation.disabled = !can('orientation') || !state.connected || !state.config?.orientation_supported;
  el['save-orientation'].disabled = el.orientation.disabled || Number(el.orientation.value) === state.config?.rotation_degrees;
  el['send-label'].textContent = state.job ? 'Refreshing…' : state.busy && state.view === 'editor' ? 'Working…' : 'Display this photo';
  el['send-panel'].setAttribute('aria-busy', String((state.busy || Boolean(state.job)) && state.view === 'editor'));
  el['setup-link'].hidden = androidApp || !can('setup');
  el['add-frame'].hidden = !androidApp;
  el['add-frame'].disabled = !state.session || !can(androidConnect);
  el['preview-profile'].hidden = !androidApp || state.connected;
  for (const id of ['preview-model', 'preview-layout']) el[id].disabled = !can('preview-profile') || state.connected;
}

export function showView(view) {
  state.view = view;
  el['editor-panel'].hidden = view !== 'editor';
  el['gallery-panel'].hidden = view !== 'gallery';
  el['settings-panel'].hidden = view !== 'settings';
  for (const [id, value] of [['choose-tab', 'editor'], ['gallery-tab', 'gallery'], ['settings-tab', 'settings']]) {
    if (value === view) el[id].setAttribute('aria-current', 'page');
    else el[id].removeAttribute('aria-current');
  }
}

export async function renderGallery(select) {
  const base = state.frame?.base;
  const generation = (state.galleryGeneration || 0) + 1;
  state.galleryGeneration = generation;
  for (const url of state.galleryUrls) URL.revokeObjectURL(url);
  state.galleryUrls = [];
  el.gallery.replaceChildren();
  el['gallery-empty'].hidden = Boolean(state.images.length);
  el['gallery-empty'].textContent = 'Your first photo belongs here. Choose one in Create.';
  // Load thumbnails in small batches so a large library does not overwhelm a Pi Zero.
  const entries = state.images.slice().reverse();
  for (let start = 0; start < entries.length; start += 4) {
    if (state.frame?.base !== base || state.galleryGeneration !== generation) return;
    await Promise.all(entries.slice(start, start + 4).map(async image => {
      const button = document.createElement('button');
      const picture = document.createElement('img');
      picture.alt = ''; picture.loading = 'lazy';
      const label = document.createElement('span'); label.textContent = image.filename;
      button.disabled = !allowed(state, 'open') || !state.connected;
      button.append(picture, label); button.addEventListener('click', () => select(image, base));
      el.gallery.append(button);
      try {
        if (!image.thumb_ready) return;
        const blob = await getPhoto(base, image.filename, true);
        if (state.frame?.base !== base || state.galleryGeneration !== generation || !button.isConnected) return;
        const url = URL.createObjectURL(blob); state.galleryUrls.push(url); picture.src = url;
      } catch { picture.alt = 'Preview unavailable'; }
    }));
  }
}

export function renderPreview() {
  el.preview.src = state.previewMode === 'before' ? state.beforeUrl : state.previewUrl;
  el.preview.alt = state.previewMode === 'before' ? 'Adjusted photo before dithering' : 'Preview of the display colors';
  el['preview-before'].setAttribute('aria-pressed', String(state.previewMode === 'before'));
  el['preview-display'].setAttribute('aria-pressed', String(state.previewMode === 'display'));
}

export function renderImports() {
  el.imports.hidden = !state.imports.length;
  const completed = state.imports.filter(item => item.status === 'Saved').length;
  const failed = state.imports.filter(item => item.error).length;
  el['import-heading'].textContent = state.imports.some(item => item.regenerate) ? 'Updating orientation' : 'Adding photos';
  el['import-summary'].textContent = `${completed} of ${state.imports.length} saved${failed ? ` · ${failed} failed` : ''}. Photos are saved without refreshing the display.`;
  el['import-progress'].max = state.imports.length || 1;
  el['import-progress'].value = completed + failed;
  el['retry-imports'].hidden = !failed || state.importing;
  el['import-list'].replaceChildren(...state.imports.map(item => {
    const row = document.createElement('li');
    const name = document.createElement('span'); name.textContent = item.draft.name;
    const status = document.createElement('small'); status.textContent = item.error || item.status;
    row.dataset.error = String(Boolean(item.error)); row.append(name, status); return row;
  }));
}
