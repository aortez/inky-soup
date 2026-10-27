import {androidApp} from '../core/platform.js';
import {jobForFrame} from '../core/frame-registry.js';
import {elements as el} from '../core/dom.js';
import {state, rememberJob} from '../core/state.js';
import {identifyFrame} from '../services/frame-discovery.js';
import {request} from '../services/frame-client.js';
import {activity, controls} from './render.js';
import {acquireEditLock} from './edit-lock.js';
import {refreshGallery, regenerateGallery} from './gallery.js';

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

export function showJobUnavailable(error, job) {
  activity('Refresh status unavailable', `${error.message} The job may still be running.`, true, 'none', job.kind);
  el['retry-status'].hidden = false;
  el['test-retry-status'].hidden = false;
}

export async function pollJob() {
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
