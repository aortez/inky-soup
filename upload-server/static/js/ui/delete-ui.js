/**
 * Delete UI module.
 * Handles delete confirmation modal.
 */

import { getCurrentFilename } from '../core/state.js';
import { elements } from '../core/dom.js';

/**
 * Show delete confirmation modal.
 */
export function showDeleteConfirmation() {
  elements.deleteConfirmFilename.textContent = getCurrentFilename();
  elements.deleteConfirmModal.classList.add('active');
}

/**
 * Close delete confirmation modal.
 */
export function closeDeleteConfirmation() {
  elements.deleteConfirmModal.classList.remove('active');
}

/**
 * Confirm deletion and submit form.
 */
export function confirmDelete() {
  elements.deleteForm.submit();
}

/**
 * Initialize delete UI.
 */
export function initDeleteUI() {
  // Delete UI functions are called directly from template onclick handlers.
  // This module exists for consistency and future expansion.
}
