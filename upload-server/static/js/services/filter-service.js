/**
 * Filter processing service using Web Workers.
 * Handles image filtering/resizing operations.
 */

import {
  getFilterWorker,
  setFilterWorker,
  getCurrentFilter,
  setCurrentFilter,
  getCurrentFilename,
  getCurrentSaturation,
  getCurrentBrightness,
  getCurrentContrast,
  getCurrentDitherAlgorithm,
  getCurrentFitMode,
  setCurrentFitMode,
  setCurrentCacheVersion,
  getCurrentSessionId,
  getIsReadOnly,
  getOriginalImageCache,
  getDisplayWidth,
  getDisplayHeight,
  getThumbWidth,
  getThumbHeight,
  getRotationDegrees,
} from '../core/state.js';
import { elements, query, queryAll } from '../core/dom.js';
import { applyDither } from './dither-service.js';
import { uploadCache, uploadThumb } from './api-client.js';
import { loadOriginal } from './image-loader.js';
import {
  createImageDataFromImage,
  drawImageToFit,
  rotateImageData,
} from '../utils/image-utils.js';
import { CACHE_VERSION } from '../core/constants.js';

// Track filter operation start time for logging.
let filterStartTime = null;
let filterParams = null;

/**
 * Initialize the filter Web Worker if not already initialized.
 */
export function initFilterWorker() {
  if (getFilterWorker()) return;

  const worker = new Worker('/js/filter-worker.js');

  worker.onmessage = (e) => {
    const result = e.data;

    // Handle error responses.
    if (result.success === false) {
      console.error('Filter worker error:', result.error);
      elements.filterProcessing.textContent = 'Processing error';
      return;
    }

    // Log filter completion.
    if (filterStartTime && filterParams) {
      const elapsed = performance.now() - filterStartTime;
      const src = `${filterParams.srcWidth}x${filterParams.srcHeight}`;
      const target = `${filterParams.targetWidth}x${filterParams.targetHeight}`;
      const fit = filterParams.fitMode ? `, fit: ${filterParams.fitMode}` : '';
      console.log(
        `[Filter] ${filterParams.filter} completed in ${elapsed.toFixed(1)}ms (${src} → ${target}${fit})`,
      );
      filterStartTime = null;
      filterParams = null;
    }

    // Result is ImageData transferred from worker.
    const imageData = result;

    // Draw to filter canvas.
    const filterCtx = elements.filterCanvas.getContext('2d');
    filterCtx.putImageData(imageData, 0, 0);

    elements.filterProcessing.textContent = '';

    // Trigger dithering - get fresh ImageData from canvas (imageData is now neutered).
    const freshImageData = filterCtx.getImageData(0, 0, getDisplayWidth(), getDisplayHeight());
    applyDither(freshImageData);
  };

  worker.onerror = (e) => {
    console.error('Filter worker error:', e);
    elements.filterProcessing.textContent = 'Processing error';
  };

  setFilterWorker(worker);
}

/**
 * Apply filtering to image data.
 * @param {ImageData} imageData - The image data to filter.
 */
export function applyFilterToCanvas(imageData) {
  elements.filterProcessing.textContent = 'Processing...';

  initFilterWorker();
  const worker = getFilterWorker();

  const filter = getCurrentFilter();
  const fitMode = getCurrentFitMode();
  const rotationDegrees = getRotationDegrees();
  const rotatedImageData = rotateImageData(imageData, rotationDegrees);

  const targetWidth = getDisplayWidth();
  const targetHeight = getDisplayHeight();

  // Capture start time and params for logging.
  filterStartTime = performance.now();
  filterParams = {
    filter,
    srcWidth: rotatedImageData.width,
    srcHeight: rotatedImageData.height,
    targetWidth,
    targetHeight,
    fitMode,
  };

  worker.postMessage({
    data: rotatedImageData.data.buffer,
    width: rotatedImageData.width,
    height: rotatedImageData.height,
    targetWidth,
    targetHeight,
    filter,
    fitMode,
  }, [rotatedImageData.data.buffer]);
}

/**
 * Create ImageData from an image element and apply filtering.
 * @param {HTMLImageElement} img - The image element.
 */
function applyFilterFromImage(img) {
  const imageData = createImageDataFromImage(img);
  applyFilterToCanvas(imageData);
}

