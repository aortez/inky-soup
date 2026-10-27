import {elements as el} from '../core/dom.js';
import {state, rememberFrame, rememberJob} from '../core/state.js';
import {begin, end} from '../core/operations.js';
import {validateConfig, jsonPost, sendTestCard} from '../services/frame-client.js';
import {orientationTestCard} from '../services/test-card.js';
import {activity, controls} from './render.js';
import {prepare} from './editor.js';
import {refreshGallery, regenerateGallery} from './gallery.js';
import {pollJob} from './jobs.js';

export function syncOrientation() {
  el.orientation.value = String(state.config?.rotation_degrees ?? 0);
  const config = state.config;
  el['orientation-size'].textContent = config ? `${config.width} × ${config.height} preview` : 'Connect your frame to choose its orientation.';
  el['orientation-diagram'].style.setProperty('--mount-rotation', `${config?.rotation_degrees ?? 0}deg`);
  el['orientation-status'].textContent = config && !config.orientation_supported ? 'Update your frame software to change its orientation.' : '';
}

export function previewOrientation() {
  el['orientation-diagram'].style.setProperty('--mount-rotation', `${el.orientation.value}deg`);
  controls();
}

export async function changeOrientation() {
  if (el['save-orientation'].disabled) return;
  begin(state, 'orientation'); controls();
  el['orientation-status'].textContent = 'Saving orientation…';
  try {
    const result = await jsonPost(state.frame.base, '/api/settings/display-rotation', {
      rotation_degrees:Number(el.orientation.value), expected_revision:state.config.rotation_revision});
    state.config = validateConfig(result.display);
    await rememberFrame({...state.frame, config:state.config});
    syncOrientation();
    el['frame-detail'].textContent = `Connected · ${state.config.width} × ${state.config.height}`;
    if (state.draft) await prepare();
    await refreshGallery();
    el['orientation-status'].textContent = 'Orientation saved. The screen changes when you display a photo.';
  } catch (error) {
    el['orientation-status'].textContent = `${error.message} Reconnect to get the frame’s current orientation.`;
    end(state, 'orientation'); controls(); return;
  }
  end(state, 'orientation'); controls();
  await regenerateGallery();
}

export async function testOrientation() {
  if (el['test-orientation'].disabled) return;
  begin(state, 'test-card'); controls();
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
  } finally {end(state, 'test-card'); controls();}
}
