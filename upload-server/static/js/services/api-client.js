/**
 * API client for communicating with the server.
 * All fetch() calls are centralized here.
 */

/**
 * Fetch display configuration from the server.
 * Returns dimensions for the connected Inky Impression display.
 * @returns {Promise<Object>} Display configuration.
 */
export async function getDisplayConfig() {
  const response = await fetch('/api/display-config');

  if (!response.ok) {
    console.warn('Failed to fetch display config, using defaults');
    return {
      width: 1600,
      height: 1200,
      thumb_width: 150,
      thumb_height: 112,
      logical_width: 1600,
      logical_height: 1200,
      logical_thumb_width: 150,
      logical_thumb_height: 112,
      physical_width: 1600,
      physical_height: 1200,
      physical_thumb_width: 150,
      physical_thumb_height: 112,
      rotation_degrees: 0,
      model: 'impression-13.3-default',
      color: 'multi',
    };
  }

  return response.json();
}

/**
 * Update global display rotation setting.
 * @param {number} rotationDegrees - Must be one of 0, 90, 180, 270.
 * @returns {Promise<Object>} Rotation update response.
 */
export async function updateDisplayRotation(rotationDegrees) {
  const response = await fetch('/api/settings/display-rotation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rotation_degrees: rotationDegrees }),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.message || `Failed to update display rotation (${response.status})`);
  }

  return payload;
}

/**
 * Upload a cache image (display-sized PNG) to the server.
 * @param {string} filename - Original filename (without .png extension).
 * @param {Blob} blob - PNG blob data.
 * @param {string} filter - Filter name to save in metadata.
 * @param {string} fitMode - Fit mode ("contain" or "cover").
 * @param {number} saturation - Saturation value.
 * @param {number} brightness - Brightness value.
 * @param {number} contrast - Contrast value.
 * @param {string} ditherAlgorithm - Dither algorithm name.
 * @param {string} sessionId - Session ID for lock verification.
 * @returns {Promise<Object>} Server response.
 */
