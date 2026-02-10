/**
 * Gallery view UI module.
 * Manages gallery thumbnails and placeholder polling.
 */

import { queryAll } from '../core/dom.js';
import { CACHE_VERSION } from '../core/constants.js';
import { getThumbStatus } from '../services/api-client.js';
import { showDetailView } from './navigation.js';

const REGENERATION_CONCURRENCY = 2;

/**
 * Poll for thumbnail status and replace placeholder.
 * @param {string} filename - The filename.
 * @param {string} path - The file path.
 * @param {HTMLElement} placeholderEl - The placeholder element.
 */
function pollThumbStatus(filename, path, placeholderEl) {
  getThumbStatus(filename)
    .then((data) => {
      if (data.ready) {
        // Thumbnail is ready - replace placeholder.
        replacePlaceholderWithThumb(filename, path, data.thumb_path, placeholderEl);
      } else {
        // Not ready yet - poll again in 2 seconds.
        setTimeout(() => pollThumbStatus(filename, path, placeholderEl), 2000);
      }
    })
    .catch((err) => {
      console.error('Failed to poll thumb status:', err);
      // Retry on error.
      setTimeout(() => pollThumbStatus(filename, path, placeholderEl), 2000);
    });
}

/**
 * Replace placeholder with actual thumbnail.
 * @param {string} filename - The filename.
 * @param {string} path - The file path.
 * @param {string} thumbPath - The thumbnail path.
 * @param {HTMLElement} placeholderEl - The placeholder element.
 */
function replacePlaceholderWithThumb(filename, path, thumbPath, placeholderEl) {
  const dataset = placeholderEl ? placeholderEl.dataset : {};
  const img = document.createElement('img');
  img.src = thumbPath;
  img.alt = filename;
  img.dataset.filename = filename;
  img.dataset.path = path;
  img.dataset.filter = dataset.filter || 'bicubic';
  img.dataset.fitMode = dataset.fitMode || 'contain';
  img.dataset.cacheVersion = dataset.cacheVersion || `${CACHE_VERSION}`;
  img.dataset.saturation = dataset.saturation || '0.5';
  img.dataset.brightness = dataset.brightness || '0';
  img.dataset.contrast = dataset.contrast || '0';
  img.dataset.dither = dataset.dither || 'floyd-steinberg';
  img.loading = 'lazy';

  // Add click handler.
  img.addEventListener('click', () => {
    showDetailView(
      filename,
      path,
      img.dataset.filter,
      true,
      parseFloat(img.dataset.saturation) || 0.5,
      parseInt(img.dataset.brightness, 10) || 0,
      parseInt(img.dataset.contrast, 10) || 0,
      img.dataset.dither || 'floyd-steinberg',
      img.dataset.fitMode || 'contain',
      parseInt(img.dataset.cacheVersion, 10) || 1,
    );
  });

  // Replace placeholder.
  if (placeholderEl && placeholderEl.parentElement) {
    placeholderEl.parentElement.replaceChild(img, placeholderEl);
  }
}

/**
 * Generate missing thumbnail for an orphaned image.
 * @param {string} filename - The filename.
 * @param {string} path - The image path.
 * @param {HTMLElement} placeholderEl - The placeholder element.
 */
async function generateMissingThumb(filename, path, placeholderEl) {
  try {
    // Dynamically import to avoid circular dependencies.
    const { generateThumbnails } = await import('../services/upload-service.js');
    const fitMode = placeholderEl?.dataset.fitMode || 'contain';
    const filter = placeholderEl?.dataset.filter || 'bicubic';
    const saturation = parseFloat(placeholderEl?.dataset.saturation || '0.5');
    const brightness = parseInt(placeholderEl?.dataset.brightness || '0', 10);
    const contrast = parseInt(placeholderEl?.dataset.contrast || '0', 10);
    const ditherAlgorithm = placeholderEl?.dataset.dither || 'floyd-steinberg';

    // Load the original image and convert it to a data URL.
    const dataUrl = await new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = () => {
        reject(new Error(`Failed to load image for thumbnail generation: ${path}`));
      };
      img.src = path;
    });

    const { thumbData } = await generateThumbnails(dataUrl, filename, {
      fitMode,
      filter,
      saturation,
      brightness,
      contrast,
      ditherAlgorithm,
      sessionId: null,
    });
    const thumbPath = thumbData?.path || `images/thumbs/${filename}.png`;
    replacePlaceholderWithThumb(filename, path, `${thumbPath}?t=${Date.now()}`, placeholderEl);
  } catch (err) {
    console.error('Failed to generate missing thumbnail:', err);
    // Fall back to polling.
    pollThumbStatus(filename, path, placeholderEl);
  }
}

/**
 * Initialize gallery view.
 */
export function initGalleryView() {
  const placeholders = Array.from(queryAll('.thumbnail-placeholder'));
  if (placeholders.length === 0) return;

  // Regenerate in a small worker pool to avoid race conditions and worker overload.
  let nextIndex = 0;
  const runNext = () => {
    const placeholder = placeholders[nextIndex];
    nextIndex += 1;
    if (!placeholder) return Promise.resolve();

    const { filename } = placeholder.dataset;
    const { path } = placeholder.dataset;
    if (!filename || !path) {
      return runNext();
    }

    return generateMissingThumb(filename, path, placeholder).then(runNext);
  };

  const workers = Array.from(
    { length: Math.min(REGENERATION_CONCURRENCY, placeholders.length) },
    () => runNext(),
  );

  Promise.all(workers).catch((err) => {
    console.error('Background regeneration failed:', err);
  });
}
