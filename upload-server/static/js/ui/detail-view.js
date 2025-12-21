/**
 * Detail view UI module.
 * Manages the detail view for individual images.
 */

import { elements } from '../core/dom.js';
import { getIsReadOnly } from '../core/state.js';

/**
 * Update the lock status indicator.
 * @param {boolean} isReadOnly - Whether in read-only mode.
 * @param {number} expiresInSecs - Seconds until lock expires (null if read-only).
 */
export function updateLockStatus(isReadOnly, expiresInSecs = null) {
  if (isReadOnly) {
    elements.lockStatus.textContent = expiresInSecs
      ? `🔒 Read-only: Being edited (unlocks in ${expiresInSecs}s)`
      : '🔒 Read-only: Being edited';
    elements.lockStatus.classList.add('read-only');
    elements.lockStatus.style.display = 'block';
  } else if (expiresInSecs !== null) {
    elements.lockStatus.textContent = `✏️ Editing (lock expires in ${expiresInSecs}s)`;
    elements.lockStatus.classList.remove('read-only');
    elements.lockStatus.style.display = 'block';
  } else {
    elements.lockStatus.style.display = 'none';
  }
}

/**
 * Update UI elements based on read-only state.
 */
export function updateReadOnlyUI() {
  const readOnly = getIsReadOnly();

  // Disable/enable Save and Flash buttons.
  const saveBtn = document.querySelector('.apply-filter-btn');
  const { flashBtn } = elements;

  if (saveBtn) {
    saveBtn.disabled = readOnly;
    saveBtn.style.opacity = readOnly ? '0.5' : '1';
    saveBtn.style.cursor = readOnly ? 'not-allowed' : 'pointer';
  }

  if (flashBtn) {
    flashBtn.disabled = readOnly;
    flashBtn.style.opacity = readOnly ? '0.5' : '1';
    flashBtn.style.cursor = readOnly ? 'not-allowed' : 'pointer';
  }
}

/**
 * Initialize detail view event listeners.
 */
export function initDetailView() {
  // Flash button uses onclick handler in template - no listener needed here.
}
