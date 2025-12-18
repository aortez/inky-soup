/**
 * Brightness and contrast controls UI module.
 * Handles brightness and contrast slider interactions.
 */

import { elements } from '../core/dom.js';
import { updateBrightness, updateContrast } from '../services/dither-service.js';

/**
 * Initialize brightness and contrast control event listeners.
 */
export function initBrightnessContrastControls() {
  elements.brightnessSlider.addEventListener('input', (e) => {
    updateBrightness(e.target.value);
  });

  elements.contrastSlider.addEventListener('input', (e) => {
    updateContrast(e.target.value);
  });
}
