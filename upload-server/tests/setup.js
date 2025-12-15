/**
 * Test setup file.
 * Mocks browser APIs that don't exist in Node.js.
 */

// Mock ImageData for Node.js environment.
if (typeof globalThis.ImageData === 'undefined') {
  globalThis.ImageData = class ImageData {
    constructor(dataOrWidth, widthOrHeight, height) {
      if (dataOrWidth instanceof Uint8ClampedArray) {
        // ImageData(data, width, height)
        this.data = dataOrWidth;
        this.width = widthOrHeight;
        this.height = height !== undefined ? height : dataOrWidth.length / (widthOrHeight * 4);
      } else {
        // ImageData(width, height)
        this.width = dataOrWidth;
        this.height = widthOrHeight;
        this.data = new Uint8ClampedArray(this.width * this.height * 4);
      }
    }
  };
}