export async function uploadCache(
  filename,
  blob,
  filter,
  fitMode,
  saturation,
  brightness,
  contrast,
  ditherAlgorithm,
  sessionId,
) {
  const formData = new FormData();
  formData.append('filename', filename);
  if (filter) {
    formData.append('filter', filter);
    formData.append('saturation', saturation.toString());
    formData.append('brightness', brightness.toString());
    formData.append('contrast', contrast.toString());
    formData.append('dither_algorithm', ditherAlgorithm);
  }
  if (fitMode) {
    formData.append('fit_mode', fitMode);
  }
  if (sessionId) {
    formData.append('session_id', sessionId);
  }
  formData.append('file', blob, `${filename}.png`);

  const response = await fetch('/api/upload-cache', {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Failed to upload cache: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Upload a thumbnail image (150x112 PNG) to the server.
 * @param {string} filename - Original filename (without .png extension).
 * @param {Blob} blob - PNG blob data.
 * @returns {Promise<Object>} Server response.
 */
export async function uploadThumb(filename, blob) {
  const formData = new FormData();
  formData.append('filename', filename);
  formData.append('file', blob, `${filename}.png`);

  const response = await fetch('/api/upload-thumb', {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Failed to upload thumbnail: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Upload a dithered image (7-color PNG) to the server.
 * @param {string} filename - Original filename (without .png extension).
 * @param {Blob} blob - PNG blob data.
 * @param {string} filter - Filter name used for the cached image.
 * @param {string} fitMode - Fit mode ("contain" or "cover").
 * @param {number} saturation - Saturation value used for dithering.
 * @param {number} brightness - Brightness value used for dithering.
 * @param {number} contrast - Contrast value used for dithering.
 * @param {string} ditherAlgorithm - Dither algorithm name.
 * @returns {Promise<Object>} Server response.
 */
export async function uploadDithered(
  filename,
  blob,
  filter,
  fitMode,
  saturation,
  brightness,
  contrast,
  ditherAlgorithm,
  sessionId,
) {
  const formData = new FormData();
  formData.append('filename', filename);
  formData.append('filter', filter);
  formData.append('fit_mode', fitMode);
  formData.append('saturation', saturation.toString());
  formData.append('brightness', brightness.toString());
  formData.append('contrast', contrast.toString());
  formData.append('dither_algorithm', ditherAlgorithm);
  formData.append('session_id', sessionId);
  formData.append('file', blob, `${filename}.png`);

  const response = await fetch('/api/upload-dithered', {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Failed to upload dithered image: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Submit a flash job to display an image on the e-ink screen.
 * @param {string} filename - Filename to flash.
 * @param {boolean} flashTwice - Whether to flash the image twice.
 * @param {string} sessionId - Session ID for lock verification.
 * @returns {Promise<Object>} Server response with job_id.
 */
export async function submitFlashJob(filename, flashTwice, sessionId) {
  const formData = new FormData();
  formData.append('submission.filename', filename);
  formData.append('submission.image_file_path', `images/dithered/${filename}.png`);
  formData.append('submission.session_id', sessionId);
  if (flashTwice) {
    formData.append('submission.flash_twice', 'true');
  }

  const response = await fetch('/flash', {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Failed to submit flash job: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Get the status of a specific flash job.
 * @param {string} jobId - The flash job ID.
 * @returns {Promise<Object>} Job status data.
 */
export async function getJobStatus(jobId) {
  const response = await fetch(`/api/flash/status/${jobId}`);

  if (!response.ok) {
    const error = new Error(`Failed to get job status: ${response.status} ${response.statusText}`);
    error.status = response.status;
    throw error;
  }

  return response.json();
}

/**
 * Get the global flash status (all jobs).
 * @returns {Promise<Object>} Flash status data.
 */
export async function getFlashStatus() {
  const response = await fetch('/api/flash/status');

  if (!response.ok) {
    throw new Error(`Failed to get flash status: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Check if a thumbnail exists for a given filename.
 * @param {string} filename - The filename to check.
 * @returns {Promise<Object>} Thumbnail status data.
 */
export async function getThumbStatus(filename) {
  const response = await fetch(`/api/thumb-status/${encodeURIComponent(filename)}`);

  if (!response.ok) {
    throw new Error(`Failed to get thumbnail status: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Acquire or refresh a lock on an image for editing.
 * @param {string} filename - The filename to lock.
 * @param {string} sessionId - The session ID requesting the lock.
 * @param {boolean} [refreshOnly=false] - True for keepalive refresh without acquiring new lock.
 * @param {AbortSignal} [signal] - Optional abort signal for request cancellation.
 * @returns {Promise<Object>} Lock response {locked, expires_in_secs, reason}.
 */
export async function lockImage(filename, sessionId, refreshOnly = false, signal = undefined) {
  const response = await fetch('/api/lock-image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      filename,
      session_id: sessionId,
      refresh_only: refreshOnly,
    }),
    signal,
  });

  if (!response.ok) {
    throw new Error(`Failed to lock image: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Release a lock on an image.
 * @param {string} filename - The filename to unlock.
 * @param {string} sessionId - The session ID releasing the lock.
 * @returns {Promise<Object>} Unlock response {success}.
 */
export async function unlockImage(filename, sessionId) {
  const response = await fetch('/api/unlock-image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, session_id: sessionId }),
  });

  if (!response.ok) {
    throw new Error(`Failed to unlock image: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Upload an original image file to the server.
 * Uses XMLHttpRequest for progress tracking.
 * @param {File} file - The file to upload.
 * @param {Function} onProgress - Progress callback (event).
 * @param {Function} onSuccess - Success callback (response).
 * @param {Function} onError - Error callback (error).
 * @returns {XMLHttpRequest} The XHR object (for abort if needed).
 */
export function uploadOriginalImage(file, onProgress, onSuccess, onError) {
  const formData = new FormData();
  formData.append('submission.file', file);

  const xhr = new XMLHttpRequest();

  xhr.upload.addEventListener('progress', onProgress);

  xhr.addEventListener('load', () => {
    if (xhr.status === 200) {
      try {
        const data = JSON.parse(xhr.responseText);
        if (data.success === false) {
          onError(new Error(data.message || 'Upload failed'));
        } else {
          onSuccess(data);
        }
      } catch (error) {
        onError(new Error('Failed to parse server response'));
      }
    } else {
      onError(new Error(`Upload failed with status ${xhr.status}`));
    }
  });

  xhr.addEventListener('error', () => {
    onError(new Error('Network error during upload'));
  });

  xhr.open('POST', '/upload');
  xhr.send(formData);

  return xhr;
}
