import {elements as el} from '../core/dom.js';
import {state, rememberJob} from '../core/state.js';
import {begin, end} from '../core/operations.js';
import {savePhoto, deletePhoto} from '../services/frame-client.js';
import {saveDraft} from '../services/drafts.js';
import {activity, controls} from './render.js';
import {releaseEditLock, acquireEditLock} from './edit-lock.js';
import {refreshGallery} from './gallery.js';
import {pollJob} from './jobs.js';

export async function storeCurrentPhoto(display) {
  if (el[display ? 'send' : 'save'].disabled) return;
  begin(state, 'store'); controls();
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
  finally {await acquireEditLock(); end(state, 'store'); controls();}
}

export async function deleteCurrentPhoto() {
  if (el.delete.disabled) return;
  begin(state, 'delete'); controls();
  try {
    const deleted = await deletePhoto(state.frame.base, state.draft.sourceFilename, state.session);
    await releaseEditLock();
    state.draft = {...state.draft, sourceFrame: null, sourceFilename: null,
      photo_rotation_revision:0, pending_photo_rotation:null};
    await saveDraft(state.draft).catch(() => {});
    activity('Photo deleted from the frame.', deleted.warnings?.length ? 'The original was deleted, but some saved versions could not be removed.' : 'A copy remains in your phone’s draft. The display has not changed.');
    await refreshGallery();
  } catch (error) {activity('Could not delete photo', error.message, true);}
  finally {end(state, 'delete'); controls();}
}
