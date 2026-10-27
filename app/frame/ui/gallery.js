import {elements as el} from '../core/dom.js';
import {state} from '../core/state.js';
import {allowed, begin, end} from '../core/operations.js';
import {imageSettings, validatePhoto} from '../core/settings.js';
import {pendingPhotoRotation} from '../core/photo-rotation.js';
import {request, savePhoto, jsonPost, getPhoto} from '../services/frame-client.js';
import {processPhoto} from '../services/processor.js';
import {activity, controls, showView, renderGallery, renderImports} from './render.js';
import {releaseEditLock, acquireEditLock} from './edit-lock.js';
import {useDraft} from './editor.js';

export async function refreshGallery() {
  const base = state.frame?.base;
  if (!base) return;
  const images = await request(base, '/api/images');
  if (state.frame?.base !== base) return;
  if (!Array.isArray(images)) throw new Error('The frame returned an invalid gallery.');
  state.images = images;
  el['gallery-status'].textContent = '';
  renderGallery(selectPhoto);
}

export async function selectPhoto(image, base) {
  if (!allowed(state, 'open') || !state.connected || state.frame?.base !== base) return;
  begin(state, 'open'); controls();
  try {
    const blob = await getPhoto(base, image.filename);
    if (state.frame?.base !== base) return;
    await releaseEditLock();
    if (state.frame?.base !== base) return;
    await useDraft({blob, sourceDeviceId: state.frame?.id, sourceFrame: base, sourceFilename: image.filename, name: image.filename, ...imageSettings(image)});
    await acquireEditLock();
  } catch (error) { el['gallery-status'].textContent = `Could not open photo: ${error.message}`; }
  finally { end(state, 'open'); controls(); }
}

export async function importPhotos(files) {
  if (!allowed(state, 'import') || !state.connected) return;
  begin(state, 'import'); controls();
  await releaseEditLock();
  state.imports = files.map(file => ({draft: {blob: file, name: file.name, ...imageSettings()}, status: 'Waiting'}));
  showView('gallery'); end(state, 'import'); await runImports();
}

export async function regenerateGallery() {
  // Keep an uncertain save's receipt available for retry instead of superseding it
  // with background regeneration (including after closing/reopening the app).
  const pending = state.images.filter(image => image.needs_processing
    && !pendingPhotoRotation(state.draft, state.frame.base, image.filename));
  if (!pending.length || !allowed(state, 'import') || !state.connected) return;
  begin(state, 'import'); controls();
  await releaseEditLock();
  state.imports = pending.map(image => ({regenerate:true, draft:{sourceFrame:state.frame.base,
    sourceFilename:image.filename, name:image.filename, ...imageSettings(image)}, status:'Waiting'}));
  showView('gallery');
  end(state, 'import');
  await runImports();
}

export async function runImports() {
  if (!allowed(state, 'import') || !state.connected) return;
  begin(state, 'import'); state.importing = true; controls(); renderImports();
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
  end(state, 'import'); controls();
}

export async function chooseFiles(files) {
  if (!files.length || !allowed(state, 'choose') || !state.config) return;
  if (files.length > 1) {
    if (!state.connected) {activity('Connect to add multiple photos', 'You can keep editing one photo offline. Adding photos to the frame needs WiFi.', true); return;}
    await importPhotos(files); return;
  }
  const [file] = files;
  try {validatePhoto(file);} catch (error) {activity('Could not open photo', error.message, true); return;}
  begin(state, 'choose'); controls();
  await releaseEditLock();
  el.activity.hidden = true;
  await useDraft({blob: file, name: file.name});
  end(state, 'choose'); controls();
}
