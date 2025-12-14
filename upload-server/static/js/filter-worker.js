/**
 * Web Worker for image filtering.
 * Runs filter operations in a background thread to keep the UI responsive.
 */

// Import the filter library.
importScripts('/js/filters.js');

self.onmessage = function(e) {
  const { imageData, width, height, filter } = e.data;

  try {
    // Perform the resize operation.
    const result = FilterLib.resize(imageData, width, height, filter);

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