function reprocessFromOriginal() {
  const cache = getOriginalImageCache();
  const filename = getCurrentFilename();

  if (cache[filename]) {
    applyFilterFromImage(cache[filename]);
  } else {
    elements.filterProcessing.textContent = 'Loading...';
    loadOriginal(filename).then((img) => {
      applyFilterFromImage(img);
    }).catch((err) => {
      console.error('Failed to load and filter image:', err);
      elements.filterProcessing.textContent = 'Error loading image';
    });
  }
}

/**
 * Select a new filter and re-process the current image.
 * @param {string} filter - The filter name (bicubic, lanczos, etc.).
 */
export function selectFilter(filter) {
  setCurrentFilter(filter);

  // Update buttons.
  elements.filterButtons = document.querySelectorAll('.filter-btn');
  elements.filterButtons.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });

  // Re-process from original (bypass server cache since filter changed).
  reprocessFromOriginal();
}

/**
 * Select a new fit mode and re-process the current image.
 * @param {string} mode - The fit mode ("contain" or "cover").
 */
export function selectFitMode(mode) {
  const nextMode = mode === 'cover' ? 'cover' : 'contain';
  setCurrentFitMode(nextMode);

  elements.fitModeButtons = queryAll('.fit-mode-btn');
  elements.fitModeButtons.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.fitMode === nextMode);
  });

  reprocessFromOriginal();
}

/**
 * Save the filtered image to the server.
 */
export async function applyFilter() {
  const statusEl = elements.filterStatus;

  // Check if in read-only mode.
  if (getIsReadOnly()) {
    alert('Cannot save: Image is being edited by another user');
    return;
  }

  const sessionId = getCurrentSessionId();
  if (!sessionId) {
    alert('Cannot save: No lock acquired');
    return;
  }

  const filename = getCurrentFilename();
  const filter = getCurrentFilter();
  const fitMode = getCurrentFitMode();
  const saturation = getCurrentSaturation();
  const brightness = getCurrentBrightness();
  const contrast = getCurrentContrast();
  const ditherAlgorithm = getCurrentDitherAlgorithm();

  statusEl.textContent = 'Saving...';

  try {
    // Convert filter canvas to blob.
    const cacheBlob = await new Promise((resolve) => {
      elements.filterCanvas.toBlob(resolve, 'image/png');
    });

    // Upload cache image with all current settings.
    const data = await uploadCache(
      filename,
      cacheBlob,
      filter,
      fitMode,
      saturation,
      brightness,
      contrast,
      ditherAlgorithm,
      sessionId,
    );

    if (!data.success) {
      statusEl.textContent = `Error: ${data.message}`;
      statusEl.style.color = '#ff4444';
      return;
    }

    setCurrentCacheVersion(CACHE_VERSION);

    // Also regenerate thumbnail.
    const thumbW = getThumbWidth();
    const thumbH = getThumbHeight();
    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = thumbW;
    thumbCanvas.height = thumbH;
    const thumbCtx = thumbCanvas.getContext('2d');
    drawImageToFit(thumbCtx, elements.filterCanvas, thumbW, thumbH, fitMode);

    const thumbBlob = await new Promise((resolve) => {
      thumbCanvas.toBlob(resolve, 'image/png');
    });

    const thumbData = await uploadThumb(filename, thumbBlob);

    statusEl.textContent = '✓ Filter saved';
    statusEl.style.color = '#6B8E4E';

    // Update gallery thumbnail if visible (update all data attributes so reopening restores settings).
    const galleryThumb = query(`img[data-filename="${filename}"]`);
    if (galleryThumb) {
      galleryThumb.src = `${thumbData.path}?t=${Date.now()}`;
      galleryThumb.dataset.filter = filter;
      galleryThumb.dataset.fitMode = fitMode;
      galleryThumb.dataset.cacheVersion = CACHE_VERSION.toString();
      galleryThumb.dataset.saturation = saturation.toString();
      galleryThumb.dataset.brightness = brightness.toString();
      galleryThumb.dataset.contrast = contrast.toString();
      galleryThumb.dataset.dither = ditherAlgorithm;
    }
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
    statusEl.style.color = '#ff4444';
  }
}
