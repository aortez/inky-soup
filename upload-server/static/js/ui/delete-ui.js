/**
 * Delete UI module.
 * Handles delete confirmation modal.
 */

import { getCurrentFilename, getCurrentSessionId } from '../core/state.js';
import { elements } from '../core/dom.js';
import { deleteImage } from '../services/api-client.js';

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
 * Delete the open photo with this page's edit lock, then return to the gallery.
 */
export async function confirmDelete() {
  try {
    await deleteImage(getCurrentFilename(), getCurrentSessionId());
  } catch (err) {
    closeDeleteConfirmation();
    alert(`Cannot delete: ${err.message}`);
    return;
  }
  window.location.href = '/';
}

/**
 * Initialize delete UI.
 */
export function initDeleteUI() {
  // Delete UI functions are called directly from template onclick handlers.
  // This module exists for consistency and future expansion.
}
