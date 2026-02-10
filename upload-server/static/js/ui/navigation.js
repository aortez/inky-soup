/**
 * Navigation UI module.
 * Handles view switching and browser history.
 */

import {
  setCurrentView,
  getCurrentView,
  getCurrentFilename,
  setCurrentFilename,
  setCurrentPath,
  setCurrentFilter,
  setCurrentSaturation,
  setCurrentBrightness,
  setCurrentContrast,
  setCurrentDitherAlgorithm,
  setCurrentFitMode,
  setCurrentCacheVersion,
  getCurrentSessionId,
  setCurrentSessionId,
  getLockKeepaliveInterval,
  setLockKeepaliveInterval,
  setIsReadOnly,
} from '../core/state.js';
import { elements, query, queryAll } from '../core/dom.js';
import { loadImageUsingCache } from '../services/image-loader.js';
import { lockImage, unlockImage } from '../services/api-client.js';
import { updateLockStatus, updateReadOnlyUI } from './detail-view.js';
import { generateUUID } from '../utils/uuid.js';
import { applyFilterToCanvas } from '../services/filter-service.js';
import { applyDither } from '../services/dither-service.js';
import { syncSettingsForm } from './settings-view.js';

async function releaseCurrentImageLock() {
  // Release lock if we have one.
  const sessionId = getCurrentSessionId();
  const filename = getCurrentFilename();

  if (sessionId && filename) {
    try {
      await unlockImage(filename, sessionId);
    } catch (err) {
      console.warn('Failed to unlock image:', err);
    }
  }

  // Stop keepalive timer.
  const keepaliveInterval = getLockKeepaliveInterval();
  if (keepaliveInterval) {
    clearInterval(keepaliveInterval);
    setLockKeepaliveInterval(null);
  }

  // Reset lock state.
  setCurrentSessionId(null);
  setCurrentFilename(null);
  setCurrentPath(null);
  setIsReadOnly(false);
}

/**
 * Show the gallery view and release any image lock.
 */
export async function showGalleryView() {
  await releaseCurrentImageLock();

  elements.detailView.classList.remove('active');
  elements.settingsView.classList.remove('active');
  elements.galleryView.classList.add('active');
  setCurrentView('gallery');
  window.scrollTo(0, 0);
  window.history.pushState({ view: 'gallery' }, '', '#');
}

/**
 * Show the settings view.
 * If currently editing an image, release lock before switching.
 */
export async function showSettingsView() {
  if (getCurrentView() === 'detail') {
    await releaseCurrentImageLock();
  }

  syncSettingsForm();
  elements.galleryView.classList.remove('active');
  elements.detailView.classList.remove('active');
  elements.settingsView.classList.add('active');
  setCurrentView('settings');
  window.scrollTo(0, 0);
  window.history.pushState({ view: 'settings' }, '', '#settings');
}

/**
 * Show the detail view for a specific image.
 * @param {string} filename - The filename.
 * @param {string} path - The full file path.
 * @param {string} filter - The filter name.
 * @param {boolean} thumbReady - Whether thumbnail is ready.
 * @param {number} [saturation=0.5] - The saturation value.
 * @param {number} [brightness=0] - The brightness value.
 * @param {number} [contrast=0] - The contrast value.
 * @param {string} [ditherAlgorithm='floyd-steinberg'] - The dither algorithm.
 * @param {string} [fitMode='contain'] - The fit mode.
 * @param {number} [cacheVersion=1] - The cache version.
 */
