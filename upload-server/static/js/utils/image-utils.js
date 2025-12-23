/**
 * Image utility functions.
 * Shared helpers for image processing.
 */

/**
 * Create ImageData from an image element.
 * @param {HTMLImageElement} img - The image element.
 * @returns {ImageData} The ImageData extracted from the image.
 */
export function createImageDataFromImage(img) {
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, img.width, img.height);
}
