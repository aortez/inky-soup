/**
 * Flash status UI module.
 * Manages flash status bar and modal.
 */

import { expandFlashModal, closeFlashModal } from '../services/flash-service.js';

/**
 * Initialize flash status UI.
 */
export function initFlashStatus() {
  // Flash status UI is mostly managed by flash-service.js.
  // This module exists for consistency and future expansion.
}

/**
 * Export flash modal functions for use by other modules.
 */
export { expandFlashModal, closeFlashModal };
