/**
 * Dither processing service using Web Workers.
 * Handles Floyd-Steinberg dithering for e-ink display.
 */

import { CACHE_WIDTH, CACHE_HEIGHT } from '../core/constants.js';
import {
  getDitherWorker,
  setDitherWorker,
  getCurrentSaturation,
  setCurrentSaturation,
} from '../core/state.js';
import { elements } from '../core/dom.js';

/**
 * Initialize the dither Web Worker if not already initialized.
 */
export function initDitherWorker() {
  if (getDitherWorker()) return;

  const worker = new Worker('/js/dither-worker.js');

  worker.onmessage = (e) => {
    const result = e.data;

    // Handle error responses.
    if (result.success === false) {
      console.error('Dither worker error:', result.error);
      elements.ditherProcessing.textContent = 'Dithering error';
      return;
    }

    // Result is ImageData transferred from worker.
    const imageData = result;

    // Draw to dither canvas.
    const ditherCtx = elements.ditherCanvas.getContext('2d');
    ditherCtx.putImageData(imageData, 0, 0);

    elements.ditherProcessing.textContent = '';
  };

  worker.onerror = (e) => {
    console.error('Dither worker error:', e);
    elements.ditherProcessing.textContent = 'Dithering error';
  };

  setDitherWorker(worker);
}

/**
 * Apply dithering to image data.
 * @param {ImageData} imageData - The image data to dither.
 */
export function applyDither(imageData) {
  elements.ditherProcessing.textContent = 'Dithering...';

  initDitherWorker();
  const worker = getDitherWorker();

  worker.postMessage({
    data: imageData.data.buffer,
    width: imageData.width,
    height: imageData.height,
    saturation: getCurrentSaturation(),
  }, [imageData.data.buffer]);
}

/**
 * Update saturation and re-dither the current image.
 * @param {number|string} value - The saturation value (0.1 to 1.0).
 */
export function updateSaturation(value) {
  const saturation = parseFloat(value);
  setCurrentSaturation(saturation);
  elements.saturationValue.textContent = value;

  // Re-dither with new saturation.
  const filterCtx = elements.filterCanvas.getContext('2d');
  const imageData = filterCtx.getImageData(0, 0, CACHE_WIDTH, CACHE_HEIGHT);
  applyDither(imageData);
}
