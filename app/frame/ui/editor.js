import {androidApp} from '../core/platform.js';
import {previewConfig, rememberPreviewConfig} from '../core/preview-profile.js';
import {elements as el} from '../core/dom.js';
import {state} from '../core/state.js';
import {allowed} from '../core/operations.js';
import {imageSettings, settingIds} from '../core/settings.js';
import {processPhoto} from '../services/processor.js';
import {saveDraft} from '../services/drafts.js';
import {activity, controls, showView, renderPreview} from './render.js';

export async function useDraft(draft) {
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

export async function prepare() {
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

export function adjustDraft(id) {
  if (!state.draft || el[id].disabled) return;
  const settings = Object.fromEntries(settingIds.map(key => [key, ['saturation', 'brightness', 'contrast', 'photo_rotation_degrees'].includes(key) ? Number(el[key].value) : el[key].value]));
  useDraft({...state.draft, ...settings});
}

export function choosePreviewProfile() {
  if (!androidApp || state.connected || !allowed(state, 'preview-profile')) return;
  state.config = previewConfig(el['preview-model'].value, el['preview-layout'].value === 'portrait');
  rememberPreviewConfig(state.config);
  el.dimensions.textContent = `${state.config.width} × ${state.config.height}`;
  prepare();
}
