import {androidApp} from './platform.js';
import {frameRegistry} from './frame-registry.js';
import {registryStorage} from './registry-storage.js';
import {savedJobs} from './saved-jobs.js';
import {editSession} from './edit-session.js';

export const state = {
  setup: null, discovery: null, discovered: [], reconnectTimer: null, foreground: true,
  frame: null, config: null, images: [], draft: null, prepared: null,
  connected: false, connecting: false, galleryGeneration: 0,
  busy: false, processing: false, processor: null, generation: 0,
  previewUrl: null, beforeUrl: null, galleryUrls: [], job: null, pollTimer: null,
  view: 'editor', previewMode: 'display', lock: null, imports: [], importing: false,
  session: null, installPrompt: null,
  updateWorker: null, updating: false, updateError: '',
};

export const sessionReady = editSession().then(session => {state.session = session;});

const durableRegistry = androidApp ? registryStorage(localStorage) : null;
export const restoreRegistry = () => durableRegistry?.restore();
export const registry = frameRegistry(localStorage, (value, signal) => durableRegistry?.save(value, signal));
const jobs = savedJobs(localStorage);

export async function rememberFrame(frame, signal) {
  if (androidApp && frame.id) await registry.remember(frame, signal);
  state.frame = frame;
  try { localStorage.setItem('sparkle-frame', JSON.stringify(frame)); } catch { /* Storage can be disabled. */ }
}

export function savedFrame() {
  if (androidApp) {
    try {const selected = registry.selected(); if (selected) return selected;} catch { return null; }
  }
  try { return JSON.parse(localStorage.getItem('sparkle-frame')); } catch { return null; }
}

export function rememberJob(job) {
  const previous = state.job;
  state.job = job;
  try {
    if (androidApp) {
      if (job) jobs.put(job);
      else jobs.remove(previous?.deviceId || state.frame?.id);
      return;
    }
    if (job) localStorage.setItem('sparkle-job', JSON.stringify(job));
    else localStorage.removeItem('sparkle-job');
  } catch { /* A live job can still be tracked without persistent storage. */ }
}

export function savedJob() {
  if (androidApp) {
    try {return jobs.get(state.frame?.id);} catch {return null;}
  }
  try { return JSON.parse(localStorage.getItem('sparkle-job')); } catch { return null; }
}

export function forgetSavedJob(deviceId) {
  try {jobs.remove(deviceId);} catch { /* Storage can be disabled. */ }
}
