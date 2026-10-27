import './style.css';
import {androidApp} from './core/platform.js';
import {savedPreviewConfig} from './core/preview-profile.js';
import {elements as el} from './core/dom.js';
import {state, sessionReady, savedFrame, restoreRegistry} from './core/state.js';
import {settingIds} from './core/settings.js';
import {normalizeAddress, validateConfig} from './services/frame-client.js';
import {saveDraft, readDraft} from './services/drafts.js';
import {watchAppUpdates} from './services/app-updates.js';
import {installedApp} from './services/native-updates.js';
import {activity, controls, showView, renderPreview} from './ui/render.js';
import {acquireEditLock, retryEditLock} from './ui/edit-lock.js';
import {useDraft, prepare, adjustDraft, choosePreviewProfile} from './ui/editor.js';
import {refreshGallery, importPhotos, regenerateGallery, runImports, chooseFiles} from './ui/gallery.js';
import {pollJob} from './ui/jobs.js';
import {storeCurrentPhoto, deleteCurrentPhoto} from './ui/save.js';
import {syncOrientation, previewOrientation, changeOrientation, testOrientation} from './ui/orientation.js';
import {renderFrames, connectFrame, reconnect, checkConnection, connectOnline, markOffline, selectFrame, findNearbyFrames, forgetFrame} from './ui/connection.js';
import {checkForUpdates, startDownload, startInstall, applyUpdate} from './ui/updates.js';

el['connect-form'].addEventListener('submit', event => {event.preventDefault(); connectFrame({automatic:Boolean(state.job)});});
el['frame-picker'].addEventListener('change', selectFrame);
el['discover-frames'].addEventListener('click', findNearbyFrames);
el['reload-app'].addEventListener('click', applyUpdate);
el['check-updates'].addEventListener('click', () => checkForUpdates());
el['download-update'].addEventListener('click', startDownload);
el['install-update'].addEventListener('click', startInstall);
el['pick-photo'].addEventListener('click', () => el.photo.click());
el.photo.addEventListener('change', async () => {
  const files = [...el.photo.files]; el.photo.value = ''; await chooseFiles(files);
});
for (const id of settingIds) el[id].addEventListener('change', () => adjustDraft(id));
for (const id of ['saturation', 'brightness', 'contrast']) el[id].addEventListener('input', () => {el[`${id}-value`].value = el[id].value;});
el.send.addEventListener('click', () => storeCurrentPhoto(true));
el.save.addEventListener('click', () => storeCurrentPhoto(false));
el['settings-tab'].addEventListener('click', () => showView('settings'));
for (const id of ['preview-model', 'preview-layout']) el[id].addEventListener('change', choosePreviewProfile);
el.orientation.addEventListener('change', previewOrientation);
el['save-orientation'].addEventListener('click', changeOrientation);
el['test-orientation'].addEventListener('click', testOrientation);
el['test-retry-status'].addEventListener('click', () => androidApp ? reconnect() : pollJob());
el['preview-before'].addEventListener('click', () => {state.previewMode = 'before'; renderPreview();});
el['preview-display'].addEventListener('click', () => {state.previewMode = 'display'; renderPreview();});
el['retry-edit'].addEventListener('click', retryEditLock);
el['add-photos'].addEventListener('click', () => el['import-photos'].click());
el['import-photos'].addEventListener('change', async () => {
  const files = [...el['import-photos'].files]; el['import-photos'].value = '';
  if (files.length) await importPhotos(files);
});
el['retry-imports'].addEventListener('click', runImports);
for (const type of ['dragenter', 'dragover']) el['photo-stage'].addEventListener(type, event => {event.preventDefault(); el['photo-stage'].classList.add('drag-over');});
el['photo-stage'].addEventListener('dragleave', () => el['photo-stage'].classList.remove('drag-over'));
el['photo-stage'].addEventListener('drop', async event => {
  event.preventDefault(); el['photo-stage'].classList.remove('drag-over'); await chooseFiles([...event.dataTransfer.files]);
});
el.delete.addEventListener('click', () => {
  if (el.delete.disabled) return;
  el['delete-name'].textContent = state.draft.name; el['delete-dialog'].showModal();
});
el['cancel-delete'].addEventListener('click', () => el['delete-dialog'].close());
el['confirm-delete'].addEventListener('click', async () => {el['delete-dialog'].close(); await deleteCurrentPhoto();});
el['retry-status'].addEventListener('click', () => androidApp ? reconnect() : state.job ? pollJob() : connectFrame());
el['refresh-gallery'].addEventListener('click', () => refreshGallery().catch(error => {el['gallery-status'].textContent = error.message;}));
el['choose-tab'].addEventListener('click', () => showView('editor'));
el['gallery-tab'].addEventListener('click', () => showView('gallery'));
el.forget.addEventListener('click', forgetFrame);
window.addEventListener('beforeinstallprompt', event => {
  if (androidApp) return;
  event.preventDefault(); state.installPrompt = event; el.install.hidden = false;
});
el.install.addEventListener('click', async () => {
  if (!state.installPrompt) return;
  await state.installPrompt.prompt(); state.installPrompt = null; el.install.hidden = true;
});
window.addEventListener('appinstalled', () => {el.install.hidden = true;});

