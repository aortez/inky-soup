/**
 * Image loading and caching service.
 * Handles loading images from the server with fallback logic.
 */

import { CACHE_WIDTH, CACHE_HEIGHT } from '../core/constants.js';
import { getOriginalImageCache, setOriginalImageCache } from '../core/state.js';
import { elements } from '../core/dom.js';
import { applyDither } from './dither-service.js';

/**
 * Load an image for processing in the detail view.
 * Tries to load from cache first, falls back to original if needed.
 * @param {string} filename - The filename to load.
 */
export function loadImageForProcessing(filename) {
  // Try to load from server-side cache first (600x448 PNG already filtered).
  const cachedImg = new Image();
  cachedImg.crossOrigin = 'anonymous';

  cachedImg.onload = () => {
    // Cache exists - use it directly, skip filtering.
    elements.filterProcessing.textContent = '';

    // Draw cached image to filter canvas.
    const filterCtx = elements.filterCanvas.getContext('2d');
    filterCtx.drawImage(cachedImg, 0, 0);

    // Get ImageData for dithering.
    const imageData = filterCtx.getImageData(0, 0, CACHE_WIDTH, CACHE_HEIGHT);
    applyDither(imageData);
  };

  cachedImg.onerror = () => {
    // Cache doesn't exist - fall back to loading and filtering original.
    loadOriginalAndFilter(filename);
  };

  cachedImg.src = `images/cache/${filename}.png`;
}

/**
 * Load the original image.
 * Uses in-memory cache for loaded originals.
 * @param {string} filename - The filename to load.
 * @returns {Promise<HTMLImageElement>} Promise that resolves with the image element.
 */
export function loadOriginalAndFilter(filename) {
  return new Promise((resolve, reject) => {
    const cache = getOriginalImageCache();

    // Check in-memory cache first (return the cached image to be processed).
    if (cache[filename]) {
      resolve(cache[filename]);
      return;
    }

    // Load the full original image.
    const img = new Image();
    img.crossOrigin = 'anonymous';

    img.onload = () => {
      // Cache the image element.
      const newCache = { ...cache, [filename]: img };
      setOriginalImageCache(newCache);

      resolve(img);
    };

    img.onerror = () => {
      console.error('Failed to load image:', filename);
      elements.filterProcessing.textContent = 'Error loading image';
      reject(new Error(`Failed to load image: ${filename}`));
    };

    img.src = `images/${filename}`;
  });
}

/**
 * Create ImageData from an image element.
 * @param {HTMLImageElement} img - The image element.
 * @returns {ImageData} The ImageData extracted from the image.
 */
export function createImageDataFromImage(img) {
  // Create fresh ImageData from the image element.
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, img.width, img.height);
}
