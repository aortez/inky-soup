/**
 * Web Worker for image filtering.
 * Runs filter operations in a background thread to keep the UI responsive.
 */

// Import the filter library.
importScripts('/js/filters.js');

self.onmessage = function(e) {
  const { data, width, height, targetWidth, targetHeight, filter } = e.data;

  try {
    // Reconstruct ImageData from transferred buffer.
    const imageData = new ImageData(new Uint8ClampedArray(data), width, height);

    // Perform the resize operation.
    const result = FilterLib.resize(imageData, targetWidth, targetHeight, filter);

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
