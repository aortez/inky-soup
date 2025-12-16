/**
 * Upload service for handling file uploads and thumbnail generation.
 * Manages the upload modal and thumbnail processing.
 */

import {
  CACHE_WIDTH, CACHE_HEIGHT, THUMB_WIDTH, THUMB_HEIGHT, DEFAULT_FILTER,
} from '../core/constants.js';
import { getPendingThumbnails, setPendingThumbnails } from '../core/state.js';
import { elements } from '../core/dom.js';
import { formatSize, formatSpeed, formatTime } from '../utils/formatters.js';
import { uploadCache, uploadThumb, uploadOriginalImage } from './api-client.js';

// Dedicated filter worker for upload processing.
let uploadFilterWorker = null;

/**
 * Get or create the upload filter worker.
 * @returns {Worker} The filter worker instance.
 */
function getUploadFilterWorker() {
  if (!uploadFilterWorker) {
    uploadFilterWorker = new Worker('/js/filter-worker.js');
  }
  return uploadFilterWorker;
}

/**
 * Process an image through the filter worker.
 * @param {ImageData} imageData - Source image data.
 * @param {number} targetWidth - Target width.
 * @param {number} targetHeight - Target height.
 * @param {string} filter - Filter name to use.
 * @returns {Promise<ImageData>} Filtered image data.
 */
function filterImage(imageData, targetWidth, targetHeight, filter) {
  return new Promise((resolve, reject) => {
    const worker = getUploadFilterWorker();

    // Define handlers as function declarations to avoid use-before-define.
    function handleMessage(e) {
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);

      if (e.data.success === false) {
        reject(new Error(e.data.error));
        return;
      }

      resolve(e.data);
    }

    function handleError(e) {
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);
      reject(e);
    }

    worker.addEventListener('message', handleMessage);
    worker.addEventListener('error', handleError);

    // Transfer the buffer to the worker.
    worker.postMessage({
      data: imageData.data.buffer,
      width: imageData.width,
      height: imageData.height,
      targetWidth,
      targetHeight,
      filter,
    }, [imageData.data.buffer]);
  });
}

/**
 * Handle file selection from drop zone or file input.
 * @param {File} file - The file to upload.
 */
export function handleFileSelect(file) {
  // Validate file type.
  const validTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (!validTypes.includes(file.type)) {
    alert('Please select a valid image file (JPEG, PNG, GIF, or WebP).');
    return;
  }

  // Validate size (10MB max).
  if (file.size > 10 * 1024 * 1024) {
    alert('File is too large. Maximum size is 10 MB.');
    return;
  }

  // Show upload modal.
  showUploadModal(file);
}

/**
 * Show the upload modal and start upload.
 * @param {File} file - The file to upload.
 */
function showUploadModal(file) {
  // Reset modal state.
  elements.uploadModalTitle.textContent = 'Uploading Image';
  elements.uploadModalTitle.style.color = '#B8956A';
  elements.uploadProgress.style.width = '0%';
  elements.uploadProgress.classList.remove('complete');
  elements.processingProgressContainer.style.display = 'none';
  elements.processingProgress.style.width = '0%';
  elements.processingProgress.classList.remove('complete');
  elements.uploadPercent.textContent = '0%';
  elements.uploadSpeed.textContent = '-- MB/s';
  elements.uploadTransferred.textContent = `0 / ${formatSize(file.size)}`;
  elements.uploadTime.textContent = '0:00';
  elements.uploadNote.textContent = 'Uploading to server...';
  elements.uploadCloseBtn.style.display = 'none';

  // Preview image.
  const reader = new FileReader();
  reader.onload = (e) => {
    elements.uploadModalImage.src = e.target.result;

    // Start generating cache and thumb in parallel.
    generateThumbnails(e.target.result, file.name);
  };
  reader.readAsDataURL(file);

  elements.uploadModalFilename.textContent = file.name;
  elements.uploadModal.classList.add('active');

  // Start upload with progress tracking.
  const startTime = Date.now();

  uploadOriginalImage(
    file,
    // Progress callback.
    (e) => {
      if (e.lengthComputable) {
        const percent = Math.round((e.loaded / e.total) * 100);
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = e.loaded / elapsed;

        elements.uploadProgress.style.width = `${percent}%`;
        elements.uploadPercent.textContent = `${percent}%`;
        elements.uploadSpeed.textContent = formatSpeed(speed);
        elements.uploadTransferred.textContent = `${formatSize(e.loaded)} / ${formatSize(e.total)}`;
        elements.uploadTime.textContent = formatTime(elapsed);
      }
    },
    // Success callback.
    () => {
      elements.uploadProgress.style.width = '100%';
      elements.uploadProgress.classList.add('complete');
      elements.uploadPercent.textContent = '100%';
      elements.uploadNote.textContent = 'Upload complete! Processing thumbnails...';

      // Show processing progress.
      elements.processingProgressContainer.style.display = 'block';

      // Wait for thumbnails to finish (they started in parallel).
      checkThumbnailsReady();
    },
    // Error callback.
    (error) => {
      elements.uploadModalTitle.textContent = '✗ Upload Failed';
      elements.uploadModalTitle.style.color = '#ff6b6b';
      elements.uploadNote.textContent = error.message;
      elements.uploadCloseBtn.style.display = 'block';
    },
  );
}

