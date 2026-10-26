import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as state from '../../static/js/core/state.js';
import { elements } from '../../static/js/core/dom.js';
import { applyFilter } from '../../static/js/services/filter-service.js';

vi.mock('../../static/js/services/image-loader.js', () => ({
  loadOriginal: vi.fn(async () => ({ src: 'data:image/png;base64,original' })),
}));

// Exercise the real save -> generation -> API path. Only browser graphics and
// the HTTP boundary are simulated; no preview canvas is available to save.
function canvas() {
  return {
    width: 2,
    height: 2,
    getContext: () => ({
      translate() {}, rotate() {}, drawImage() {}, putImageData() {},
      clearRect() {}, fillRect() {},
      getImageData: () => new ImageData(2, 2),
    }),
    toBlob: callback => callback(new Blob(['prepared PNG'], { type: 'image/png' })),
  };
}

describe('bundled Save completes the slideshow image pipeline', () => {
  let requests;
  let workerRequests;
  let failStage;
  let finishDither;
  let finalUpload;

  beforeEach(() => {
    requests = [];
    workerRequests = [];
    failStage = null;
    finalUpload = new Promise(resolve => { finishDither = resolve; });
    elements.filterStatus = { textContent: '', style: {} };
    state.setDisplayConfig({ width: 2, height: 2, thumbWidth: 1, thumbHeight: 1,
      model: 'impression-13.3-2025', rotationRevision: 3 });
    state.setCurrentFilename('favorite.png');
    state.setCurrentSessionId('editor');
    state.setIsReadOnly(false);
    state.setCurrentFilter('lanczos');
    state.setCurrentFitMode('cover');
    state.setCurrentSaturation(0.6);
    state.setCurrentBrightness(15);
    state.setCurrentContrast(-10);
    state.setCurrentDitherAlgorithm('atkinson');
    state.setCurrentPhotoRotation(90, 2);
    state.setCurrentCacheVersion(1);
    vi.stubGlobal('document', { createElement: canvas, querySelector: () => null });
    vi.stubGlobal('Image', class {
      width = 2;
      height = 2;
      set src(value) { queueMicrotask(() => this.onload()); }
    });
    vi.stubGlobal('Worker', class {
      constructor(url) { this.url = url; }
      terminate() {}
      postMessage(payload) {
        workerRequests.push({ url: this.url, payload });
        queueMicrotask(() => this.onmessage({ data: new ImageData(2, 2) }));
      }
    });
    vi.stubGlobal('fetch', vi.fn(async (path, options) => {
      requests.push({ path, body: options.body });
      if (path === '/api/lock-image') return { ok: true, json: async () => ({ locked: true }) };
      if (path === '/api/upload-dithered') await finalUpload;
      return { ok: true, json: async () => ({ success: path !== failStage,
        message: 'Save interrupted', path: 'images/thumbs/favorite.png.png' }) };
    }));
  });

  afterEach(() => {
    finishDither();
    vi.unstubAllGlobals();
  });

  it('waits for all three uploads, uses captured settings, and never flashes', async () => {
    const saving = applyFilter();
    // An in-flight preview/settings change must not change the saved snapshot.
    state.setCurrentBrightness(50);
    await vi.waitFor(() => expect(requests.at(-1)?.path).toBe('/api/upload-dithered'));
    expect(elements.filterStatus.textContent).toBe('Saving...');
    expect(state.getCurrentCacheVersion()).toBe(1);
    expect(requests.map(request => request.path)).toEqual([
      '/api/lock-image', '/api/upload-cache', '/api/upload-thumb', '/api/upload-dithered',
    ]);
    const finalBody = requests.at(-1).body;
    expect(finalBody.get('brightness')).toBe('15');
    expect(finalBody.get('filter')).toBe('lanczos');
    expect(finalBody.get('fit_mode')).toBe('cover');
    expect(finalBody.get('photo_rotation_revision')).toBe('2');
    expect(finalBody.get('rotation_revision')).toBe('3');
    expect(finalBody.get('session_id')).toBe('editor');
    expect(workerRequests.map(request => request.url)).toEqual([
      '/js/filter-worker.js', '/js/dither-worker.js',
    ]);
    expect(workerRequests[1].payload).toMatchObject({ brightness: 15, contrast: -10,
      saturation: 0.6, algorithm: 'atkinson', model: 'impression-13.3-2025' });
    finishDither();
    await saving;
    expect(elements.filterStatus.textContent).toBe('✓ Filter saved');
    expect(state.getCurrentCacheVersion()).toBe(2);
    expect(requests.some(request => request.path === '/flash')).toBe(false);
  });

  it.each(['cache', 'thumb', 'dithered'])('does not report success after a failed %s upload', async stage => {
    failStage = `/api/upload-${stage}`;
    finishDither();
    await applyFilter();
    expect(elements.filterStatus.textContent).toBe('Error: Save interrupted');
    expect(state.getCurrentCacheVersion()).toBe(1);
    expect(requests.at(-1).path).toBe(failStage);
    expect(requests.some(request => request.path === '/flash')).toBe(false);
  });
});
