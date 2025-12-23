/**
 * Image loading and caching service.
 * Loads images with cache-first strategy. Does not process — caller coordinates that.
 */

import {
  getOriginalImageCache,
  setOriginalImageCache,
  getDisplayWidth,
  getDisplayHeight,
} from '../core/state.js';
import { elements } from '../core/dom.js';
import { createImageDataFromImage } from '../utils/image-utils.js';

/**
 * Load an image using cache-first strategy.
 * Returns the image data and whether filtering is needed.
 * @param {string} filename - The filename to load.
 * @returns {Promise<{imageData: ImageData, needsFiltering: boolean}>} The loaded image data.
 */
export async function loadImageUsingCache(filename) {
  const expectedWidth = getDisplayWidth();
  const expectedHeight = getDisplayHeight();

  // Try to load from server-side cache first.
  try {
    const cachedImg = await loadCachedImage(filename);

    // Check if cached image matches current display dimensions.
    if (cachedImg.width !== expectedWidth || cachedImg.height !== expectedHeight) {
      console.log(
        `[ImageLoader] Cache dimensions mismatch: ${cachedImg.width}x${cachedImg.height} `
        + `vs expected ${expectedWidth}x${expectedHeight}. Loading original.`,
      );
      const img = await loadOriginal(filename);
      const imageData = createImageDataFromImage(img);
      return { imageData, needsFiltering: true };
    }

    // Cache exists and matches — extract ImageData directly.
    const imageData = createImageDataFromImage(cachedImg);
    return { imageData, needsFiltering: false };
  } catch {
    // Cache doesn't exist — load original.
    const img = await loadOriginal(filename);
    const imageData = createImageDataFromImage(img);
    return { imageData, needsFiltering: true };
  }
}

/**
 * Load a cached image from the server.
 * @param {string} filename - The filename.
 * @returns {Promise<HTMLImageElement>} The cached image element.
 */
function loadCachedImage(filename) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Cache not found'));
    img.src = `images/cache/${filename}.png`;
  });
}

/**
 * Load the original image.
 * Uses in-memory cache for loaded originals.
 * @param {string} filename - The filename to load.
 * @returns {Promise<HTMLImageElement>} Promise that resolves with the image element.
 */
export function loadOriginal(filename) {
  return new Promise((resolve, reject) => {
    const cache = getOriginalImageCache();

    // Check in-memory cache first.
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
