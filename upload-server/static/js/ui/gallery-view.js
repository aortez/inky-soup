/**
 * Gallery view UI module.
 * Manages gallery thumbnails and placeholder polling.
 */

import { queryAll } from '../core/dom.js';
import { getThumbStatus } from '../services/api-client.js';
import { showDetailView } from './navigation.js';

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
  const img = document.createElement('img');
  img.src = thumbPath;
  img.alt = filename;
  img.dataset.filename = filename;
  img.dataset.path = path;
  img.dataset.filter = 'bicubic';
  img.loading = 'lazy';

  // Add click handler.
  img.addEventListener('click', () => {
    showDetailView(filename, path, 'bicubic', true);
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

    // Load the original image.
    const img = new Image();
    img.crossOrigin = 'anonymous';

    img.onload = () => {
      // Create data URL from image.
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const dataUrl = canvas.toDataURL('image/png');

      // Generate and upload thumbnails.
      generateThumbnails(dataUrl, filename);

      // Continue polling - thumb should appear soon.
      pollThumbStatus(filename, path, placeholderEl);
    };

    img.onerror = () => {
      console.error(`Failed to load image for thumbnail generation: ${path}`);
      // Fall back to polling.
      pollThumbStatus(filename, path, placeholderEl);
    };

    img.src = path;
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
  // Start processing for any placeholder thumbnails.
  queryAll('.thumbnail-placeholder').forEach((placeholder) => {
    const { filename } = placeholder.dataset;
    const { path } = placeholder.dataset;

    if (filename && path) {
      // Generate the missing thumbnail instead of just polling.
      generateMissingThumb(filename, path, placeholder);
    }
  });
}
