/**
 * Upload service for handling file uploads and thumbnail generation.
 * Manages the upload modal and thumbnail processing.
 */

import { DEFAULT_FILTER, DEFAULT_FIT_MODE } from '../core/constants.js';
import {
  getPendingThumbnails, setPendingThumbnails,
  getDisplayWidth, getDisplayHeight, getThumbWidth, getThumbHeight,
  getUploadQueue, setUploadQueue,
  getUploadQueueActive, setUploadQueueActive,
  getUploadQueueCurrentId, setUploadQueueCurrentId,
} from '../core/state.js';
import { elements } from '../core/dom.js';
import { formatSize, formatSpeed, formatTime } from '../utils/formatters.js';
import { generateUUID } from '../utils/uuid.js';
import { drawImageToFit } from '../utils/image-utils.js';
import { uploadCache, uploadThumb, uploadOriginalImage } from './api-client.js';

// Dedicated filter worker for upload processing.
let uploadFilterWorker = null;

const VALID_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const UPLOAD_STATUS = {
  QUEUED: 'queued',
  UPLOADING: 'uploading',
  PROCESSING: 'processing',
  COMPLETE: 'complete',
  FAILED: 'failed',
};

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
 * @param {string} fitMode - Fit mode ("contain" or "cover").
 * @returns {Promise<ImageData>} Filtered image data.
 */
function filterImage(imageData, targetWidth, targetHeight, filter, fitMode) {
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
      fitMode,
    }, [imageData.data.buffer]);
  });
}

/**
 * Normalize a file selection into a flat array.
 * @param {File|FileList|File[]} selection - Selected file(s).
 * @returns {File[]} Normalized array of files.
 */
function normalizeFileSelection(selection) {
  if (!selection) return [];
  if (selection instanceof File) return [selection];
  return Array.from(selection);
}

/**
 * Validate a file for upload.
 * @param {File} file - The file to validate.
 * @returns {string|null} Error message or null if valid.
 */
function validateFile(file) {
  if (!VALID_TYPES.includes(file.type)) {
    return 'Invalid type (JPEG, PNG, GIF, or WebP only)';
  }
  if (file.size > MAX_FILE_SIZE) {
    return 'File is too large (max 10 MB)';
  }
  return null;
}

/**
 * Create a queue item for upload tracking.
 * @param {File} file - The file to upload.
 * @returns {object} Queue item.
 */
function createQueueItem(file) {
  return {
    id: generateUUID(),
    file,
    name: file.name,
    size: file.size,
    status: UPLOAD_STATUS.QUEUED,
    message: null,
  };
}

/**
 * Update a queue item by id.
 * @param {string} id - Queue item id.
 * @param {object} updates - Fields to update.
 */
function updateQueueItem(id, updates) {
  const queue = getUploadQueue();
  const nextQueue = queue.map((item) => (
    item.id === id ? { ...item, ...updates } : item
  ));
  setUploadQueue(nextQueue);
  renderQueueList();
}

/**
 * Get the display label for a queue item status.
 * @param {object} item - Queue item.
 * @returns {string} Status label.
 */
function getQueueStatusLabel(item) {
  switch (item.status) {
    case UPLOAD_STATUS.UPLOADING:
      return 'Uploading';
    case UPLOAD_STATUS.PROCESSING:
      return 'Processing';
    case UPLOAD_STATUS.COMPLETE:
      return 'Complete';
    case UPLOAD_STATUS.FAILED:
      return 'Failed';
    default:
      return 'Queued';
  }
}

/**
 * Update queue header summary.
 */
function updateQueueHeader() {
  const queue = getUploadQueue();
  const total = queue.length;
  const completed = queue.filter((item) => (
    item.status === UPLOAD_STATUS.COMPLETE || item.status === UPLOAD_STATUS.FAILED
  )).length;
  const active = queue.find((item) => (
    item.status === UPLOAD_STATUS.UPLOADING || item.status === UPLOAD_STATUS.PROCESSING
  ));
  const queued = queue.filter((item) => item.status === UPLOAD_STATUS.QUEUED).length;
  const queueLabel = total === 1 ? 'file' : 'files';
  elements.uploadQueueCount.textContent = `${total} ${queueLabel}`;

  if (total === 0) {
    elements.uploadQueueStatus.textContent = 'Queue ready';
    return;
  }

  if (active) {
    const stageLabel = active.status === UPLOAD_STATUS.PROCESSING ? 'Processing' : 'Uploading';
    elements.uploadQueueStatus.textContent = `${stageLabel} ${completed + 1} of ${total}`;
  } else if (queued > 0) {
    elements.uploadQueueStatus.textContent = `Queued ${completed + 1} of ${total}`;
  } else {
    elements.uploadQueueStatus.textContent = 'Queue complete';
  }
}

