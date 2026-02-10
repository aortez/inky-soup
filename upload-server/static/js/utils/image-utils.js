/**
 * Image utility functions.
 * Shared helpers for image processing.
 */

/**
 * Normalize rotation to one of the supported right angles.
 * @param {number} rotationDegrees - Requested rotation.
 * @returns {number} 0, 90, 180, or 270.
 */
export function normalizeRotationDegrees(rotationDegrees) {
  const normalized = Number(rotationDegrees);
  if (normalized === 90 || normalized === 180 || normalized === 270) {
    return normalized;
  }
  return 0;
}

/**
 * Create ImageData from an image or canvas element.
 * @param {HTMLImageElement|HTMLCanvasElement} img - Source drawable.
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
 * Convert ImageData into a canvas element.
 * @param {ImageData} imageData - Source ImageData.
 * @returns {HTMLCanvasElement} Canvas containing the ImageData.
 */
export function imageDataToCanvas(imageData) {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

/**
 * Rotate ImageData clockwise by 0/90/180/270 degrees.
 * Rotation is applied before resize/filter so fit/crop matches final orientation.
 * @param {ImageData} imageData - Source ImageData.
 * @param {number} rotationDegrees - Requested clockwise rotation.
 * @returns {ImageData} Rotated ImageData.
 */
export function rotateImageData(imageData, rotationDegrees) {
  const rotation = normalizeRotationDegrees(rotationDegrees);
  if (rotation === 0) return imageData;

  const srcWidth = imageData.width;
  const srcHeight = imageData.height;
  const src = imageData.data;
  const dstWidth = rotation === 90 || rotation === 270 ? srcHeight : srcWidth;
  const dstHeight = rotation === 90 || rotation === 270 ? srcWidth : srcHeight;
  const dst = new Uint8ClampedArray(dstWidth * dstHeight * 4);

  for (let y = 0; y < srcHeight; y += 1) {
    for (let x = 0; x < srcWidth; x += 1) {
      const srcIdx = (y * srcWidth + x) * 4;
      let dstX = x;
      let dstY = y;

      if (rotation === 90) {
        dstX = srcHeight - 1 - y;
        dstY = x;
      } else if (rotation === 180) {
        dstX = srcWidth - 1 - x;
        dstY = srcHeight - 1 - y;
      } else if (rotation === 270) {
        dstX = y;
        dstY = srcWidth - 1 - x;
      }

      const dstIdx = (dstY * dstWidth + dstX) * 4;
      dst[dstIdx] = src[srcIdx];
      dst[dstIdx + 1] = src[srcIdx + 1];
      dst[dstIdx + 2] = src[srcIdx + 2];
      dst[dstIdx + 3] = src[srcIdx + 3];
    }
  }

  return new ImageData(dst, dstWidth, dstHeight);
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
