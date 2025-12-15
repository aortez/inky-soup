/**
 * Filter controls UI module.
 * Handles filter button interactions.
 */

import { queryAll } from '../core/dom.js';
import { selectFilter, applyFilter } from '../services/filter-service.js';

/**
 * Initialize filter control event listeners.
 */
export function initFilterControls() {
  // Set up filter button clicks.
  queryAll('.filter-btn').forEach((btn) => {
    btn.addEventListener('click', function handleFilterClick() {
      selectFilter(this.dataset.filter);
    });
  });
}

/**
 * Export applyFilter for use by other modules.
 */
export { applyFilter };
