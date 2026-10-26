import './style.css';
import {selectDevice} from './services/transport.js';
import {draftForFrame, jobForFrame} from './core/frame-registry.js';
import {identifyFrame, locateFrame, discoverFrames} from './services/frame-discovery.js';
import {androidApp} from './core/platform.js';
import {previewConfig, savedPreviewConfig, rememberPreviewConfig} from './core/preview-profile.js';
import {elements as el} from './core/dom.js';
import {state, sessionReady, rememberFrame, savedFrame, rememberJob, savedJob, forgetSavedJob, registry} from './core/state.js';
import {normalizeAddress, request, validateConfig, savePhoto, deletePhoto, jsonPost, getPhoto, sendTestCard} from './services/frame-client.js';
import {imageSettings, settingIds, validatePhoto} from './core/settings.js';
import {pendingPhotoRotation} from './core/photo-rotation.js';
import {orientationTestCard} from './services/test-card.js';
import {processPhoto} from './services/processor.js';
import {saveDraft, readDraft} from './services/drafts.js';
import {watchAppUpdates, reloadApp} from './services/app-updates.js';
import {activity, controls, showView, renderGallery, renderPreview, renderImports} from './ui/render.js';

async function refreshGallery() {
  const base = state.frame?.base;
  if (!base) return;
  const images = await request(base, '/api/images');
  if (state.frame?.base !== base) return;
  if (!Array.isArray(images)) throw new Error('The frame returned an invalid gallery.');
  state.images = images;
  el['gallery-status'].textContent = '';
  renderGallery(selectPhoto);
}

function renderFrames() {
  if (!androidApp) return;
  el['saved-frames'].hidden = false;
  el['frame-picker'].replaceChildren(new Option('Choose a frame', ''));
  try {
    for (const frame of registry.list().sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))) {
      const model = frame.config?.model === 'impression-5.7' ? '5.7″' : frame.config?.model === 'impression-13.3-2025' ? '13.3″' : 'Frame';
      el['frame-picker'].add(new Option(`${frame.name} · ${model} · ${frame.id.slice(-6)}`, frame.id));
    }
    el['frame-picker'].value = state.frame?.id || '';
    if (registry.notice) el['connection-status'].textContent = registry.notice;
  } catch (error) {el['connection-status'].textContent = error.message;}
}

