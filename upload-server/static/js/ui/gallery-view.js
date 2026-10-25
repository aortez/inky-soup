/**
 * Gallery view UI module.
 * Manages gallery thumbnails and placeholder polling.
 */

import { queryAll } from '../core/dom.js';
import { CACHE_VERSION } from '../core/constants.js';
import { getGalleryImages, getThumbStatus } from '../services/api-client.js';
import { showDetailView } from './navigation.js';

const REGENERATION_CONCURRENCY = 2;

/**
 * Poll for thumbnail status and replace placeholder.
 * @param {string} filename - The filename.
 * @param {string} path - The file path.
 * @param {HTMLElement} placeholderEl - The placeholder element.
 */
async function pollThumbStatus(filename, path, placeholderEl) {
  try {
    const data = await getThumbStatus(filename);
    if (data.ready) {
      await replacePlaceholderWithThumb(filename, path, data.thumb_path, placeholderEl);
      return;
    }
  } catch (err) {
    console.error('Failed to poll thumb status:', err);
  }
  setTimeout(() => pollThumbStatus(filename, path, placeholderEl), 2000);
}

/**
 * Replace placeholder with actual thumbnail.
 * @param {string} filename - The filename.
 * @param {string} path - The file path.
 * @param {string} thumbPath - The thumbnail path.
 * @param {HTMLElement} placeholderEl - The placeholder element.
 */
async function replacePlaceholderWithThumb(filename, path, thumbPath, placeholderEl) {
  // Recovery may have used settings newer than the page's initial placeholder.
  // Refresh every saved setting on both the regeneration and polling paths.
  const saved = (await getGalleryImages()).find((photo) => photo.filename === filename);
  if (!saved?.thumb_ready) throw new Error('Photo changed while preparing its thumbnail.');
  const img = document.createElement('img');
  img.src = `${thumbPath}${thumbPath.includes('?') ? '&' : '?'}t=${Date.now()}`;
  img.alt = filename;
  img.dataset.filename = filename;
  img.dataset.path = path;
  img.dataset.filter = saved.filter ?? 'bicubic';
  img.dataset.photoRotation = saved.photo_rotation_degrees ?? '0';
  img.dataset.photoRevision = saved.photo_rotation_revision ?? '0';
  img.dataset.fitMode = saved.fit_mode ?? 'contain';
  img.dataset.cacheVersion = saved.cache_version ?? `${CACHE_VERSION}`;
  img.dataset.saturation = saved.saturation ?? '0.5';
  img.dataset.brightness = saved.brightness ?? '0';
  img.dataset.contrast = saved.contrast ?? '0';
  img.dataset.dither = saved.dither_algorithm ?? 'floyd-steinberg';
  img.loading = 'lazy';

  // Add click handler.
  img.addEventListener('click', () => {
    showDetailView(
      filename,
      path,
      img.dataset.filter,
      true,
      parseFloat(img.dataset.saturation),
      parseInt(img.dataset.brightness, 10) || 0,
      parseInt(img.dataset.contrast, 10) || 0,
      img.dataset.dither ?? 'floyd-steinberg',
      img.dataset.fitMode ?? 'contain',
      parseInt(img.dataset.cacheVersion, 10) || 1,
      Number(img.dataset.photoRotation),
      Number(img.dataset.photoRevision),
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
    const fitMode = placeholderEl?.dataset.fitMode ?? 'contain';
    const filter = placeholderEl?.dataset.filter ?? 'bicubic';
    const saturation = parseFloat(placeholderEl?.dataset.saturation ?? '0.5');
    const brightness = parseInt(placeholderEl?.dataset.brightness ?? '0', 10);
    const contrast = parseInt(placeholderEl?.dataset.contrast ?? '0', 10);
    const ditherAlgorithm = placeholderEl?.dataset.dither ?? 'floyd-steinberg';

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
      regenerate: true,
    });
    const thumbPath = thumbData?.path || `images/thumbs/${filename}.png`;
    await replacePlaceholderWithThumb(filename, path, thumbPath, placeholderEl);
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