/**
 * Render the upload queue list.
 */
function renderQueueList() {
  const queue = getUploadQueue();
  elements.uploadQueueList.textContent = '';

  queue.forEach((item) => {
    const row = document.createElement('div');
    row.className = `upload-queue-item ${item.status}`;
    row.dataset.uploadId = item.id;
    if (item.message) {
      row.title = item.message;
    }

    const name = document.createElement('div');
    name.className = 'upload-queue-name';
    name.textContent = item.name;

    const meta = document.createElement('div');
    meta.className = 'upload-queue-meta';

    const status = document.createElement('span');
    status.className = 'upload-queue-status-label';
    status.textContent = getQueueStatusLabel(item);

    const size = document.createElement('span');
    size.className = 'upload-queue-size';
    size.textContent = formatSize(item.size);

    meta.append(status, size);
    row.append(name, meta);
    elements.uploadQueueList.append(row);
  });

  updateQueueHeader();
}

/**
 * Update progress text for the active queue item.
 * @param {string} id - Queue item id.
 * @param {number} percent - Upload percent.
 */
function updateQueueItemProgress(id, percent) {
  const row = elements.uploadQueueList.querySelector(`[data-upload-id="${id}"]`);
  if (!row || !row.classList.contains(UPLOAD_STATUS.UPLOADING)) return;
  const label = row.querySelector('.upload-queue-status-label');
  if (label) {
    label.textContent = `Uploading ${percent}%`;
  }
}

/**
 * Update modal title based on queue size.
 */
function updateModalTitleForQueue() {
  const total = getUploadQueue().length;
  elements.uploadModalTitle.textContent = total > 1 ? 'Uploading Images' : 'Uploading Image';
  elements.uploadModalTitle.style.color = '#B8956A';
}

/**
 * Ensure the upload modal is visible.
 */
function openUploadModal() {
  elements.uploadModal.classList.add('active');
}

/**
 * Reset modal state for a new upload.
 * @param {File} file - Current file.
 */
function resetUploadModalState(file) {
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
}

/**
 * Read a file as a data URL.
 * @param {File} file - File to read.
 * @returns {Promise<string>} Data URL.
 */
function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

/**
 * Upload a file with progress tracking.
 * @param {File} file - File to upload.
 * @param {Function} onProgress - Progress callback.
 * @returns {Promise<object>} Upload response.
 */
function uploadOriginalImageWithProgress(file, onProgress) {
  return new Promise((resolve, reject) => {
    uploadOriginalImage(file, onProgress, resolve, reject);
  });
}

/**
 * Wait for thumbnail uploads to finish.
 * @param {boolean} showProgress - Whether to animate progress bar.
 * @returns {Promise<void>} Resolves when thumbnails are done.
 */
function waitForThumbnailsReady(showProgress) {
  return new Promise((resolve) => {
    const checkInterval = setInterval(() => {
      const pending = getPendingThumbnails();

      if (pending.uploaded) {
        clearInterval(checkInterval);
        if (showProgress) {
          elements.processingProgress.style.width = '100%';
          elements.processingProgress.classList.add('complete');
        }
        setPendingThumbnails({ cache: null, thumb: null, uploaded: false });
        resolve();
        return;
      }

      if (showProgress) {
        const current = parseFloat(elements.processingProgress.style.width) || 0;
        elements.processingProgress.style.width = `${Math.min(90, current + 10)}%`;
      }
    }, 200);
  });
}

/**
 * Process the upload queue sequentially.
 */
async function processUploadQueue() {
  const queue = getUploadQueue();
  const nextItem = queue.find((item) => item.status === UPLOAD_STATUS.QUEUED);
  if (!nextItem) {
    finalizeUploadQueue();
    return;
  }

  await uploadQueueItem(nextItem);
  await processUploadQueue();
}

/**
 * Upload a single queue item.
 * @param {object} item - Queue item.
 */
