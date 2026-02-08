/**
 * Upload UI module.
 * Manages upload drop zone and modal.
 */

import { elements } from '../core/dom.js';
import { handleFileSelect, closeUploadModal } from '../services/upload-service.js';

/**
 * Initialize upload UI event listeners.
 */
export function initUploadUI() {
  // Drop zone click to open file input.
  elements.dropZone.addEventListener('click', () => elements.fileInput.click());

  // Drag and drop handlers.
  elements.dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    elements.dropZone.classList.add('drag-over');
  });

  elements.dropZone.addEventListener('dragleave', () => {
    elements.dropZone.classList.remove('drag-over');
  });

  elements.dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    elements.dropZone.classList.remove('drag-over');
    const { files } = e.dataTransfer;
    if (files.length > 0) {
      handleFileSelect(files);
    }
  });

  // File input change handler.
  elements.fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleFileSelect(e.target.files);
      e.target.value = '';
    }
  });
}

/**
 * Export closeUploadModal for use by other modules.
 */
export { closeUploadModal };
