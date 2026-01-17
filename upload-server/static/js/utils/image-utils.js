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

/**
 * Draw an image or canvas onto a target context with aspect-ratio fit.
 * @param {CanvasRenderingContext2D} ctx - Target canvas context.
 * @param {HTMLImageElement|HTMLCanvasElement} source - Source image or canvas.
 * @param {number} targetWidth - Destination width.
 * @param {number} targetHeight - Destination height.
 * @param {string} fitMode - "contain" or "cover".
 * @param {string} background - Background color for letterbox.
 */
export function drawImageToFit(
  ctx,
  source,
  targetWidth,
  targetHeight,
  fitMode = 'contain',
  background = '#ffffff',
) {
  const srcWidth = source.naturalWidth || source.width;
  const srcHeight = source.naturalHeight || source.height;

  if (!srcWidth || !srcHeight) {
    ctx.clearRect(0, 0, targetWidth, targetHeight);
    return;
  }

  const mode = fitMode === 'cover' ? 'cover' : 'contain';
  const scale = mode === 'cover'
    ? Math.max(targetWidth / srcWidth, targetHeight / srcHeight)
    : Math.min(targetWidth / srcWidth, targetHeight / srcHeight);

  const drawWidth = mode === 'cover'
    ? Math.ceil(srcWidth * scale)
    : Math.floor(srcWidth * scale);
  const drawHeight = mode === 'cover'
    ? Math.ceil(srcHeight * scale)
    : Math.floor(srcHeight * scale);
  const dx = Math.round((targetWidth - drawWidth) / 2);
  const dy = Math.round((targetHeight - drawHeight) / 2);

  ctx.clearRect(0, 0, targetWidth, targetHeight);
  if (mode === 'contain') {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, targetWidth, targetHeight);
  }
  ctx.drawImage(source, dx, dy, drawWidth, drawHeight);
}