async function connectFrame({base: setupBase, signal, expected, automatic = false, allowJob = false, deferReady = false} = {}) {
  if (!state.session || state.busy || state.connecting || (state.job && !automatic && !allowJob)) return;
  // Invalidate in-flight poll results before moving the selected native transport.
  clearTimeout(state.pollTimer);
  if (state.job) rememberJob({...state.job});
  const releaseRemote = !androidApp && state.connected;
  state.connecting = true; controls();
  state.connected = false; controls();
  el['frame-detail'].textContent = 'Connecting…';
  el['connection-status'].textContent = 'Finding your frame… Allow local-network access if prompted.';
  try {
    await releaseEditLock(releaseRemote);
    let base = normalizeAddress(setupBase || el.address.value);
    let identity;
    signal?.throwIfAborted();
    if (androidApp) {
      const saved = expected || (!setupBase && state.frame?.id && base === state.frame.base ? state.frame : null);
      identity = saved ? await locateFrame({...saved, base}, state.discovery, signal) : await identifyFrame(base, signal);
      base = identity.base;
    }
    await selectDevice(base);
    signal?.throwIfAborted();
    const rawConfig = await request(base, '/api/display-config', signal ? {signal} : {});
    signal?.throwIfAborted();
    if (androidApp && (!Number.isSafeInteger(rawConfig.rotation_revision) || !rawConfig.physical_width)) {
      throw new Error('Update the frame firmware to the revision-aware app API, then reconnect.');
    }
    const config = validateConfig(rawConfig);
    const images = await request(base, '/api/images', signal ? {signal} : {});
    signal?.throwIfAborted();
    if (!Array.isArray(images)) throw new Error('The frame returned an invalid gallery.');
    if (identity) {
      const verified = await identifyFrame(base, signal);
      if (verified.id !== identity.id || verified.instance_id !== identity.instance_id) throw new Error('The frame changed while connecting. Retry connection.');
    }
    signal?.throwIfAborted();
    el.address.value = base;
    if (state.frame?.base !== base || state.frame?.id !== identity?.id) {state.imports = []; renderImports();}
    rememberFrame({...identity, base, name: identity?.name || new URL(base).hostname.replace(/\.local$/, ''), config});
    if (androidApp && state.draft) {
      state.draft = draftForFrame(state.draft, state.frame);
      await saveDraft(state.draft);
    }
    state.config = config; state.images = images; state.connected = true;
    syncOrientation(); renderFrames();
    el['frame-name'].textContent = state.frame.name;
    el['frame-detail'].textContent = `Connected · ${config.width} × ${config.height}`;
    el['connection-status'].textContent = 'Connected directly over your local WiFi.';
    el.connection.classList.add('connected'); el.connection.open = false; el.forget.hidden = false;
    el.dimensions.textContent = `${config.width} × ${config.height}`;
    renderGallery(selectPhoto);
    const previous = savedJob();
    if (androidApp && previous) {
      try {rememberJob(jobForFrame(previous, state.frame));}
      catch (error) {rememberJob(null); activity('Previous refresh status unavailable', error.message, true, 'none', previous.kind);}
    } else if (previous?.base === base) rememberJob(previous);
    if (state.job) {if (state.job.kind === 'test-card') showView('settings'); void pollJob();}
    if (state.draft) {if (!deferReady && !state.job) await acquireEditLock(); prepare();}
    if (!state.job && !deferReady) await regenerateGallery();
    return true;
  } catch (error) {
    state.connected = false;
    el['connection-status'].textContent = (androidApp || navigator.onLine) ? error.message : 'You’re offline. Keep editing your draft; reconnect to send it.';
    el['frame-detail'].textContent = navigator.onLine ? 'Not connected' : 'Offline · Draft saved on this phone';
    el.connection.classList.remove('connected'); el.connection.open = true;
    if (state.job) showJobUnavailable(error, state.job);
    if (setupBase && !automatic) throw error;
    return false;
  } finally { state.connecting = false; controls(); }
}

async function reconnect() {
  if (!androidApp || !state.foreground || state.busy || state.connecting || el['setup-dialog'].open || !state.frame?.id) return;
  await connectFrame({automatic:true, expected:state.frame, base:state.frame.base});
}

async function checkConnection() {
  try {
    if (!state.foreground || state.busy || state.connecting || el['setup-dialog'].open || !state.frame?.id) return;
    if (state.connected) {
      const frame = state.frame;
      try {
        const identity = await identifyFrame(frame.base);
        if (state.frame !== frame || state.busy || state.connecting || !state.foreground) return;
        if (identity.id === state.frame.id && identity.instance_id === state.frame.instance_id) return;
      } catch { /* The remembered address may have changed. Discover by identity. */ }
      if (state.frame !== frame || state.busy || state.connecting || !state.foreground) return;
      state.connected = false;
    }
    await reconnect();
  } finally {state.reconnectTimer = setTimeout(checkConnection, 15000);}
}

async function useDraft(draft) {
  draft = {...draft, ...imageSettings(draft)};
  state.draft = draft;
  el['draft-name'].textContent = draft.name;
  for (const id of settingIds) el[id].value = String(draft[id]);
  for (const id of ['saturation', 'brightness', 'contrast']) el[`${id}-value`].value = draft[id];
  el.editor.hidden = false; el['photo-actions'].hidden = false; el['library-actions'].hidden = false;
  showView('editor'); prepare();
  try { await saveDraft(draft); }
  catch { activity('Draft is open', 'This browser could not save the draft. Keep the app open until you send it.'); }
}

