/**
 * Navigation UI module.
 * Handles view switching and browser history.
 */

import {
  setCurrentView,
  setCurrentFilename,
  setCurrentPath,
  setCurrentFilter,
  setCurrentSaturation,
  setCurrentBrightness,
  setCurrentContrast,
  setCurrentDitherAlgorithm,
} from '../core/state.js';
import { elements, query, queryAll } from '../core/dom.js';
import { loadImageForProcessing } from '../services/image-loader.js';

/**
 * Show the gallery view.
 */
export function showGalleryView() {
  elements.detailView.classList.remove('active');
  elements.galleryView.classList.add('active');
  setCurrentView('gallery');
  window.scrollTo(0, 0);
  window.history.pushState({ view: 'gallery' }, '', '#');
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
 */
export function showDetailView(
  filename,
  path,
  filter,
  thumbReady,
  saturation = 0.5,
  brightness = 0,
  contrast = 0,
  ditherAlgorithm = 'floyd-steinberg',
) {
  if (!thumbReady) {
    // Can't view detail for uncached images yet.
    alert('This image is still being processed. Please wait.');
    return;
  }

  setCurrentFilename(filename);
  setCurrentPath(path);
  setCurrentFilter(filter || 'bicubic');
  setCurrentSaturation(saturation);
  setCurrentBrightness(brightness);
  setCurrentContrast(contrast);
  setCurrentDitherAlgorithm(ditherAlgorithm);

  // Update UI.
  elements.detailFilename.textContent = filename;
  elements.deleteImagePath.value = path;

  // Set active filter button.
  queryAll('.filter-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.filter === (filter || 'bicubic'));
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

  // Load image data for filter preview and dithering.
  loadImageForProcessing(filename);

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
 * Initialize navigation event listeners.
 */
export function initNavigation() {
  // Handle browser back/forward.
  window.addEventListener('popstate', (e) => {
    if (e.state && e.state.view === 'detail' && e.state.filename) {
      // Try to find the thumbnail data.
      const thumb = query(`img[data-filename="${e.state.filename}"]`);
      if (thumb) {
        const saturation = parseFloat(thumb.dataset.saturation) || 0.5;
        const brightness = parseInt(thumb.dataset.brightness, 10) || 0;
        const contrast = parseInt(thumb.dataset.contrast, 10) || 0;
        const ditherAlgorithm = thumb.dataset.dither || 'floyd-steinberg';
        showDetailView(
          e.state.filename,
          thumb.dataset.path,
          thumb.dataset.filter,
          true,
          saturation,
          brightness,
          contrast,
          ditherAlgorithm,
        );
      } else {
        showGalleryView();
      }
    } else {
      showGalleryView();
    }
  });
}
