import {editSession} from './edit-session.js';

export const state = {
  frame: null, config: null, images: [], draft: null, prepared: null,
  connected: false, connecting: false, galleryGeneration: 0,
  busy: false, processing: false, processor: null, generation: 0,
  previewUrl: null, beforeUrl: null, galleryUrls: [], job: null, pollTimer: null,
  view: 'editor', previewMode: 'display', lock: null, imports: [], importing: false,
  session: null, installPrompt: null,
  updateWorker: null, updating: false, updateError: '',
};

export const sessionReady = editSession().then(session => {state.session = session;});

export function rememberFrame(frame) {
  state.frame = frame;
  try { localStorage.setItem('sparkle-frame', JSON.stringify(frame)); } catch { /* Storage can be disabled. */ }
}

export function savedFrame() {
  try { return JSON.parse(localStorage.getItem('sparkle-frame')); } catch { return null; }
}

export function rememberJob(job) {
  state.job = job;
  try {
    if (job) localStorage.setItem('sparkle-job', JSON.stringify(job));
    else localStorage.removeItem('sparkle-job');
  } catch { /* A live job can still be tracked without persistent storage. */ }
}

export function savedJob() {
  try { return JSON.parse(localStorage.getItem('sparkle-job')); } catch { return null; }
}