export async function showDetailView(
  filename,
  path,
  filter,
  thumbReady,
  saturation = 0.5,
  brightness = 0,
  contrast = 0,
  ditherAlgorithm = 'floyd-steinberg',
  fitMode = 'contain',
  cacheVersion = 1,
) {
  if (!thumbReady) {
    // Can't view detail for uncached images yet.
    alert('This image is still being processed. Please wait.');
    return;
  }

  // Generate session ID and try to acquire lock.
  const sessionId = generateUUID();
  setCurrentSessionId(sessionId);

  try {
    const lockResponse = await lockImage(filename, sessionId, false);

    if (!lockResponse.locked) {
      // Failed to acquire lock - switch to read-only mode.
      setIsReadOnly(true);
      updateLockStatus(true, lockResponse.expires_in_secs);
      updateReadOnlyUI();
      console.log(`Image locked by another user. Read-only mode. ${lockResponse.reason}`);
    } else {
      // Lock acquired - enable editing.
      setIsReadOnly(false);
      updateLockStatus(false, lockResponse.expires_in_secs);
      updateReadOnlyUI();
      console.log(`Lock acquired for ${filename} (expires in ${lockResponse.expires_in_secs}s)`);

      // Start keepalive timer (1 second for testing, will be 10s in production).
      const keepaliveInterval = setInterval(async () => {
        try {
          const refreshResponse = await lockImage(filename, sessionId, true);
          if (refreshResponse.locked) {
            updateLockStatus(false, refreshResponse.expires_in_secs);
          } else {
            // Lost lock (expired or released). Switch UI to read-only.
            clearInterval(keepaliveInterval);
            setLockKeepaliveInterval(null);
            setIsReadOnly(true);
            updateLockStatus(true, refreshResponse.expires_in_secs);
            updateReadOnlyUI();
          }
        } catch (err) {
          console.error('Keepalive failed:', err);
        }
      }, 1000);
      setLockKeepaliveInterval(keepaliveInterval);
    }
  } catch (err) {
    console.error('Failed to acquire lock:', err);
    setIsReadOnly(true);
    updateLockStatus(true);
    updateReadOnlyUI();
  }

  setCurrentFilename(filename);
  setCurrentPath(path);
  setCurrentFilter(filter || 'bicubic');
  setCurrentSaturation(saturation);
  setCurrentBrightness(brightness);
  setCurrentContrast(contrast);
  setCurrentDitherAlgorithm(ditherAlgorithm);
  const normalizedFitMode = fitMode === 'cover' ? 'cover' : 'contain';
  setCurrentFitMode(normalizedFitMode);
  const normalizedCacheVersion = Number.isFinite(cacheVersion) ? cacheVersion : 1;
  setCurrentCacheVersion(Math.max(1, normalizedCacheVersion));

  // Update UI.
  elements.detailFilename.textContent = filename;
  elements.deleteImagePath.value = path;

  // Set active filter button.
  queryAll('.filter-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.filter === (filter || 'bicubic'));
  });

  // Set active fit mode button.
  queryAll('.fit-mode-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.fitMode === normalizedFitMode);
  });

  // Restore saturation from saved value (round to 1 decimal for display).
  const roundedSaturation = Math.round(saturation * 10) / 10;
  elements.saturationSlider.value = roundedSaturation;
  elements.saturationValue.textContent = roundedSaturation.toFixed(1);

  // Restore brightness and contrast from saved values.
  elements.brightnessSlider.value = brightness;
  elements.brightnessValue.textContent = brightness.toString();
  elements.contrastSlider.value = contrast;
  elements.contrastValue.textContent = contrast.toString();

  // Set active dither button.
  queryAll('[data-dither]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.dither === ditherAlgorithm);
  });

  // Reset flash twice.
  elements.flashTwiceCheckbox.checked = false;

  // Clear status.
  elements.filterStatus.textContent = '';
  elements.filterProcessing.textContent = 'Loading...';
  elements.ditherProcessing.textContent = '';

  // Clear canvases immediately to avoid showing previous image.
  const filterCtx = elements.filterCanvas.getContext('2d');
  const ditherCtx = elements.ditherCanvas.getContext('2d');

  // Fill with neutral background color.
  filterCtx.fillStyle = '#2A2A2A';
  filterCtx.fillRect(0, 0, elements.filterCanvas.width, elements.filterCanvas.height);
  ditherCtx.fillStyle = '#2A2A2A';
  ditherCtx.fillRect(0, 0, elements.ditherCanvas.width, elements.ditherCanvas.height);

  // Load image and coordinate processing pipeline.
  loadAndProcessImage(filename);

  // Switch views.
  elements.galleryView.classList.remove('active');
  elements.detailView.classList.add('active');
  setCurrentView('detail');
  window.scrollTo(0, 0);
  window.history.pushState(
    { view: 'detail', filename },
    '',
    `#detail-${encodeURIComponent(filename)}`,
  );
}

/**
 * Load an image and coordinate the processing pipeline.
 * @param {string} filename - The filename to load.
 */
async function loadAndProcessImage(filename) {
  try {
    const { imageData, needsFiltering } = await loadImageUsingCache(filename);

    if (needsFiltering) {
      // Original image loaded — needs filtering, which triggers dithering.
      applyFilterToCanvas(imageData);
    } else {
      // Cache hit with correct dimensions — draw directly and dither.
      elements.filterProcessing.textContent = '';
      const filterCtx = elements.filterCanvas.getContext('2d');
      filterCtx.putImageData(imageData, 0, 0);
      applyDither(imageData);
    }
  } catch (err) {
    console.error('Failed to load image:', err);
    elements.filterProcessing.textContent = 'Error loading image';
  }
}

/**
 * Initialize navigation event listeners.
 */
export function initNavigation() {
  // Release lock on page unload/close.
  window.addEventListener('beforeunload', () => {
    const sessionId = getCurrentSessionId();
    const filename = getCurrentFilename();

    if (sessionId && filename) {
      // Use sendBeacon for reliable delivery during page unload.
      const data = JSON.stringify({ filename, session_id: sessionId });
      const body = new Blob([data], { type: 'application/json' });
      navigator.sendBeacon('/api/unlock-image', body);
    }
  });

  // Handle browser back/forward.
  window.addEventListener('popstate', (e) => {
    if (e.state && e.state.view === 'settings') {
      showSettingsView();
      return;
    }

    if (e.state && e.state.view === 'detail' && e.state.filename) {
      // Try to find the thumbnail data.
      const thumb = query(`img[data-filename="${e.state.filename}"]`);
      if (thumb) {
        const saturation = parseFloat(thumb.dataset.saturation) || 0.5;
        const brightness = parseInt(thumb.dataset.brightness, 10) || 0;
        const contrast = parseInt(thumb.dataset.contrast, 10) || 0;
        const ditherAlgorithm = thumb.dataset.dither || 'floyd-steinberg';
        const fitMode = thumb.dataset.fitMode || 'contain';
        const cacheVersion = parseInt(thumb.dataset.cacheVersion, 10) || 1;
        showDetailView(
          e.state.filename,
          thumb.dataset.path,
          thumb.dataset.filter,
          true,
          saturation,
          brightness,
          contrast,
          ditherAlgorithm,
          fitMode,
          cacheVersion,
        );
      } else {
        showGalleryView();
      }
    } else {
      showGalleryView();
    }
  });
}
