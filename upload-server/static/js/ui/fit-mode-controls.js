/**
 * Fit mode controls UI module.
 * Handles contain/cover button interactions.
 */

import { queryAll } from '../core/dom.js';
import { selectFitMode } from '../services/filter-service.js';

/**
 * Initialize fit mode control event listeners.
 */
export function initFitModeControls() {
  queryAll('.fit-mode-btn').forEach((btn) => {
    btn.addEventListener('click', function handleFitModeClick() {
      selectFitMode(this.dataset.fitMode);
    });
  });
}
