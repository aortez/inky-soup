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
 */
export function showDetailView(filename, path, filter, thumbReady) {
  if (!thumbReady) {
    // Can't view detail for uncached images yet.
    alert('This image is still being processed. Please wait.');
    return;
  }

  setCurrentFilename(filename);
  setCurrentPath(path);
  setCurrentFilter(filter || 'bicubic');
  setCurrentSaturation(0.5);

  // Update UI.
  elements.detailFilename.textContent = filename;
  elements.deleteImagePath.value = path;

  // Set active filter button.
  queryAll('.filter-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.filter === (filter || 'bicubic'));
  });

  // Reset saturation.
  elements.saturationSlider.value = 0.5;
  elements.saturationValue.textContent = '0.5';

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
        showDetailView(
          e.state.filename,
          thumb.dataset.path,
          thumb.dataset.filter,
          true,
        );
      } else {
        showGalleryView();
      }
    } else {
      showGalleryView();
    }
  });
}
