/**
 * Main entry point for Inky Soup frontend application.
 * Initializes all modules and exposes global functions for template use.
 */

// Core imports.
import { initDOMCache } from './core/dom.js';

// UI imports.
import { initNavigation, showDetailView, showGalleryView } from './ui/navigation.js';
import { initDetailView } from './ui/detail-view.js';
import { initGalleryView } from './ui/gallery-view.js';
import { initFilterControls, applyFilter } from './ui/filter-controls.js';
import { initSaturationControls } from './ui/saturation-controls.js';
import { initFlashStatus, expandFlashModal, closeFlashModal } from './ui/flash-status.js';
import { initUploadUI, closeUploadModal } from './ui/upload-ui.js';
import {
  initDeleteUI,
  showDeleteConfirmation,
  closeDeleteConfirmation,
  confirmDelete,
} from './ui/delete-ui.js';

// Service imports.
import { checkGlobalFlashStatus, flashImage } from './services/flash-service.js';
import { updateSaturation } from './services/dither-service.js';

/**
 * Initialize the application.
 */
function init() {
  // 1. Cache DOM elements.
  initDOMCache();

  // 2. Initialize UI modules.
  initNavigation();
  initDetailView();
  initGalleryView();
  initFilterControls();
  initSaturationControls();
  initFlashStatus();
  initUploadUI();
  initDeleteUI();

  // 3. Restore flash status if any job is active.
  checkGlobalFlashStatus();
}

// Wait for DOM to be ready.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// Expose functions needed by server-generated inline event handlers.
// TODO: Migrate to event delegation to remove these global exports.
window.showDetailView = showDetailView;
window.showGalleryView = showGalleryView;
window.showDeleteConfirmation = showDeleteConfirmation;
window.closeDeleteConfirmation = closeDeleteConfirmation;
window.confirmDelete = confirmDelete;
window.applyFilter = applyFilter;
window.expandFlashModal = expandFlashModal;
window.closeFlashModal = closeFlashModal;
window.closeUploadModal = closeUploadModal;
window.updateSaturation = updateSaturation;
window.flashImage = flashImage;
