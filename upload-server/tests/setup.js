/**
 * Test setup file for Vitest.
 * Provides ImageData polyfill for Node.js environment.
 */

// ImageData polyfill for Node.js (not available outside browser).
if (typeof globalThis.ImageData === 'undefined') {
  globalThis.ImageData = class ImageData {
    constructor(dataOrWidth, widthOrHeight, height) {
      if (dataOrWidth instanceof Uint8ClampedArray) {
        // Constructor: ImageData(data, width, height?)
        this.data = dataOrWidth;
        this.width = widthOrHeight;
        this.height = height || (dataOrWidth.length / 4 / widthOrHeight);
      } else {
        // Constructor: ImageData(width, height)
        this.width = dataOrWidth;
        this.height = widthOrHeight;
        this.data = new Uint8ClampedArray(this.width * this.height * 4);
      }
    }
  };
}