async function selectPhoto(image, base) {
  if (state.busy || state.job || state.connecting || !state.connected || state.frame?.base !== base) return;
  state.busy = true; controls();
  try {
    const blob = await getPhoto(base, image.filename);
    if (state.frame?.base !== base) return;
    await releaseEditLock();
    if (state.frame?.base !== base) return;
    await useDraft({blob, sourceDeviceId: state.frame?.id, sourceFrame: base, sourceFilename: image.filename, name: image.filename, ...imageSettings(image)});
    await acquireEditLock();
  } catch (error) { el['gallery-status'].textContent = `Could not open photo: ${error.message}`; }
  finally { state.busy = false; controls(); }
}

async function prepare() {
  if (!state.draft || !state.config) return;
  state.processor?.abort();
  const controller = new AbortController(); state.processor = controller;
  const generation = ++state.generation;
  state.prepared = null; state.processing = true; controls();
  el['preview-status'].textContent = 'Making your color preview…';
  try {
    const data = await processPhoto(state.draft, state.config, controller.signal);
    if (generation !== state.generation) return;
    state.prepared = data;
    if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    if (state.beforeUrl) URL.revokeObjectURL(state.beforeUrl);
    state.previewUrl = URL.createObjectURL(data.dithered);
    state.beforeUrl = URL.createObjectURL(data.adjusted);
    renderPreview(); el.preview.hidden = false; el['preview-empty'].hidden = true;
    el['preview-tabs'].hidden = false;
    el.preview.width = data.width; el.preview.height = data.height;
    el.dimensions.textContent = `${data.width} × ${data.height}`;
    el['preview-status'].textContent = 'Ready. The screen’s ink colors may look softer than this preview.';
  } catch (error) {
    if (generation !== state.generation || error.name === 'AbortError') return;
    el['preview-status'].textContent = error.message;
  } finally {
    if (generation === state.generation) {state.processing = false; controls();}
  }
}

