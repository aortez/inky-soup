import {imageSettings} from '../core/settings.js';

export function normalizeAddress(input) {
  const raw = String(input || '').trim();
  const url = new URL(raw.includes('://') ? raw : `http://${raw}`);
  const host = url.hostname.toLowerCase();
  const parts = host.split('.').map(Number);
  const ipv4 = parts.length === 4 && parts.every(n => Number.isInteger(n) && n >= 0 && n <= 255);
  const private4 = ipv4 && (parts[0] === 10 || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || !(host.endsWith('.local') || private4)) {
    throw new Error('Use your frame’s .local address or a private WiFi IP address.');
  }
  if (url.pathname !== '/' || url.search || url.hash) throw new Error('Enter just the frame address, without a page or query.');
  const authority = (raw.includes('://') ? raw.split('://')[1] : raw).split('/')[0];
  if (!url.port && !/:\d+$/.test(authority)) url.port = '8000';
  return url.origin;
}

export async function request(base, path, options = {}) {
  let response;
  try {
    response = await fetch(`${base}${path}`, {
      credentials: 'omit', cache: 'no-store', redirect: 'error',
      signal: AbortSignal.timeout(60000), ...options,
    });
  } catch {
    throw new Error('Cannot reach the frame. Use the same WiFi, allow local-network access, then reconnect.');
  }
  if (!response.ok) {
    let detail;
    try { detail = (await response.json()).message; } catch { /* Older routes return an HTML error. */ }
    const error = new Error(detail || (response.status === 404
      ? 'This frame needs the app API update, or the previous job is no longer available.'
      : `The frame rejected the request (${response.status}).`));
    error.status = response.status;
    throw error;
  }
  const result = await response.json();
  if (result.success === false) throw new Error(result.message || 'The frame could not save this image.');
  return result;
}

export function validateConfig(config) {
  const dimensions = {'impression-13.3-2025': [1600, 1200], 'impression-5.7': [600, 448]};
  const expected = dimensions[config.model];
  const rotation = config.rotation_degrees ?? 0;
  const revision = config.rotation_revision ?? 0;
  const physical = [config.physical_width ?? config.width, config.physical_height ?? config.height];
  const logical = [90, 270].includes(rotation) ? physical.slice().reverse() : physical;
  if (!expected || ![0, 90, 180, 270].includes(rotation) || !Number.isSafeInteger(revision) || revision < 0
      || expected[0] !== physical[0] || expected[1] !== physical[1]
      || logical[0] !== config.width || logical[1] !== config.height) {
    throw new Error('This display configuration is not supported by this app yet.');
  }
  return {...config, rotation_degrees:rotation, rotation_revision:revision,
    orientation_supported:config.orientation_supported ?? config.rotation_revision !== undefined};
}

export function jsonPost(base, path, body) {
  return request(base, path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
}

function form(values) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.append(key, String(value));
  return data;
}

export async function savePhoto({base, draft, prepared, session, onProgress = () => {}, onStored = () => {}, display = false, keepLock = false}) {
  // A unique name prevents replacement of an existing original if an upload is retried.
  const extension = {'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif'}[draft.blob.type] || 'jpg';
  const existing = draft.sourceFrame === base && draft.sourceFilename;
  const filename = existing || `${crypto.randomUUID()}.${extension}`;
  const settings = imageSettings(draft);
  const metadata = {filename, session_id: session, filter: settings.filter, fit_mode: settings.fit,
    rotation_revision: prepared.rotation_revision ?? 0,
    saturation: settings.saturation, brightness: settings.brightness, contrast: settings.contrast, dither_algorithm: settings.dither};
  let owned = false;
  let lockTimer;
  let lockError;
  let refreshing = false;
  const unlock = () => jsonPost(base, '/api/unlock-image', {filename, session_id: session});
  try {
    onProgress('Saving your photo…');
    const lock = await jsonPost(base, '/api/lock-image', {filename, session_id: session, refresh_only: Boolean(keepLock && existing)});
    if (!lock.locked) throw new Error('This photo is being edited elsewhere.');
    owned = true;
    lockTimer = setInterval(async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const renewed = await jsonPost(base, '/api/lock-image', {filename, session_id: session, refresh_only: true});
        if (!renewed.locked) lockError = new Error('The editing session expired. Reconnect and try again.');
      } catch (error) { lockError = error; }
      finally { refreshing = false; }
    }, 10000);
    if (!existing) {
      const original = new FormData();
      original.append('submission.file', draft.blob, filename);
      const uploaded = await request(base, '/upload', {method: 'POST', body: original});
      if (uploaded.filename !== filename) throw new Error('The frame returned an unexpected image name.');
      await onStored({base, filename});
    }
    for (const [path, blob, label] of [
      ['/api/upload-cache', prepared.cache, 'Saving the preview…'],
      ['/api/upload-thumb', prepared.thumb, 'Saving the thumbnail…'],
      ['/api/upload-dithered', prepared.dithered, 'Sending the display image…'],
    ]) {
      if (lockError) throw lockError;
      onProgress(label);
      const body = form(metadata); body.append('file', blob, `${filename}.png`);
      await request(base, path, {method: 'POST', body});
    }
    if (lockError) throw lockError;
    if (!display) return {filename, base};
    onProgress('Starting the display refresh…');
    const body = form({'submission.filename': filename, 'submission.image_file_path': `images/dithered/${filename}.png`,
      'submission.rotation_revision': prepared.rotation_revision ?? 0,
      'submission.session_id': session, 'submission.flash_twice': false});
    const job = await request(base, '/flash', {method: 'POST', body});
    return {id: job.job_id, filename, base};
  } finally {
    clearInterval(lockTimer);
    if (owned && !keepLock) await unlock().catch(() => {});
  }
}

export async function sendPhoto(options) {
  return savePhoto({...options, display: true});
}

export async function deletePhoto(base, filename, session) {
  return jsonPost(base, '/api/delete-image', {filename, session_id: session});
}

export async function getPhoto(base, filename, thumbnail = false) {
  const path = thumbnail ? `thumbs/${encodeURIComponent(filename)}.png` : encodeURIComponent(filename);
  const response = await fetch(`${base}/images/${path}`, {credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30000)});
  if (!response.ok) throw new Error('Could not load this photo from the frame.');
  return response.blob();
}
