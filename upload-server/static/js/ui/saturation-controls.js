/**
 * Saturation controls UI module.
 * Handles saturation slider interactions.
 */

import { elements } from '../core/dom.js';
import { updateSaturation } from '../services/dither-service.js';

/**
 * Initialize saturation control event listeners.
 */
export function initSaturationControls() {
  elements.saturationSlider.addEventListener('input', (e) => {
    updateSaturation(e.target.value);
  });
}
