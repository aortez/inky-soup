/**
 * Detail view UI module.
 * Manages the detail view for individual images.
 */

import { flashImage } from '../services/flash-service.js';
import { elements } from '../core/dom.js';

/**
 * Initialize detail view event listeners.
 */
export function initDetailView() {
  // Wire up flash button.
  elements.flashBtn.addEventListener('click', () => {
    flashImage();
  });
}
