/**
 * Settings view UI module.
 * Manages global display settings (rotation).
 */

import { elements } from '../core/dom.js';
import { getDisplayConfig } from '../core/state.js';
import { updateDisplayRotation } from '../services/api-client.js';

function setStatus(message, color = '#C9DBBD') {
  if (!elements.rotationStatus) return;
  elements.rotationStatus.textContent = message;
  elements.rotationStatus.style.color = color;
}

/**
 * Sync settings form values from current display configuration.
 */
export function syncSettingsForm() {
  if (!elements.rotationSelect) return;
  const config = getDisplayConfig();
  const currentRotation = Number(config.rotationDegrees) || 0;
  elements.rotationSelect.value = `${currentRotation}`;
}

async function saveRotation() {
  if (!elements.rotationSelect || !elements.saveRotationBtn) return;

  const rotationDegrees = parseInt(elements.rotationSelect.value, 10);
  elements.saveRotationBtn.disabled = true;
  setStatus('Saving rotation...');

  try {
    const response = await updateDisplayRotation(rotationDegrees);
    const { removed_assets: removedAssets } = response;

    setStatus(
      `Saved ${response.rotation_degrees}°. Cleared `
      + `${removedAssets.cache} cache, `
      + `${removedAssets.thumbs} thumbs, `
      + `${removedAssets.dithered} dithered files. Reloading to regenerate...`,
      '#6B8E4E',
    );

    setTimeout(() => {
      window.location.reload();
    }, 900);
  } catch (err) {
    setStatus(`Error: ${err.message}`, '#ff6b6b');
  } finally {
    elements.saveRotationBtn.disabled = false;
  }
}

/**
 * Initialize settings view event listeners.
 */
export function initSettingsView() {
  if (!elements.rotationSelect || !elements.saveRotationBtn) return;

  syncSettingsForm();
  elements.saveRotationBtn.addEventListener('click', saveRotation);
}
