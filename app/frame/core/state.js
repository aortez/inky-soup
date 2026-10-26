import {androidApp} from './platform.js';
import {frameRegistry} from './frame-registry.js';
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

export const registry = frameRegistry(localStorage);

export function rememberFrame(frame) {
  if (androidApp && frame.id) registry.remember(frame);
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
  state.job = job;
  try {
    if (job) localStorage.setItem('sparkle-job', JSON.stringify(job));
    else localStorage.removeItem('sparkle-job');
  } catch { /* A live job can still be tracked without persistent storage. */ }
}

export function savedJob() {
  try { return JSON.parse(localStorage.getItem('sparkle-job')); } catch { return null; }
}
