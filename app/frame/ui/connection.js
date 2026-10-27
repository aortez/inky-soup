import {androidApp} from '../core/platform.js';
import {draftForFrame, jobForFrame} from '../core/frame-registry.js';
import {savedPreviewConfig} from '../core/preview-profile.js';
import {elements as el} from '../core/dom.js';
import {state, rememberFrame, rememberJob, savedJob, forgetSavedJob, registry} from '../core/state.js';
import {allowed, begin, end} from '../core/operations.js';
import {selectDevice} from '../services/transport.js';
import {identifyFrame, locateFrame, discoverFrames} from '../services/frame-discovery.js';
import {normalizeAddress, request, validateConfig} from '../services/frame-client.js';
import {saveDraft} from '../services/drafts.js';
import {activity, controls, showView, renderGallery, renderImports} from './render.js';
import {releaseEditLock, acquireEditLock} from './edit-lock.js';
import {prepare} from './editor.js';
import {selectPhoto, regenerateGallery} from './gallery.js';
import {pollJob, showJobUnavailable} from './jobs.js';
import {syncOrientation} from './orientation.js';

export function renderFrames() {
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

export async function connectFrame({base: setupBase, signal, expected, automatic = false, allowJob = false, deferReady = false} = {}) {
  const operation = automatic || allowJob ? 'reconnect' : 'connect';
  if (!state.session || !allowed(state, operation)) return;
  // Invalidate in-flight poll results before moving the selected native transport.
  clearTimeout(state.pollTimer);
  if (state.job) rememberJob({...state.job});
  const releaseRemote = !androidApp && state.connected;
  begin(state, operation); controls();
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
    await rememberFrame({...identity, base, name: identity?.name || new URL(base).hostname.replace(/\.local$/, ''), config}, signal);
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
  } finally { end(state, operation); controls(); }
}

export async function reconnect() {
  if (!androidApp || !state.foreground || !allowed(state, 'reconnect') || el['setup-dialog'].open || !state.frame?.id) return;
  await connectFrame({automatic:true, expected:state.frame, base:state.frame.base});
}

export async function checkConnection() {
  try {
    if (!state.foreground || !allowed(state, 'reconnect') || el['setup-dialog'].open || !state.frame?.id) return;
    if (state.connected) {
      const frame = state.frame;
      try {
        const identity = await identifyFrame(frame.base);
        if (state.frame !== frame || !allowed(state, 'reconnect') || !state.foreground) return;
        if (identity.id === state.frame.id && identity.instance_id === state.frame.instance_id) return;
      } catch { /* The remembered address may have changed. Discover by identity. */ }
      if (state.frame !== frame || !allowed(state, 'reconnect') || !state.foreground) return;
      state.connected = false;
    }
    await reconnect();
  } finally {state.reconnectTimer = setTimeout(checkConnection, 15000);}
}

// Back online, Android reconnects to the selected frame. The website connects
// again only if the address field still names it.
export async function connectOnline() {
  if (androidApp) return reconnect();
  if (!el['setup-dialog'].open && !state.connected && allowed(state, 'connect') && state.frame?.base === el.address.value) return connectFrame();
}

export function markOffline() {
  state.connected = false;
  if (state.lock) {clearInterval(state.lock.timer); state.lock.owned = false;}
  el.connection.classList.remove('connected');
  el['frame-detail'].textContent = 'Offline · Draft saved on this phone';
  el['connection-status'].textContent = 'You’re offline. Keep editing your draft; reconnect to send it.';
  el['lock-notice'].hidden = true;
  controls();
}

export async function selectFrame() {
  if (!allowed(state, 'select-frame')) return;
  begin(state, 'select-frame'); controls();
  try {
    const frame = registry.list().find(item => item.id === el['frame-picker'].value);
    if (!frame) return;
    // Persist selection before releasing the current edit lease. A storage error
    // leaves the connected frame and its draft usable.
    await registry.select(frame.id);
    await releaseEditLock();
    state.frame = frame; state.connected = false; state.images = [];
    state.config = frame.config || savedPreviewConfig(); el.address.value = frame.base;
    el['frame-name'].textContent = frame.name; el.forget.hidden = false;
    renderGallery(selectPhoto); syncOrientation();
  } catch (error) {
    el['connection-status'].textContent = error.message;
    el['frame-picker'].value = state.frame?.id || '';
    return;
  } finally {end(state, 'select-frame'); controls();}
  await reconnect();
}

export async function findNearbyFrames() {
  if (!allowed(state, 'discover')) return;
  begin(state, 'discover'); controls(); el['nearby-frames'].replaceChildren();
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
  finally {end(state, 'discover'); controls();}
}

export async function forgetFrame() {
  if (!allowed(state, 'forget')) return;
  begin(state, 'forget'); controls();
  try {
    if (androidApp && state.frame?.id) {
      await registry.forget(state.frame.id);
      forgetSavedJob(state.frame.id);
    }
    await releaseEditLock();
    try { localStorage.removeItem('sparkle-frame'); } catch { /* Storage can be disabled. */ }
    state.frame = null; state.config = androidApp ? savedPreviewConfig() : null; state.connected = false;
    state.images = []; state.processor?.abort(); ++state.generation; state.processing = false; state.prepared = null;
    el.connection.open = true; el.connection.classList.remove('connected'); el.forget.hidden = true;
    el['frame-name'].textContent = 'Your frame'; el['frame-detail'].textContent = 'Connect once. Keep it close.';
    el['connection-status'].textContent = 'Frame forgotten. Your draft is still on this phone.';
    state.imports = []; renderImports();
    renderFrames(); renderGallery(selectPhoto);
    if (androidApp) prepare();
  } catch (error) {el['connection-status'].textContent = error.message;}
  finally {end(state, 'forget'); controls();}
}
