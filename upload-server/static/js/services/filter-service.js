/**
 * Filter processing service using Web Workers.
 * Handles image filtering/resizing operations.
 */

import {
  CACHE_WIDTH, CACHE_HEIGHT, THUMB_WIDTH, THUMB_HEIGHT,
} from '../core/constants.js';
import {
  getFilterWorker,
  setFilterWorker,
  getCurrentFilter,
  setCurrentFilter,
  getCurrentFilename,
  getOriginalImageCache,
} from '../core/state.js';
import { elements, query } from '../core/dom.js';
import { applyDither } from './dither-service.js';
import { uploadCache, uploadThumb } from './api-client.js';
import { createImageDataFromImage, loadOriginalAndFilter } from './image-loader.js';

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
      console.log(
        `[Filter] ${filterParams.filter} completed in ${elapsed.toFixed(1)}ms (${src} → ${target})`,
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
    const freshImageData = filterCtx.getImageData(0, 0, CACHE_WIDTH, CACHE_HEIGHT);
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

  // Capture start time and params for logging.
  filterStartTime = performance.now();
  filterParams = {
    filter,
    srcWidth: imageData.width,
    srcHeight: imageData.height,
    targetWidth: CACHE_WIDTH,
    targetHeight: CACHE_HEIGHT,
  };

  worker.postMessage({
    data: imageData.data.buffer,
    width: imageData.width,
    height: imageData.height,
    targetWidth: CACHE_WIDTH,
    targetHeight: CACHE_HEIGHT,
    filter,
  }, [imageData.data.buffer]);
}

/**
 * Create ImageData from an image element and apply filtering.
 * @param {HTMLImageElement} img - The image element.
 */
function applyFilterFromImage(img) {
  const imageData = createImageDataFromImage(img);
  applyFilterToCanvas(imageData);
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
  const cache = getOriginalImageCache();
  const filename = getCurrentFilename();

  if (cache[filename]) {
    applyFilterFromImage(cache[filename]);
  } else {
    loadOriginalAndFilter(filename).then((img) => {
      applyFilterFromImage(img);
    }).catch((err) => {
      console.error('Failed to load and filter image:', err);
    });
  }
}

/**
 * Save the filtered image to the server.
 */
export async function applyFilter() {
  const statusEl = elements.filterStatus;
  const filename = getCurrentFilename();
  const filter = getCurrentFilter();

  statusEl.textContent = 'Saving...';

  try {
    // Convert filter canvas to blob.
    const cacheBlob = await new Promise((resolve) => {
      elements.filterCanvas.toBlob(resolve, 'image/png');
    });

    // Upload cache image.
    const data = await uploadCache(filename, cacheBlob);

    if (!data.success) {
      statusEl.textContent = `Error: ${data.message}`;
      statusEl.style.color = '#ff4444';
      return;
    }

    // Also regenerate thumbnail.
    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = THUMB_WIDTH;
    thumbCanvas.height = THUMB_HEIGHT;
    const thumbCtx = thumbCanvas.getContext('2d');
    thumbCtx.drawImage(elements.filterCanvas, 0, 0, THUMB_WIDTH, THUMB_HEIGHT);

    const thumbBlob = await new Promise((resolve) => {
      thumbCanvas.toBlob(resolve, 'image/png');
    });

    const thumbData = await uploadThumb(filename, thumbBlob);

    statusEl.textContent = '✓ Filter saved';
    statusEl.style.color = '#6B8E4E';

    // Update gallery thumbnail if visible.
    const galleryThumb = query(`img[data-filename="${filename}"]`);
    if (galleryThumb) {
      galleryThumb.src = `${thumbData.path}?t=${Date.now()}`;
      galleryThumb.dataset.filter = filter;
    }
  } catch (err) {
    statusEl.textContent = `Error: ${err.message}`;
    statusEl.style.color = '#ff4444';
  }
}
