/**
 * Settings view UI module.
 * Manages global display settings (physical mount orientation).
 */

import { elements } from '../core/dom.js';
import { getDisplayConfig, setDisplayConfig } from '../core/state.js';
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
  setStatus('Saving orientation...');

  try {
    const response = await updateDisplayRotation(rotationDegrees);
    const removedAssets = response.removed_assets || {};
    const removedCache = Number(removedAssets.cache || 0);
    const removedThumbs = Number(removedAssets.thumbs || 0);
    const removedDithered = Number(removedAssets.dithered || 0);
    const removedTotal = removedCache + removedThumbs + removedDithered;

    setDisplayConfig({ rotationDegrees: response.rotation_degrees });
    syncSettingsForm();

    if (removedTotal > 0) {
      setStatus(
        `Saved mount rotation ${response.rotation_degrees}°. Cleared `
        + `${removedCache} cache, `
        + `${removedThumbs} thumbs, `
        + `${removedDithered} dithered files. Reloading to regenerate...`,
        '#6B8E4E',
      );

      setTimeout(() => {
        window.location.reload();
      }, 900);
    } else {
      setStatus(
        `Saved mount rotation ${response.rotation_degrees}°. Existing gallery thumbnails `
        + 'and cache were preserved; new orientation applies on next flash.',
        '#6B8E4E',
      );
    }
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
