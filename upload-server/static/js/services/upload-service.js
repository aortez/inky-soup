/**
 * Upload service for handling file uploads and thumbnail generation.
 * Manages the upload modal and thumbnail processing.
 */

import { DEFAULT_FILTER, DEFAULT_FIT_MODE } from '../core/constants.js';
import {
  getDisplayWidth, getDisplayHeight, getThumbWidth, getThumbHeight,
  getRotationDegrees,
  getUploadQueue, setUploadQueue,
  getUploadQueueActive, setUploadQueueActive,
  getUploadQueueCurrentId, setUploadQueueCurrentId,
} from '../core/state.js';
import { elements } from '../core/dom.js';
import { formatSize, formatSpeed, formatTime } from '../utils/formatters.js';
import { generateUUID } from '../utils/uuid.js';
import {
  createImageDataFromImage,
  drawImageToFit,
  imageDataToCanvas,
  rotateImageData,
} from '../utils/image-utils.js';
import {
  uploadCache,
  uploadDithered,
  uploadThumb,
  uploadOriginalImage,
} from './api-client.js';

const VALID_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const UPLOAD_STATUS = {
  QUEUED: 'queued',
  UPLOADING: 'uploading',
  PROCESSING: 'processing',
  COMPLETE: 'complete',
  FAILED: 'failed',
};
const VALID_FILTERS = new Set(['bicubic', 'lanczos', 'mitchell', 'bilinear', 'nearest']);
const VALID_DITHER_ALGORITHMS = new Set(['floyd-steinberg', 'atkinson', 'ordered']);

function normalizeFilter(filter) {
  return VALID_FILTERS.has(filter) ? filter : DEFAULT_FILTER;
}

function normalizeFitMode(fitMode) {
  return fitMode === 'cover' ? 'cover' : DEFAULT_FIT_MODE;
}

function normalizeDitherAlgorithm(algorithm) {
  return VALID_DITHER_ALGORITHMS.has(algorithm) ? algorithm : 'floyd-steinberg';
}

function normalizeNumeric(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function runWorkerTask(workerUrl, payload, transferList = []) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl);

    function handleMessage(e) {
      if (e.data.success === false) {
        worker.terminate();
        reject(new Error(e.data.error));
        return;
      }

      worker.terminate();
      resolve(e.data);
    }

    function handleError(e) {
      worker.terminate();
      reject(e);
    }

    worker.onmessage = handleMessage;
    worker.onerror = handleError;
    worker.postMessage(payload, transferList);
  });
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
  return runWorkerTask('/js/filter-worker.js', {
    data: imageData.data.buffer,
    width: imageData.width,
    height: imageData.height,
    targetWidth,
    targetHeight,
    filter,
    fitMode,
  }, [imageData.data.buffer]);
}

function ditherImage(imageData, saturation, algorithm, brightness, contrast) {
  return runWorkerTask('/js/dither-worker.js', {
    data: imageData.data.buffer,
    width: imageData.width,
    height: imageData.height,
    saturation,
    algorithm,
    brightness,
    contrast,
  }, [imageData.data.buffer]);
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error('Failed to encode PNG'));
        return;
      }
      resolve(blob);
    }, 'image/png');
  });
}

function loadImageFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to decode source image'));
    img.src = dataUrl;
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

  resetUploadModalState(item.file);
  elements.uploadModalFilename.textContent = item.name;
  elements.uploadModalImage.src = '';

  const currentId = item.id;
  const previewDataUrlPromise = readFileAsDataURL(item.file)
    .then((dataUrl) => {
      if (getUploadQueueCurrentId() !== currentId) return null;
      elements.uploadModalImage.src = dataUrl;
      return dataUrl;
    })
    .catch((err) => {
      console.error('Failed to read file for preview:', err);
      return null;
    });

  const startTime = Date.now();
  let uploadError = null;
  let uploadResponse = null;

  try {
    uploadResponse = await uploadOriginalImageWithProgress(item.file, (e) => {
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
    return;
  }

  const uploadedFilename = uploadResponse?.filename || item.name;
  updateQueueItem(item.id, { name: uploadedFilename });
  elements.uploadModalFilename.textContent = uploadedFilename;

  elements.uploadProgress.style.width = '100%';
  elements.uploadProgress.classList.add('complete');
  elements.uploadPercent.textContent = '100%';
  elements.uploadNote.textContent = 'Upload complete! Processing thumbnails...';

  elements.processingProgressContainer.style.display = 'block';
  updateQueueItem(item.id, { status: UPLOAD_STATUS.PROCESSING });

  const previewDataUrl = await previewDataUrlPromise;

  if (!previewDataUrl) {
    const message = `Missing preview data for ${uploadedFilename}`;
    updateQueueItem(item.id, { status: UPLOAD_STATUS.FAILED, message });
    elements.uploadNote.textContent = `Failed to process ${uploadedFilename}. Continuing...`;
    return;
  }

  elements.processingProgress.style.width = '35%';
  try {
    await generateThumbnails(previewDataUrl, uploadedFilename, {
      fitMode: DEFAULT_FIT_MODE,
      filter: DEFAULT_FILTER,
      saturation: 0.5,
      brightness: 0,
      contrast: 0,
      ditherAlgorithm: 'floyd-steinberg',
      sessionId: null,
    });
  } catch (err) {
    const message = err?.message || `Failed to finish ${uploadedFilename}`;
    updateQueueItem(item.id, { status: UPLOAD_STATUS.FAILED, message });
    elements.uploadNote.textContent = `Failed to finish ${uploadedFilename}. Continuing...`;
    return;
  }

  elements.processingProgress.style.width = '100%';
  elements.processingProgress.classList.add('complete');
  updateQueueItem(item.id, { status: UPLOAD_STATUS.COMPLETE, message: null });
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
    alert(
      `Skipped ${invalid.length} file${invalid.length === 1 ? '' : 's'}:\n${invalid.join('\n')}`,
    );
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
 * @param {string} dataUrl - The data URL of the uploaded image.
 * @param {string} filename - The filename.
 * @param {object} options - Generation options.
 * @param {string} [options.fitMode] - The fit mode ("contain" or "cover").
 * @param {string} [options.filter] - The resize filter.
 * @param {number} [options.saturation] - Dither saturation.
 * @param {number} [options.brightness] - Dither brightness.
 * @param {number} [options.contrast] - Dither contrast.
 * @param {string} [options.ditherAlgorithm] - Dither algorithm.
 * @param {string|null} [options.sessionId] - Optional lock session id.
 * @returns {Promise<{cacheData: object, thumbData: object, ditherData: object}>}
 */
export async function generateThumbnails(dataUrl, filename, options = {}) {
  const mode = normalizeFitMode(options.fitMode);
  const filter = normalizeFilter(options.filter);
  const ditherAlgorithm = normalizeDitherAlgorithm(options.ditherAlgorithm);
  const saturation = normalizeNumeric(options.saturation, 0.5);
  const brightness = normalizeNumeric(options.brightness, 0);
  const contrast = normalizeNumeric(options.contrast, 0);
  const sessionId = options.sessionId || null;

  const img = await loadImageFromDataUrl(dataUrl);
  const sourceImageData = createImageDataFromImage(img);
  const rotationDegrees = getRotationDegrees();
  const rotatedImageData = rotateImageData(sourceImageData, rotationDegrees);
  const rotatedSource = imageDataToCanvas(rotatedImageData);

  const cacheWidth = getDisplayWidth();
  const cacheHeight = getDisplayHeight();
  const thumbWidth = getThumbWidth();
  const thumbHeight = getThumbHeight();

  const cacheCanvas = document.createElement('canvas');
  cacheCanvas.width = cacheWidth;
  cacheCanvas.height = cacheHeight;
  const cacheCtx = cacheCanvas.getContext('2d');

  // Generate cache image with worker filter, fallback to direct draw on worker failure.
  try {
    const filteredData = await filterImage(rotatedImageData, cacheWidth, cacheHeight, filter, mode);
    cacheCtx.putImageData(filteredData, 0, 0);
  } catch (err) {
    console.error('Filter worker error during upload:', err);
    drawImageToFit(cacheCtx, rotatedSource, cacheWidth, cacheHeight, mode);
  }

  const cacheBlob = await canvasToBlob(cacheCanvas);

  const thumbCanvas = document.createElement('canvas');
  thumbCanvas.width = thumbWidth;
  thumbCanvas.height = thumbHeight;
  const thumbCtx = thumbCanvas.getContext('2d');
  drawImageToFit(thumbCtx, rotatedSource, thumbWidth, thumbHeight, mode);
  const thumbBlob = await canvasToBlob(thumbCanvas);

  const cacheImageData = cacheCtx.getImageData(0, 0, cacheWidth, cacheHeight);
  const ditheredImageData = await ditherImage(
    cacheImageData,
    saturation,
    ditherAlgorithm,
    brightness,
    contrast,
  );
  const ditherCanvas = document.createElement('canvas');
  ditherCanvas.width = cacheWidth;
  ditherCanvas.height = cacheHeight;
  ditherCanvas.getContext('2d').putImageData(ditheredImageData, 0, 0);
  const ditherBlob = await canvasToBlob(ditherCanvas);

  const cacheData = await uploadCache(
    filename,
    cacheBlob,
    filter,
    mode,
    saturation,
    brightness,
    contrast,
    ditherAlgorithm,
    sessionId,
  );
  if (!cacheData.success) {
    throw new Error(cacheData.message || 'Cache upload failed');
  }

  const thumbData = await uploadThumb(filename, thumbBlob);
  if (!thumbData.success) {
    throw new Error(thumbData.message || 'Thumbnail upload failed');
  }

  const ditherData = await uploadDithered(
    filename,
    ditherBlob,
    filter,
    mode,
    saturation,
    brightness,
    contrast,
    ditherAlgorithm,
    sessionId,
  );
  if (!ditherData.success) {
    throw new Error(ditherData.message || 'Dithered upload failed');
  }

  return { cacheData, thumbData, ditherData };
}

/**
 * Close the upload modal and reload the page.
 */
export function closeUploadModal() {
  elements.uploadModal.classList.remove('active');
  setUploadQueue([]);
  setUploadQueueActive(false);
  setUploadQueueCurrentId(null);
  window.location.reload();
}