async function releaseEditLock(remote = state.connected) {
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

async function acquireEditLock() {
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

async function storeCurrentPhoto(display) {
  if (el[display ? 'send' : 'save'].disabled) return;
  state.busy = true; controls();
  el['job-details'].hidden = true; el['retry-status'].hidden = true;
  let revealed = false;
  try {
    const result = await savePhoto({base: state.frame.base, draft: state.draft, prepared: state.prepared,
      session: state.session, display, keepLock: true,
      onStored: async ({base, filename, ...saved}) => {
        state.draft = {...state.draft, ...saved, sourceDeviceId: state.frame?.id, sourceFrame: base, sourceFilename: filename};
        await saveDraft(state.draft);
      },
      onProgress: message => {
        activity(message, 'Your photo stays on your local network.', false, 'busy');
        if (!revealed) {el['send-panel'].scrollIntoView({block: 'nearest'}); revealed = true;}
      }});
    state.draft = {...state.draft, sourceDeviceId: state.frame?.id, sourceFrame: result.base, sourceFilename: result.filename};
    await saveDraft(state.draft).catch(() => {});
    if (display) {rememberJob({...result, deviceId:state.frame?.id, instanceId:state.frame?.instance_id}); pollJob();}
    else {activity('Photo saved.', 'Your photo and adjustments are on the frame. The display has not changed.', false, 'complete'); refreshGallery().catch(() => {});}
  } catch (error) {activity('Could not finish saving', `${error.message} Check the frame before retrying if the connection was interrupted.`, true);}
  finally {await acquireEditLock(); state.busy = false; controls();}
}

async function importPhotos(files) {
  if (state.busy || state.job || !state.connected) return;
  state.busy = true; controls();
  await releaseEditLock();
  state.imports = files.map(file => ({draft: {blob: file, name: file.name, ...imageSettings()}, status: 'Waiting'}));
  showView('gallery'); state.busy = false; await runImports();
}

function syncOrientation() {
  el.orientation.value = String(state.config?.rotation_degrees ?? 0);
  const config = state.config;
  el['orientation-size'].textContent = config ? `${config.width} × ${config.height} preview` : 'Connect your frame to choose its orientation.';
  el['orientation-diagram'].style.setProperty('--mount-rotation', `${config?.rotation_degrees ?? 0}deg`);
  el['orientation-status'].textContent = config && !config.orientation_supported ? 'Update your frame software to change its orientation.' : '';
}

async function regenerateGallery() {
  // Keep an uncertain save's receipt available for retry instead of superseding it
  // with background regeneration (including after closing/reopening the app).
  const pending = state.images.filter(image => image.needs_processing
    && !pendingPhotoRotation(state.draft, state.frame.base, image.filename));
  if (!pending.length || state.busy || state.job || !state.connected) return;
  state.busy = true; controls();
  await releaseEditLock();
  state.imports = pending.map(image => ({regenerate:true, draft:{sourceFrame:state.frame.base,
    sourceFilename:image.filename, name:image.filename, ...imageSettings(image)}, status:'Waiting'}));
  showView('gallery');
  state.busy = false;
  await runImports();
}

async function changeOrientation() {
  if (el['save-orientation'].disabled) return;
  state.busy = true; controls();
  el['orientation-status'].textContent = 'Saving orientation…';
  try {
    const result = await jsonPost(state.frame.base, '/api/settings/display-rotation', {
      rotation_degrees:Number(el.orientation.value), expected_revision:state.config.rotation_revision});
    state.config = validateConfig(result.display);
    rememberFrame({...state.frame, config:state.config});
    syncOrientation();
    el['frame-detail'].textContent = `Connected · ${state.config.width} × ${state.config.height}`;
    if (state.draft) await prepare();
    await refreshGallery();
    el['orientation-status'].textContent = 'Orientation saved. The screen changes when you display a photo.';
  } catch (error) {
    el['orientation-status'].textContent = `${error.message} Reconnect to get the frame’s current orientation.`;
    state.busy = false; controls(); return;
  }
  state.busy = false; controls();
  await regenerateGallery();
}

async function runImports() {
  if (state.busy || state.job || !state.connected) return;
  state.busy = true; state.importing = true; controls(); renderImports();
  for (const item of state.imports) {
    if (item.status === 'Saved') continue;
    item.error = null;
    let owned = false;
    let lockTimer;
    let lockError;
    let refreshing = false;
    const base = state.frame.base;
    const filename = item.draft.sourceFilename;
    try {
      if (item.regenerate) {
        const lock = await jsonPost(base, '/api/lock-image', {filename, session_id:state.session});
        if (!lock.locked) throw new Error('This photo is being edited elsewhere. Retry after that editor finishes.');
        owned = true;
        lockTimer = setInterval(async () => {
          if (refreshing) return;
          refreshing = true;
          try {
            const renewed = await jsonPost(base, '/api/lock-image', {filename, session_id:state.session, refresh_only:true});
            if (!renewed.locked) lockError = new Error('The editing session expired. Retry this photo.');
          } catch (error) {lockError = error;}
          finally {refreshing = false;}
        }, 10000);
        // Read settings after acquiring ownership: another editor may have saved
        // newer adjustments, or already rebuilt this photo, while it was waiting.
        const latest = (await request(base, '/api/images')).find(image => image.filename === filename);
        if (!latest) throw new Error('This photo was removed from the frame.');
        if (!latest.needs_processing) {item.status = 'Saved'; continue;}
        Object.assign(item.draft, imageSettings(latest));
        item.status = 'Loading original…'; renderImports();
        item.draft.blob = await getPhoto(base, filename);
      }
      validatePhoto(item.draft.blob);
      item.status = 'Making preview…'; renderImports();
      const prepared = await processPhoto(item.draft, state.config);
      if (lockError) throw lockError;
      clearInterval(lockTimer);
      const saved = await savePhoto({base, draft: item.draft, prepared, session: state.session, keepLock:owned,
        onStored: ({base, filename, ...saved}) => {Object.assign(item.draft, saved, {sourceFrame:base, sourceFilename:filename});},
        onProgress: message => {item.status = message; renderImports();}});
      item.draft.sourceFrame = saved.base; item.draft.sourceFilename = saved.filename; item.status = 'Saved';
    } catch (error) {item.status = 'Failed'; item.error = error.message;}
    finally {
      clearInterval(lockTimer);
      if (owned) await jsonPost(base, '/api/unlock-image', {filename, session_id:state.session}).catch(() => {});
      if (item.regenerate) delete item.draft.blob;
    }
    renderImports();
    if (!state.connected) break;
  }
  state.importing = false; renderImports();
  await refreshGallery().catch(error => {el['gallery-status'].textContent = error.message;});
  await acquireEditLock();
  state.busy = false; controls();
}

async function chooseFiles(files) {
  if (!files.length || state.busy || state.job || !state.config) return;
  if (files.length > 1) {
    if (!state.connected) {activity('Connect to add multiple photos', 'You can keep editing one photo offline. Adding photos to the frame needs WiFi.', true); return;}
    await importPhotos(files); return;
  }
  const [file] = files;
  try {validatePhoto(file);} catch (error) {activity('Could not open photo', error.message, true); return;}
  state.busy = true; controls();
  await releaseEditLock();
  el.activity.hidden = true;
  await useDraft({blob: file, name: file.name});
  state.busy = false; controls();
}

async function finishJob(job) {
  if (state.job !== job) return;
  if (state.connected && state.frame?.base === job.base) {
    // Keep the job active until editing is restored, so frame selection cannot
    // race the gallery request or acquire a lease on the wrong frame.
    try {await refreshGallery();}
    catch (error) {el['gallery-status'].textContent = error.message;}
    if (state.job !== job || state.connecting) return;
    await acquireEditLock();
    if (state.job !== job) return;
  }
  rememberJob(null); controls();
  if (!state.connected || state.frame?.base !== job.base) return;
  try {
    await regenerateGallery();
  } catch (error) {el['gallery-status'].textContent = error.message;}
}

function showJobUnavailable(error, job) {
  activity('Refresh status unavailable', `${error.message} The job may still be running.`, true, 'none', job.kind);
  el['retry-status'].hidden = false;
  el['test-retry-status'].hidden = false;
}

async function pollJob() {
  clearTimeout(state.pollTimer);
  const job = state.job;
  if (!job) return;
  const jobActivity = (title, detail = '', error = false, progress = 'none') => activity(title, detail, error, progress, job.kind);
  el['test-retry-status'].hidden = true;
  el['retry-status'].hidden = true;
  try {
    if (androidApp) {
      const identity = await identifyFrame(job.base);
      if (state.job !== job || state.connecting) return;
      jobForFrame(job, identity);
    }
    const current = await request(job.base, `/api/flash/status/${job.id}`);
    if (state.job !== job) return;
    if (current.filename !== job.filename || (job.createdAt && job.createdAt !== current.created_at)) {
      throw new Error('The frame restarted. Check the screen before sending this photo again.');
    }
    job.createdAt = current.created_at; rememberJob(job);
    el['job-details'].hidden = false;
    const elapsed = current.started_at ? Math.max(0, Math.round(((current.finished_at || Date.now()) - current.started_at) / 1000)) : null;
    el['job-info'].textContent = `Job ${job.id} · ${current.status}${elapsed === null ? '' : ` · ${elapsed}s since refresh started`} · ${current.filename}`;
    if (current.status === 'Completed') {
      jobActivity(job.kind === 'test-card' ? 'Orientation test card displayed.' : 'Your new view is ready.', 'The frame has finished refreshing.', false, 'complete');
      await finishJob(job); return;
    }
    if (current.status === 'Failed') {
      const timeout = /Wait:.*Timed out/.test(current.error_message || '');
      jobActivity('The display could not refresh.', timeout ? 'The panel did not respond. Check its connection before trying again.' : 'The frame reported a display error. Check the device before trying again.', true);
      await finishJob(job); return;
    }
    jobActivity(current.status === 'Queued' ? 'Waiting for your frame…' : 'Refreshing your frame…', 'The screen may flash several times. Keep the frame powered on.', false, 'busy');
    state.pollTimer = setTimeout(pollJob, 2000);
  } catch (error) {
    if (state.job !== job) return;
    if (androidApp) state.connected = false;
    showJobUnavailable(error, job);
    // A lost response must never cause an automatic second flash.
    if (error.status === 404 || error.message.includes('restarted')) await finishJob(job);
    controls();
  }
}

el['connect-form'].addEventListener('submit', event => {event.preventDefault(); connectFrame({automatic:Boolean(state.job)});});
el['frame-picker'].addEventListener('change', async () => {
  if (state.busy || state.job || state.connecting) return;
  state.connecting = true; controls();
  try {
    const frame = registry.list().find(item => item.id === el['frame-picker'].value);
    if (!frame) return;
    // Persist selection before releasing the current edit lease. A storage error
    // leaves the connected frame and its draft usable.
    registry.select(frame.id);
    await releaseEditLock();
    state.frame = frame; state.connected = false; state.images = [];
    state.config = frame.config || savedPreviewConfig(); el.address.value = frame.base;
    el['frame-name'].textContent = frame.name; el.forget.hidden = false;
    renderGallery(selectPhoto); syncOrientation();
  } catch (error) {
    el['connection-status'].textContent = error.message;
    el['frame-picker'].value = state.frame?.id || '';
    return;
  } finally {state.connecting = false; controls();}
  await reconnect();
});
el['discover-frames'].addEventListener('click', async () => {
  if (state.busy || state.job || state.connecting) return;
  state.connecting = true; controls(); el['nearby-frames'].replaceChildren();
  el['connection-status'].textContent = 'Looking for frames on this WiFi…';
  try {
    state.discovered = await discoverFrames(state.discovery);
    for (const frame of state.discovered) {
      const button = document.createElement('button'); button.type = 'button';
      button.textContent = `${frame.name} · ${frame.id.slice(-6)}`;
      button.addEventListener('click', () => connectFrame({base:frame.base, expected:frame}).catch(error => {el['connection-status'].textContent = error.message;}));
      el['nearby-frames'].append(button);
    }
    el['connection-status'].textContent = state.discovered.length ? 'Choose a frame to connect.' : 'No frames found. Check power and use the same WiFi. If discovery is blocked, enter its address or use Bluetooth setup.';
  } catch (error) {el['connection-status'].textContent = error.message;}
  finally {state.connecting = false; controls();}
});
el['reload-app'].addEventListener('click', () => reloadApp(controls));
el['pick-photo'].addEventListener('click', () => el.photo.click());
el.photo.addEventListener('change', async () => {
  const files = [...el.photo.files]; el.photo.value = ''; await chooseFiles(files);
});
for (const id of settingIds) el[id].addEventListener('change', () => {
  if (!state.draft || el[id].disabled) return;
  const settings = Object.fromEntries(settingIds.map(key => [key, ['saturation', 'brightness', 'contrast', 'photo_rotation_degrees'].includes(key) ? Number(el[key].value) : el[key].value]));
  useDraft({...state.draft, ...settings});
});
for (const id of ['saturation', 'brightness', 'contrast']) el[id].addEventListener('input', () => {el[`${id}-value`].value = el[id].value;});
el.send.addEventListener('click', () => storeCurrentPhoto(true));
el.save.addEventListener('click', () => storeCurrentPhoto(false));
el['settings-tab'].addEventListener('click', () => showView('settings'));
for (const id of ['preview-model', 'preview-layout']) el[id].addEventListener('change', () => {
  if (!androidApp || state.connected || state.connecting || state.busy || state.job) return;
  state.config = previewConfig(el['preview-model'].value, el['preview-layout'].value === 'portrait');
  rememberPreviewConfig(state.config);
  el.dimensions.textContent = `${state.config.width} × ${state.config.height}`;
  prepare();
});
el.orientation.addEventListener('change', () => {
  el['orientation-diagram'].style.setProperty('--mount-rotation', `${el.orientation.value}deg`);
  controls();
});
el['save-orientation'].addEventListener('click', changeOrientation);
el['test-orientation'].addEventListener('click', async () => {
  if (el['test-orientation'].disabled) return;
  state.busy = true; controls();
  el['test-retry-status'].hidden = true;
  activity('Preparing the orientation card…', '', false, 'busy', 'test-card');
  el['test-activity'].scrollIntoView({block:'nearest'});
  try {
    const config = state.config;
    const blob = await orientationTestCard(config);
    const job = await sendTestCard(state.frame.base, blob, config);
    rememberJob({...job, deviceId:state.frame?.id, instanceId:state.frame?.instance_id}); pollJob();
  } catch (error) {
    activity('Could not start the test card.', `${error.message} If the connection was lost, check the display before trying again.`, true, 'none', 'test-card');
  } finally {state.busy = false; controls();}
});
el['test-retry-status'].addEventListener('click', () => androidApp ? reconnect() : pollJob());
el['preview-before'].addEventListener('click', () => {state.previewMode = 'before'; renderPreview();});
el['preview-display'].addEventListener('click', () => {state.previewMode = 'display'; renderPreview();});
el['retry-edit'].addEventListener('click', async () => {
  if (el['retry-edit'].disabled) return;
  state.busy = true; controls(); await acquireEditLock(); state.busy = false; controls();
});
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
el['confirm-delete'].addEventListener('click', async () => {
  el['delete-dialog'].close();
  if (el.delete.disabled) return;
  state.busy = true; controls();
  try {
    const deleted = await deletePhoto(state.frame.base, state.draft.sourceFilename, state.session);
    await releaseEditLock();
    state.draft = {...state.draft, sourceFrame: null, sourceFilename: null,
      photo_rotation_revision:0, pending_photo_rotation:null};
    await saveDraft(state.draft).catch(() => {});
    activity('Photo deleted from the frame.', deleted.warnings?.length ? 'The original was deleted, but some saved versions could not be removed.' : 'A copy remains in your phone’s draft. The display has not changed.');
    await refreshGallery();
  } catch (error) {activity('Could not delete photo', error.message, true);}
  finally {state.busy = false; controls();}
});
el['retry-status'].addEventListener('click', () => androidApp ? reconnect() : state.job ? pollJob() : connectFrame());
el['refresh-gallery'].addEventListener('click', () => refreshGallery().catch(error => {el['gallery-status'].textContent = error.message;}));
el['choose-tab'].addEventListener('click', () => showView('editor'));
el['gallery-tab'].addEventListener('click', () => showView('gallery'));
el.forget.addEventListener('click', async () => {
  if (state.busy || state.job || state.connecting) return;
  state.busy = true; controls();
  await releaseEditLock();
  if (androidApp && state.frame?.id) {
    registry.forget(state.frame.id);
    forgetSavedJob(state.frame.id);
  }
  try { localStorage.removeItem('sparkle-frame'); } catch { /* Storage can be disabled. */ }
  state.frame = null; state.config = androidApp ? savedPreviewConfig() : null; state.connected = false;
  state.images = []; state.processor?.abort(); ++state.generation; state.processing = false; state.prepared = null;
  el.connection.open = true; el.connection.classList.remove('connected'); el.forget.hidden = true;
  el['frame-name'].textContent = 'Your frame'; el['frame-detail'].textContent = 'Connect once. Keep it close.';
  el['connection-status'].textContent = 'Frame forgotten. Your draft is still on this phone.';
  state.imports = []; renderImports();
  state.busy = false; renderFrames(); renderGallery(selectPhoto); controls();
  if (androidApp) prepare();
});
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
  if (androidApp) {
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
      resume: async () => {state.foreground = true; await reconnect();},
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
}
window.addEventListener('offline', () => {
  state.connected = false;
  if (state.lock) {clearInterval(state.lock.timer); state.lock.owned = false;}
  el.connection.classList.remove('connected');
  el['frame-detail'].textContent = 'Offline · Draft saved on this phone';
  el['connection-status'].textContent = 'You’re offline. Keep editing your draft; reconnect to send it.';
  el['lock-notice'].hidden = true;
  controls();
});
window.addEventListener('online', () => {
  if (androidApp) {void reconnect(); return;}
  if (!el['setup-dialog'].open && !state.connected && !state.busy && !state.job && state.frame?.base === el.address.value) connectFrame();
});
start();