async function start() {
  await sessionReady;
  let installedReady = Promise.resolve();
  if (androidApp) {
    try {await restoreRegistry();}
    catch (error) {el['connection-status'].textContent = error.message;}
    document.body.classList.add('native-shell');
    el.photo.multiple = false;
    el.connection.hidden = false;
    el['preview-profile'].hidden = false;
    el['settings-heading'].textContent = 'Make it fit.';
    state.config = savedPreviewConfig();
    el['preview-model'].value = state.config.model;
    el['preview-layout'].value = state.config.rotation_degrees === 90 ? 'portrait' : 'landscape';
    el.dimensions.textContent = `${state.config.width} × ${state.config.height}`;
    const [{watchNativeApp}, {setupDialog}, {registerPlugin}] = await Promise.all([
      import('./services/native-app.js'), import('./ui/setup.js'), import('@capacitor/core'),
    ]);
    state.discovery = registerPlugin('FrameDiscovery');
    state.updates = registerPlugin('FrameUpdate');
    el['app-card'].hidden = false;
    // Describing the installed app parses any retained package, so it must not delay the frame connection.
    // A shell without the native plugin shows no version and offers no updates.
    installedReady = installedApp(state.updates).then(installed => {state.installed = installed;}, () => {});
    renderFrames();
    const setup = await setupDialog({bridge: registerPlugin('FrameBle'), connected: async () => {
      await acquireEditLock();
      if (state.draft) prepare();
      await regenerateGallery();
    }, connect: async (base, signal) => {
      const connected = await connectFrame({base, signal, allowJob:true, deferReady:true, expected:state.job ? state.frame : undefined});
      if (!connected) throw new Error('Wait for the current frame operation, then retry.');
      showView('editor');
    }});
    await watchNativeApp({
      resume: async () => {state.foreground = true; await reconnect(); void checkForUpdates({automatic: true});},
      pause: () => {state.foreground = false;},
      back: () => {
        if (el['setup-dialog'].open) {void setup.close(); return true;}
        if (el['delete-dialog'].open) {el['delete-dialog'].close(); return true;}
        if (state.view !== 'editor') {showView('editor'); return true;}
        return false;
      },
      save: async () => {if (state.draft) await saveDraft(state.draft);},
      failed: () => activity('Could not save your draft', 'Keep the app open and try again.', true),
    });
  } else {
    // The website's service worker delivers web updates, so this card only names the version.
    el['app-updates'].hidden = true;
    el['app-card'].hidden = false;
    el['app-version'].textContent = `Sparkle Duck ${import.meta.env.APP_VERSION} (web)`;
  }
  const handoff = new URLSearchParams(location.hash.slice(1)).get('device');
  const remembered = savedFrame();
  if (handoff && !androidApp) {
    try {el.address.value = normalizeAddress(handoff);} catch (error) {el['connection-status'].textContent = error.message;}
    history.replaceState(null, '', location.pathname);
  } else if (remembered?.base) {
    try {
      const base = normalizeAddress(remembered.base);
      el.address.value = base;
      if (remembered.config) state.config = validateConfig(remembered.config);
      state.frame = {...remembered, base};
      el['frame-name'].textContent = remembered.name || new URL(base).hostname;
      el.forget.hidden = false;
      if (!navigator.onLine) {
        el['frame-detail'].textContent = 'Offline · Draft saved on this phone';
        el['connection-status'].textContent = 'You’re offline. Keep editing your draft; reconnect to send it.';
      }
    } catch { /* Ignore malformed old settings. */ }
  }
  try {const draft = await readDraft(); if (draft?.blob) await useDraft(draft);} catch { /* Storage is optional. */ }
  syncOrientation(); renderFrames(); controls();
  if (androidApp) state.reconnectTimer = setTimeout(checkConnection, 15000);
  if (import.meta.env.PROD && !androidApp) watchAppUpdates(controls).catch(() => {});
  if (!handoff && remembered?.base && (androidApp || navigator.onLine)) connectFrame();
  if (androidApp) void installedReady.then(() => {controls(); return checkForUpdates({automatic: true});});
}
window.addEventListener('offline', markOffline);
window.addEventListener('online', () => {
  void connectOnline();
  if (androidApp) void checkForUpdates({automatic: true});
});
start();
