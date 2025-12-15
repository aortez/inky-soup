/**
 * Web Worker for e-ink dithering.
 * Runs dithering operations in a background thread to keep the UI responsive.
 */

// Import the dither library.
importScripts('/js/dither.js');

self.onmessage = function(e) {
  const { data, width, height, saturation } = e.data;

  try {
    // Reconstruct ImageData from transferred buffer.
    const imageData = new ImageData(new Uint8ClampedArray(data), width, height);

    // Perform the dithering operation.
    const result = ditherForEInk(imageData, saturation);

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
