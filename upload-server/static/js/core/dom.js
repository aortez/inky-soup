/**
 * Cached DOM element references.
 * All elements are queried once during initialization.
 */

export const elements = {};

/**
 * Initialize DOM cache by querying all elements once.
 * Should be called on DOMContentLoaded.
 */
export function initDOMCache() {
  // View containers.
  elements.galleryView = document.getElementById('galleryView');
  elements.detailView = document.getElementById('detailView');

  // Detail view elements.
  elements.detailFilename = document.getElementById('detailFilename');
  elements.lockStatus = document.getElementById('lockStatus');
  elements.deleteImagePath = document.getElementById('deleteImagePath');
  elements.saturationSlider = document.getElementById('saturationSlider');
  elements.saturationValue = document.getElementById('saturationValue');
  elements.brightnessSlider = document.getElementById('brightnessSlider');
  elements.brightnessValue = document.getElementById('brightnessValue');
  elements.contrastSlider = document.getElementById('contrastSlider');
  elements.contrastValue = document.getElementById('contrastValue');
  elements.flashTwiceCheckbox = document.getElementById('flashTwiceCheckbox');
  elements.filterStatus = document.getElementById('filterStatus');
  elements.filterProcessing = document.getElementById('filterProcessing');
  elements.ditherProcessing = document.getElementById('ditherProcessing');
  elements.filterCanvas = document.getElementById('filterCanvas');
  elements.ditherCanvas = document.getElementById('ditherCanvas');
  elements.flashBtn = document.getElementById('flashBtn');

  // Dither method buttons.
  elements.ditherButtons = document.querySelectorAll('.dither-btn');
  elements.fitModeButtons = document.querySelectorAll('.fit-mode-btn');

  // Flash status bar.
  elements.flashStatusBar = document.getElementById('flashStatusBar');
  elements.statusText = document.getElementById('statusText');
  elements.statusProgress = document.getElementById('statusProgress');
  elements.statusIcon = document.getElementById('statusIcon');

  // Flash modal.
  elements.flashModal = document.getElementById('flashModal');
  elements.flashModalImage = document.getElementById('flashModalImage');
  elements.flashModalFilename = document.getElementById('flashModalFilename');
  elements.flashModalTitle = document.getElementById('flashModalTitle');
  elements.flashModalNote = document.getElementById('flashModalNote');
  elements.flashModalClose = document.getElementById('flashModalClose');
  elements.flashProgress1 = document.getElementById('flashProgress1');
  elements.flashProgress2 = document.getElementById('flashProgress2');
  elements.flashProgress2Container = document.getElementById('flashProgress2Container');
  elements.flashProgress1Container = document.getElementById('flashProgress1Container');

  // Delete confirmation modal.
  elements.deleteConfirmFilename = document.getElementById('deleteConfirmFilename');
  elements.deleteConfirmModal = document.getElementById('deleteConfirmModal');
  elements.deleteForm = document.getElementById('deleteForm');

  // Upload elements.
  elements.dropZone = document.getElementById('dropZone');
  elements.fileInput = document.getElementById('fileInput');

  // Upload modal.
  elements.uploadModal = document.getElementById('uploadModal');
  elements.uploadModalImage = document.getElementById('uploadModalImage');
  elements.uploadModalFilename = document.getElementById('uploadModalFilename');
  elements.uploadProgress = document.getElementById('uploadProgress');
  elements.uploadPercent = document.getElementById('uploadPercent');
  elements.uploadSpeed = document.getElementById('uploadSpeed');
  elements.uploadTransferred = document.getElementById('uploadTransferred');
  elements.uploadTime = document.getElementById('uploadTime');
  elements.uploadNote = document.getElementById('uploadNote');
  elements.uploadCloseBtn = document.getElementById('uploadCloseBtn');
  elements.uploadModalTitle = document.getElementById('uploadModalTitle');
  elements.processingProgressContainer = document.getElementById('processingProgressContainer');
  elements.processingProgress = document.getElementById('processingProgress');
  elements.uploadQueueList = document.getElementById('uploadQueueList');
  elements.uploadQueueStatus = document.getElementById('uploadQueueStatus');
  elements.uploadQueueCount = document.getElementById('uploadQueueCount');
}

/**
 * Query all elements with the given CSS selector.
 * Useful for collections like buttons or placeholders.
 * @param {string} selector - CSS selector.
 * @returns {NodeList} NodeList of matching elements.
 */
export function queryAll(selector) {
  return document.querySelectorAll(selector);
}

/**
 * Query single element with the given CSS selector.
 * @param {string} selector - CSS selector.
 * @returns {Element|null} Matching element or null.
 */
export function query(selector) {
  return document.querySelector(selector);
}
