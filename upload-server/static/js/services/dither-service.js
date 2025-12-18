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
  getCurrentDitherAlgorithm,
  setCurrentDitherAlgorithm,
  getCurrentBrightness,
  setCurrentBrightness,
  getCurrentContrast,
  setCurrentContrast,
} from '../core/state.js';
import { elements } from '../core/dom.js';

// Track dither operation start time for logging.
let ditherStartTime = null;
let ditherParams = null;

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

    // Log dither completion.
    if (ditherStartTime && ditherParams) {
      const elapsed = performance.now() - ditherStartTime;
      const {
        width, height, saturation, algorithm, brightness, contrast,
      } = ditherParams;
      const adjustments = brightness !== 0 || contrast !== 0
        ? `, brightness: ${brightness}, contrast: ${contrast}`
        : '';
      console.log(
        `[Dither] ${algorithm} completed in ${elapsed.toFixed(1)}ms `
        + `(${width}x${height}, saturation: ${saturation}${adjustments})`,
      );
      ditherStartTime = null;
      ditherParams = null;
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

  const saturation = getCurrentSaturation();
  const algorithm = getCurrentDitherAlgorithm();
  const brightness = getCurrentBrightness();
  const contrast = getCurrentContrast();

  // Capture start time and params for logging.
  ditherStartTime = performance.now();
  ditherParams = {
    width: imageData.width,
    height: imageData.height,
    saturation,
    algorithm,
    brightness,
    contrast,
  };

  worker.postMessage({
    data: imageData.data.buffer,
    width: imageData.width,
    height: imageData.height,
    saturation,
    algorithm,
    brightness,
    contrast,
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

/**
 * Update dither algorithm and re-dither the current image.
 * @param {string} algorithm - The dither algorithm ('floyd-steinberg', 'atkinson', 'ordered').
 */
export function updateDitherAlgorithm(algorithm) {
  setCurrentDitherAlgorithm(algorithm);

  // Update button states.
  elements.ditherButtons.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.dither === algorithm);
  });

  // Re-dither with new algorithm.
  const filterCtx = elements.filterCanvas.getContext('2d');
  const imageData = filterCtx.getImageData(0, 0, CACHE_WIDTH, CACHE_HEIGHT);
  applyDither(imageData);
}

/**
 * Update brightness and re-dither the current image.
 * @param {number|string} value - The brightness value (-100 to +100).
 */
export function updateBrightness(value) {
  const brightness = parseInt(value, 10);
  setCurrentBrightness(brightness);
  elements.brightnessValue.textContent = brightness;

  // Re-dither with new brightness.
  const filterCtx = elements.filterCanvas.getContext('2d');
  const imageData = filterCtx.getImageData(0, 0, CACHE_WIDTH, CACHE_HEIGHT);
  applyDither(imageData);
}

/**
 * Update contrast and re-dither the current image.
 * @param {number|string} value - The contrast value (-100 to +100).
 */
export function updateContrast(value) {
  const contrast = parseInt(value, 10);
  setCurrentContrast(contrast);
  elements.contrastValue.textContent = contrast;

  // Re-dither with new contrast.
  const filterCtx = elements.filterCanvas.getContext('2d');
  const imageData = filterCtx.getImageData(0, 0, CACHE_WIDTH, CACHE_HEIGHT);
  applyDither(imageData);
}