async function uploadQueueItem(item) {
  updateQueueItem(item.id, { status: UPLOAD_STATUS.UPLOADING, message: null });
  setUploadQueueCurrentId(item.id);
  setPendingThumbnails({ cache: null, thumb: null, uploaded: false });

  resetUploadModalState(item.file);
  elements.uploadModalFilename.textContent = item.name;
  elements.uploadModalImage.src = '';

  const currentId = item.id;
  readFileAsDataURL(item.file)
    .then((dataUrl) => {
      if (getUploadQueueCurrentId() !== currentId) return;
      elements.uploadModalImage.src = dataUrl;
      generateThumbnails(dataUrl, item.name, DEFAULT_FIT_MODE);
    })
    .catch((err) => {
      console.error('Failed to read file for preview:', err);
      setPendingThumbnails({ cache: null, thumb: null, uploaded: true });
    });

  const startTime = Date.now();
  let uploadError = null;

  try {
    await uploadOriginalImageWithProgress(item.file, (e) => {
      if (e.lengthComputable) {
        const percent = Math.round((e.loaded / e.total) * 100);
        const elapsed = (Date.now() - startTime) / 1000;
        const speed = e.loaded / elapsed;

        elements.uploadProgress.style.width = `${percent}%`;
        elements.uploadPercent.textContent = `${percent}%`;
        elements.uploadSpeed.textContent = formatSpeed(speed);
        elements.uploadTransferred.textContent = `${formatSize(e.loaded)} / ${formatSize(e.total)}`;
        elements.uploadTime.textContent = formatTime(elapsed);

        updateQueueItemProgress(item.id, percent);
      }
    });
  } catch (err) {
    uploadError = err;
  }

  if (uploadError) {
    updateQueueItem(item.id, { status: UPLOAD_STATUS.FAILED, message: uploadError.message });
    elements.uploadNote.textContent = `Upload failed for ${item.name}. Continuing...`;
    await waitForThumbnailsReady(false);
    return;
  }

  elements.uploadProgress.style.width = '100%';
  elements.uploadProgress.classList.add('complete');
  elements.uploadPercent.textContent = '100%';
  elements.uploadNote.textContent = 'Upload complete! Processing thumbnails...';

  elements.processingProgressContainer.style.display = 'block';
  updateQueueItem(item.id, { status: UPLOAD_STATUS.PROCESSING });

  await waitForThumbnailsReady(true);

  updateQueueItem(item.id, { status: UPLOAD_STATUS.COMPLETE });
}

/**
 * Finalize the queue and show summary.
 */
function finalizeUploadQueue() {
  setUploadQueueActive(false);
  setUploadQueueCurrentId(null);

  const queue = getUploadQueue();
  const total = queue.length;
  const failed = queue.filter((item) => item.status === UPLOAD_STATUS.FAILED).length;
  const completed = queue.filter((item) => item.status === UPLOAD_STATUS.COMPLETE).length;

  if (total === 0) {
    elements.uploadModalTitle.textContent = 'Upload Queue';
    elements.uploadModalTitle.style.color = '#B8956A';
    elements.uploadNote.textContent = 'No files queued.';
  } else if (failed === 0) {
    elements.uploadModalTitle.textContent = '✓ Upload Complete!';
    elements.uploadModalTitle.style.color = '#6B8E4E';
    elements.uploadNote.textContent = `Uploaded ${completed} image${completed === 1 ? '' : 's'}.`;
  } else {
    elements.uploadModalTitle.textContent = '⚠ Upload Complete';
    elements.uploadModalTitle.style.color = '#B8956A';
    elements.uploadNote.textContent = `${completed} uploaded, ${failed} failed.`;
  }

  updateQueueHeader();
  elements.uploadCloseBtn.style.display = 'block';
}

/**
 * Handle file selection from drop zone or file input.
 * @param {File|FileList|File[]} selection - File(s) to upload.
 */
export function handleFileSelect(selection) {
  const files = normalizeFileSelection(selection);
  if (files.length === 0) return;

  const invalid = [];
  const newItems = [];

  files.forEach((file) => {
    const error = validateFile(file);
    if (error) {
      invalid.push(`${file.name}: ${error}`);
    } else {
      newItems.push(createQueueItem(file));
    }
  });

  if (invalid.length > 0) {
    alert(`Skipped ${invalid.length} file${invalid.length === 1 ? '' : 's'}:\n${invalid.join('\n')}`);
  }

  if (newItems.length === 0) return;

  const queue = getUploadQueue();
  setUploadQueue([...queue, ...newItems]);
  renderQueueList();
  updateModalTitleForQueue();
  openUploadModal();

  if (!getUploadQueueActive()) {
    setUploadQueueActive(true);
    processUploadQueue().catch((err) => {
      console.error('Upload queue failed:', err);
      finalizeUploadQueue();
    });
  }
}

