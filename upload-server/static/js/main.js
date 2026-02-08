/**
 * Main entry point for Inky Soup frontend application.
 * Initializes all modules and exposes global functions for template use.
 */

// Core imports.
import { initDOMCache } from './core/dom.js';
import { setDisplayConfig } from './core/state.js';

// UI imports.
import {
  initNavigation,
  showDetailView,
  showGalleryView,
  showSettingsView,
} from './ui/navigation.js';
import { initDetailView } from './ui/detail-view.js';
import { initGalleryView } from './ui/gallery-view.js';
import { initSettingsView } from './ui/settings-view.js';
import { initFilterControls, applyFilter } from './ui/filter-controls.js';
import { initFitModeControls } from './ui/fit-mode-controls.js';
import { initSaturationControls } from './ui/saturation-controls.js';
import { initDitherControls } from './ui/dither-controls.js';
import { initBrightnessContrastControls } from './ui/brightness-contrast-controls.js';
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
import { updateSaturation, updateBrightness, updateContrast } from './services/dither-service.js';
import { getDisplayConfig } from './services/api-client.js';
import { getCurrentSessionId, getIsReadOnly } from './core/state.js';

/**
 * Load display configuration from server.
 * Updates canvas sizes and state based on connected display.
 */
async function loadDisplayConfig() {
  try {
    const config = await getDisplayConfig();
    console.log('Display config loaded:', config);

    // Store in state (convert snake_case to camelCase).
    const logicalWidth = config.logical_width ?? config.width;
    const logicalHeight = config.logical_height ?? config.height;
    const logicalThumbWidth = config.logical_thumb_width ?? config.thumb_width;
    const logicalThumbHeight = config.logical_thumb_height ?? config.thumb_height;
    setDisplayConfig({
      width: logicalWidth,
      height: logicalHeight,
      thumbWidth: logicalThumbWidth,
      thumbHeight: logicalThumbHeight,
      physicalWidth: config.physical_width ?? logicalWidth,
      physicalHeight: config.physical_height ?? logicalHeight,
      physicalThumbWidth: config.physical_thumb_width ?? logicalThumbWidth,
      physicalThumbHeight: config.physical_thumb_height ?? logicalThumbHeight,
      rotationDegrees: config.rotation_degrees ?? 0,
      model: config.model,
      color: config.color,
    });

    // Update canvas sizes if they exist.
    const filterCanvas = document.getElementById('filterCanvas');
    const ditherCanvas = document.getElementById('ditherCanvas');

    if (filterCanvas) {
      filterCanvas.width = logicalWidth;
      filterCanvas.height = logicalHeight;
    }
    if (ditherCanvas) {
      ditherCanvas.width = logicalWidth;
      ditherCanvas.height = logicalHeight;
    }

    // Update dimension labels.
    document.querySelectorAll('.pipeline-stage-label').forEach((label) => {
      if (label.textContent.includes('resized')) {
        label.textContent = `${logicalWidth} × ${logicalHeight} (resized)`;
      } else if (label.textContent.includes('colors')) {
        label.textContent = `${logicalWidth} × ${logicalHeight} (7 colors)`;
      }
    });
  } catch (error) {
    console.warn('Failed to load display config, using defaults:', error);
  }
}

/**
 * Initialize the application.
 */
async function init() {
  // 1. Load display configuration from server first.
  await loadDisplayConfig();

  // 2. Cache DOM elements.
  initDOMCache();

  // 3. Initialize UI modules.
  initNavigation();
  initSettingsView();
  initDetailView();
  initGalleryView();
  initFilterControls();
  initFitModeControls();
  initSaturationControls();
  initBrightnessContrastControls();
  initDitherControls();
  initFlashStatus();
  initUploadUI();
  initDeleteUI();

  // 4. Restore flash status if any job is active.
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
window.showSettingsView = showSettingsView;
window.showDeleteConfirmation = showDeleteConfirmation;
window.closeDeleteConfirmation = closeDeleteConfirmation;
window.confirmDelete = confirmDelete;
window.applyFilter = applyFilter;
window.expandFlashModal = expandFlashModal;
window.closeFlashModal = closeFlashModal;
window.closeUploadModal = closeUploadModal;
window.updateSaturation = updateSaturation;
window.updateBrightness = updateBrightness;
window.updateContrast = updateContrast;
window.flashImage = flashImage;

// Expose state getters for testing/debugging.
window.getCurrentSessionId = getCurrentSessionId;
window.getIsReadOnly = getIsReadOnly;