/**
 * Generate cache and thumbnail images.
 * Cache uses filter worker with default filter for quality.
 * Thumbnail uses simple resize for speed.
 * @param {string} dataUrl - The data URL of the uploaded image.
 * @param {string} filename - The filename.
 */
export function generateThumbnails(dataUrl, filename) {
  const img = new Image();

  img.onload = async () => {
    // Get source image data.
    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = img.width;
    srcCanvas.height = img.height;
    const srcCtx = srcCanvas.getContext('2d');
    srcCtx.drawImage(img, 0, 0);
    const srcImageData = srcCtx.getImageData(0, 0, img.width, img.height);

    // Generate cache (600x448) using filter worker with default filter.
    try {
      const filteredData = await filterImage(
        srcImageData,
        CACHE_WIDTH,
        CACHE_HEIGHT,
        DEFAULT_FILTER,
      );

      // Convert filtered ImageData to blob.
      const cacheCanvas = document.createElement('canvas');
      cacheCanvas.width = CACHE_WIDTH;
      cacheCanvas.height = CACHE_HEIGHT;
      const cacheCtx = cacheCanvas.getContext('2d');
      cacheCtx.putImageData(filteredData, 0, 0);

      cacheCanvas.toBlob((cacheBlob) => {
        const pending = getPendingThumbnails();
        setPendingThumbnails({
          ...pending,
          cache: { blob: cacheBlob, filename, filter: DEFAULT_FILTER },
        });
        uploadPendingThumbnails(filename);
      }, 'image/png');
    } catch (err) {
      console.error('Filter worker error during upload:', err);
      // Fall back to simple resize on error.
      const cacheCanvas = document.createElement('canvas');
      cacheCanvas.width = CACHE_WIDTH;
      cacheCanvas.height = CACHE_HEIGHT;
      const cacheCtx = cacheCanvas.getContext('2d');
      cacheCtx.drawImage(img, 0, 0, CACHE_WIDTH, CACHE_HEIGHT);

      cacheCanvas.toBlob((cacheBlob) => {
        const pending = getPendingThumbnails();
        setPendingThumbnails({
          ...pending,
          cache: { blob: cacheBlob, filename, filter: null },
        });
        uploadPendingThumbnails(filename);
      }, 'image/png');
    }

    // Generate thumb (150x112) using simple resize (fast, just for gallery).
    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = THUMB_WIDTH;
    thumbCanvas.height = THUMB_HEIGHT;
    const thumbCtx = thumbCanvas.getContext('2d');
    thumbCtx.drawImage(img, 0, 0, THUMB_WIDTH, THUMB_HEIGHT);

    thumbCanvas.toBlob((thumbBlob) => {
      const pending = getPendingThumbnails();
      setPendingThumbnails({
        ...pending,
        thumb: { blob: thumbBlob, filename },
      });
      uploadPendingThumbnails(filename);
    }, 'image/png');
  };

  img.src = dataUrl;
}

/**
 * Upload pending thumbnails once both are ready.
 * @param {string} filename - The filename.
 */
export async function uploadPendingThumbnails(filename) {
  const pending = getPendingThumbnails();

  // Wait for both thumbnails to be ready.
  if (!pending.cache || !pending.thumb) return;
  if (pending.cache.filename !== filename || pending.thumb.filename !== filename) return;

  try {
    // Upload cache with filter metadata.
    const cacheData = await uploadCache(filename, pending.cache.blob, pending.cache.filter);
    if (!cacheData.success) {
      console.error('Cache upload failed:', cacheData.message);
    }

    // Upload thumb.
    const thumbData = await uploadThumb(filename, pending.thumb.blob);
    if (!thumbData.success) {
      console.error('Thumb upload failed:', thumbData.message);
    }

    // Mark thumbnails as uploaded.
    setPendingThumbnails({ ...pending, uploaded: true });
  } catch (err) {
    console.error('Error uploading thumbnails:', err);
  }
}

/**
 * Poll until thumbnails are uploaded, then show completion.
 */
export function checkThumbnailsReady() {
  // Poll until thumbnails are uploaded.
  const checkInterval = setInterval(() => {
    const pending = getPendingThumbnails();

    if (pending.uploaded) {
      clearInterval(checkInterval);
      elements.processingProgress.style.width = '100%';
      elements.processingProgress.classList.add('complete');
      elements.uploadModalTitle.textContent = '✓ Upload Complete!';
      elements.uploadModalTitle.style.color = '#6B8E4E';
      elements.uploadNote.textContent = 'Image and thumbnails ready.';
      elements.uploadCloseBtn.style.display = 'block';

      // Reset pending state.
      setPendingThumbnails({ cache: null, thumb: null });
    } else {
      // Animate processing bar.
      const current = parseFloat(elements.processingProgress.style.width) || 0;
      elements.processingProgress.style.width = `${Math.min(90, current + 10)}%`;
    }
  }, 200);
}

/**
 * Close the upload modal and reload the page.
 */
export function closeUploadModal() {
  elements.uploadModal.classList.remove('active');
  window.location.reload();
}
