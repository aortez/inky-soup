/**
 * Web Worker for e-ink dithering.
 * Runs dithering operations in a background thread to keep the UI responsive.
 */

// Import the dither library.
importScripts('/js/dither.js');

self.onmessage = function(e) {
  const { imageData, saturation } = e.data;

  try {
    // Perform the dithering operation.
    const result = ditherForEInk(imageData, saturation);

    // Send the result back to the main thread.
    self.postMessage({
      success: true,
      imageData: result
    });
  } catch (error) {
    // Send error back to main thread.
    self.postMessage({
      success: false,
      error: error.message
    });
  }
};
