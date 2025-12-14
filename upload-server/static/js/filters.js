/**
 * Image resampling filter library.
 * Implements various resize algorithms matching the server-side FilterType options.
 */

const FilterLib = (function() {
  'use strict';

  // Filter kernel functions.

  function nearest(x) {
    return x >= -0.5 && x < 0.5 ? 1 : 0;
  }

  function bilinear(x) {
    const ax = Math.abs(x);
    return ax < 1 ? 1 - ax : 0;
  }

  function catmullRom(x) {
    const ax = Math.abs(x);
    if (ax < 1) {
      return (3 * ax * ax * ax - 5 * ax * ax + 2) / 2;
    }
    if (ax < 2) {
      return (-ax * ax * ax + 5 * ax * ax - 8 * ax + 4) / 2;
    }
    return 0;
  }

  function lanczos(x, a = 3) {
    if (x === 0) return 1;
    const ax = Math.abs(x);
    if (ax >= a) return 0;
    const pi_x = Math.PI * x;
    return (a * Math.sin(pi_x) * Math.sin(pi_x / a)) / (pi_x * pi_x);
  }

  // Get filter kernel and support radius.
  function getFilter(filterType) {
    switch (filterType) {
      case 'nearest':
        return { fn: nearest, radius: 0.5 };
      case 'bilinear':
        return { fn: bilinear, radius: 1.0 };
      case 'bicubic':
        return { fn: catmullRom, radius: 2.0 };
      case 'lanczos':
        return { fn: (x) => lanczos(x, 3), radius: 3.0 };
      default:
        return { fn: catmullRom, radius: 2.0 };
    }
  }

  /**
   * Resize an image using the specified filter.
   * @param {ImageData} srcData - Source image data.
   * @param {number} dstWidth - Target width.
   * @param {number} dstHeight - Target height.
   * @param {string} filterType - Filter type: 'nearest', 'bilinear', 'bicubic', 'lanczos'.
   * @returns {ImageData} Resized image data.
   */
  function resize(srcData, dstWidth, dstHeight, filterType) {
    const srcWidth = srcData.width;
    const srcHeight = srcData.height;
    const src = srcData.data;

    const dst = new Uint8ClampedArray(dstWidth * dstHeight * 4);
    const filter = getFilter(filterType);

    const xRatio = srcWidth / dstWidth;
    const yRatio = srcHeight / dstHeight;

    // Resize row by row for better cache locality.
    for (let dstY = 0; dstY < dstHeight; dstY++) {
      const srcY = (dstY + 0.5) * yRatio - 0.5;
      const yMin = Math.max(0, Math.floor(srcY - filter.radius));
      const yMax = Math.min(srcHeight - 1, Math.ceil(srcY + filter.radius));

      for (let dstX = 0; dstX < dstWidth; dstX++) {
        const srcX = (dstX + 0.5) * xRatio - 0.5;
        const xMin = Math.max(0, Math.floor(srcX - filter.radius));
        const xMax = Math.min(srcWidth - 1, Math.ceil(srcX + filter.radius));

        let r = 0, g = 0, b = 0, a = 0;
        let weightSum = 0;

        for (let sy = yMin; sy <= yMax; sy++) {
          const wy = filter.fn(sy - srcY);

          for (let sx = xMin; sx <= xMax; sx++) {
            const wx = filter.fn(sx - srcX);
            const weight = wx * wy;

            const srcIdx = (sy * srcWidth + sx) * 4;
            r += src[srcIdx] * weight;
            g += src[srcIdx + 1] * weight;
            b += src[srcIdx + 2] * weight;
            a += src[srcIdx + 3] * weight;
            weightSum += weight;
          }
        }

        const dstIdx = (dstY * dstWidth + dstX) * 4;
        if (weightSum > 0) {
          dst[dstIdx] = r / weightSum;
          dst[dstIdx + 1] = g / weightSum;
          dst[dstIdx + 2] = b / weightSum;
          dst[dstIdx + 3] = a / weightSum;
        }
      }
    }

    return new ImageData(dst, dstWidth, dstHeight);
  }

  // Public API.
  return {
    resize: resize,
    NEAREST: 'nearest',
    BILINEAR: 'bilinear',
    BICUBIC: 'bicubic',
    LANCZOS: 'lanczos'
  };
})();
