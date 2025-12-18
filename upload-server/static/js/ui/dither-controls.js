/**
 * Dither controls UI module.
 * Handles dither algorithm button interactions.
 */

import { elements } from '../core/dom.js';
import { updateDitherAlgorithm } from '../services/dither-service.js';

/**
 * Initialize dither control event listeners.
 */
export function initDitherControls() {
  elements.ditherButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const algorithm = btn.dataset.dither;
      updateDitherAlgorithm(algorithm);
    });
  });
}