/**
 * Generate cache and thumbnail images.
 * Cache uses filter worker with default filter for quality.
 * Thumbnail uses simple resize for speed.
 * @param {string} dataUrl - The data URL of the uploaded image.
 * @param {string} filename - The filename.
 * @param {string} fitMode - The fit mode ("contain" or "cover").
 */
export function generateThumbnails(dataUrl, filename, fitMode = DEFAULT_FIT_MODE) {
  const img = new Image();
  const mode = fitMode === 'cover' ? 'cover' : DEFAULT_FIT_MODE;

  img.onload = async () => {
    // Get source image data.
    const srcCanvas = document.createElement('canvas');
    srcCanvas.width = img.width;
    srcCanvas.height = img.height;
    const srcCtx = srcCanvas.getContext('2d');
    srcCtx.drawImage(img, 0, 0);
    const srcImageData = srcCtx.getImageData(0, 0, img.width, img.height);

    // Get current display dimensions from state.
    const cacheWidth = getDisplayWidth();
    const cacheHeight = getDisplayHeight();
    const thumbWidth = getThumbWidth();
    const thumbHeight = getThumbHeight();

    // Generate cache using filter worker with default filter.
    try {
      const filteredData = await filterImage(
        srcImageData,
        cacheWidth,
        cacheHeight,
        DEFAULT_FILTER,
        mode,
      );

      // Convert filtered ImageData to blob.
      const cacheCanvas = document.createElement('canvas');
      cacheCanvas.width = cacheWidth;
      cacheCanvas.height = cacheHeight;
      const cacheCtx = cacheCanvas.getContext('2d');
      cacheCtx.putImageData(filteredData, 0, 0);

      cacheCanvas.toBlob((cacheBlob) => {
        const pending = getPendingThumbnails();
        setPendingThumbnails({
          ...pending,
          cache: {
            blob: cacheBlob,
            filename,
            filter: DEFAULT_FILTER,
            fitMode: mode,
          },
        });
        uploadPendingThumbnails(filename);
      }, 'image/png');
    } catch (err) {
      console.error('Filter worker error during upload:', err);
      // Fall back to simple resize on error.
      const cacheCanvas = document.createElement('canvas');
      cacheCanvas.width = cacheWidth;
      cacheCanvas.height = cacheHeight;
      const cacheCtx = cacheCanvas.getContext('2d');
      drawImageToFit(cacheCtx, img, cacheWidth, cacheHeight, mode);

      cacheCanvas.toBlob((cacheBlob) => {
        const pending = getPendingThumbnails();
        setPendingThumbnails({
          ...pending,
          cache: {
            blob: cacheBlob,
            filename,
            filter: null,
            fitMode: mode,
          },
        });
        uploadPendingThumbnails(filename);
      }, 'image/png');
    }

    // Generate thumbnail using simple resize (fast, just for gallery).
    const thumbCanvas = document.createElement('canvas');
    thumbCanvas.width = thumbWidth;
    thumbCanvas.height = thumbHeight;
    const thumbCtx = thumbCanvas.getContext('2d');
    drawImageToFit(thumbCtx, img, thumbWidth, thumbHeight, mode);

    thumbCanvas.toBlob((thumbBlob) => {
      const pending = getPendingThumbnails();
      setPendingThumbnails({
        ...pending,
        thumb: {
          blob: thumbBlob,
          filename,
          fitMode: mode,
        },
      });
      uploadPendingThumbnails(filename);
    }, 'image/png');
  };

  img.onerror = () => {
    console.error('Failed to load image for thumbnail generation:', filename);
    setPendingThumbnails({ cache: null, thumb: null, uploaded: true });
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
    // Upload cache with filter metadata (use defaults for dither settings on upload).
    // No session_id for new uploads (no lock required).
    const cacheData = await uploadCache(
      filename,
      pending.cache.blob,
      pending.cache.filter,
      pending.cache.fitMode || DEFAULT_FIT_MODE,
      0.5, // default saturation
      0, // default brightness
      0, // default contrast
      'floyd-steinberg', // default dither algorithm
      null, // no session required for new uploads
    );
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
 * Close the upload modal and reload the page.
 */
export function closeUploadModal() {
  elements.uploadModal.classList.remove('active');
  setUploadQueue([]);
  setUploadQueueActive(false);
  setUploadQueueCurrentId(null);
  setPendingThumbnails({ cache: null, thumb: null, uploaded: false });
  window.location.reload();
}
