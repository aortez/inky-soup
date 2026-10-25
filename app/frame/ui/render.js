import {elements as el} from '../core/dom.js';
import {state} from '../core/state.js';
import {settingIds} from '../core/settings.js';
import {getPhoto} from '../services/frame-client.js';
import {updateBlockReason} from '../core/app-update.js';

export function activity(title, detail = '', error = false, progress = 'none') {
  el.activity.hidden = false;
  el.activity.dataset.error = String(error);
  el['activity-title'].textContent = title;
  el['activity-detail'].textContent = detail;
  el['send-progress'].hidden = progress === 'none';
  el['send-progress'].dataset.state = progress;
  if (progress === 'complete') el['send-progress'].setAttribute('aria-valuenow', '1');
  else el['send-progress'].removeAttribute('aria-valuenow');
}

export function controls() {
  el['app-update'].hidden = !state.updateWorker;
  const updateBlocked = updateBlockReason(state);
  el['reload-app'].disabled = state.updating || Boolean(updateBlocked);
  el['reload-app'].textContent = state.updating ? 'Reloading…' : 'Reload';
  el['app-update-detail'].textContent = state.updating ? 'Saving your draft and opening the new version…'
    : state.updateError || updateBlocked || 'A new version is ready. Reload when you’re ready; your draft will be kept.';
  const working = state.busy || Boolean(state.job);
  el.connect.disabled = !state.session || working || state.connecting;
  el.address.disabled = working || state.connecting;
  el.forget.disabled = working || state.connecting;
  el['pick-photo'].disabled = working || !state.config;
  el['refresh-gallery'].disabled = working || !state.connected;
  for (const button of el.gallery.querySelectorAll('button')) {
    button.disabled = working || state.connecting || !state.connected;
  }
  const existing = state.draft?.sourceFrame === state.frame?.base && state.draft?.sourceFilename;
  const readOnly = Boolean(existing && state.connected && !state.lock?.owned);
  for (const id of settingIds) el[id].disabled = working || readOnly;
  el.send.disabled = working || state.connecting || readOnly || state.processing || !state.prepared || !state.connected;
  el.save.disabled = el.send.disabled;
  el.delete.hidden = !existing;
  el.delete.disabled = working || readOnly || !state.connected;
  el['retry-edit'].disabled = working || !state.connected;
  el['add-photos'].disabled = working || !state.connected;
  el['retry-imports'].disabled = working || !state.connected;
  el.orientation.disabled = working || state.connecting || !state.connected || !state.config?.orientation_supported;
  el['save-orientation'].disabled = el.orientation.disabled || Number(el.orientation.value) === state.config?.rotation_degrees;
  el['send-label'].textContent = state.job ? 'Refreshing…' : state.busy && state.view === 'editor' ? 'Working…' : 'Display this photo';
  el['send-panel'].setAttribute('aria-busy', String(working && state.view === 'editor'));
  el['setup-link'].hidden = working;
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
      button.disabled = state.busy || Boolean(state.job) || state.connecting || !state.connected;
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
