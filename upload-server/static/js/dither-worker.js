/**
 * Web Worker for e-ink dithering.
 * Runs dithering operations in a background thread to keep the UI responsive.
 */

// Import the dither library.
importScripts('/js/dither.js');

self.onmessage = function(e) {
  const {
    data,
    width,
    height,
    saturation,
    algorithm,
    brightness = 0,
    contrast = 0,
  } = e.data;

  try {
    // Reconstruct ImageData from transferred buffer.
    const imageData = new ImageData(new Uint8ClampedArray(data), width, height);

    // Apply brightness/contrast adjustments before dithering.
    applyBrightnessContrast(imageData, brightness, contrast);

    // Perform the dithering operation with the specified algorithm.
    const result = ditherForEInk(imageData, saturation, algorithm || 'floyd-steinberg');

    // Send the result back to the main thread (transfer the buffer).
    self.postMessage(result, [result.data.buffer]);
  } catch (error) {
    // Send error back to main thread.
    self.postMessage({
      success: false,
      error: error.message
    });
  }
};
