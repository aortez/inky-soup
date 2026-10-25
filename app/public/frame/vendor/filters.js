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

  function mitchell(x) {
    // Mitchell-Netravali filter with B=1/3, C=1/3.
    // Good balance between blur and ringing artifacts.
    const B = 1/3, C = 1/3;
    const ax = Math.abs(x);
    if (ax < 1) {
      return ((12 - 9*B - 6*C)*ax*ax*ax + (-18 + 12*B + 6*C)*ax*ax + (6 - 2*B)) / 6;
    }
    if (ax < 2) {
      return ((-B - 6*C)*ax*ax*ax + (6*B + 30*C)*ax*ax + (-12*B - 48*C)*ax + (8*B + 24*C)) / 6;
    }
    return 0;
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
      case 'mitchell':
        return { fn: mitchell, radius: 2.0 };
      case 'lanczos':
        return { fn: (x) => lanczos(x, 3), radius: 3.0 };
      default:
        return { fn: catmullRom, radius: 2.0 };
    }
  }

  /**
   * Resize an image using the specified filter.
   * Uses separable two-pass filtering for better performance.
   * @param {ImageData} srcData - Source image data.
   * @param {number} dstWidth - Target width.
   * @param {number} dstHeight - Target height.
   * @param {string} filterType - Filter type: 'nearest', 'bilinear', 'bicubic', 'mitchell', 'lanczos'.
   * @returns {ImageData} Resized image data.
   */
  function resize(srcData, dstWidth, dstHeight, filterType) {
    const srcWidth = srcData.width;
    const srcHeight = srcData.height;
    const src = srcData.data;
    const filter = getFilter(filterType);

    // Pass 1: Horizontal resize (srcWidth -> dstWidth, keep srcHeight).
    // Use Float32Array for intermediate buffer to avoid precision loss.
    const temp = new Float32Array(dstWidth * srcHeight * 4);
    const xRatio = srcWidth / dstWidth;

    for (let y = 0; y < srcHeight; y++) {
      const rowOffset = y * srcWidth * 4;
      const tempRowOffset = y * dstWidth * 4;

      for (let dstX = 0; dstX < dstWidth; dstX++) {
        const srcX = (dstX + 0.5) * xRatio - 0.5;
        const xMin = Math.max(0, Math.floor(srcX - filter.radius));
        const xMax = Math.min(srcWidth - 1, Math.ceil(srcX + filter.radius));

        let r = 0, g = 0, b = 0, a = 0;
        let weightSum = 0;

        for (let sx = xMin; sx <= xMax; sx++) {
          const weight = filter.fn(sx - srcX);
          const srcIdx = rowOffset + sx * 4;
          r += src[srcIdx] * weight;
          g += src[srcIdx + 1] * weight;
          b += src[srcIdx + 2] * weight;
          a += src[srcIdx + 3] * weight;
          weightSum += weight;
        }

        const tempIdx = tempRowOffset + dstX * 4;
        if (weightSum > 0) {
          const invWeight = 1 / weightSum;
          temp[tempIdx] = r * invWeight;
          temp[tempIdx + 1] = g * invWeight;
          temp[tempIdx + 2] = b * invWeight;
          temp[tempIdx + 3] = a * invWeight;
        }
      }
    }

    // Pass 2: Vertical resize (srcHeight -> dstHeight, width is already dstWidth).
    const dst = new Uint8ClampedArray(dstWidth * dstHeight * 4);
    const yRatio = srcHeight / dstHeight;

    for (let dstY = 0; dstY < dstHeight; dstY++) {
      const srcY = (dstY + 0.5) * yRatio - 0.5;
      const yMin = Math.max(0, Math.floor(srcY - filter.radius));
      const yMax = Math.min(srcHeight - 1, Math.ceil(srcY + filter.radius));
      const dstRowOffset = dstY * dstWidth * 4;

      for (let x = 0; x < dstWidth; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        let weightSum = 0;

        for (let sy = yMin; sy <= yMax; sy++) {
          const weight = filter.fn(sy - srcY);
          const tempIdx = (sy * dstWidth + x) * 4;
          r += temp[tempIdx] * weight;
          g += temp[tempIdx + 1] * weight;
          b += temp[tempIdx + 2] * weight;
          a += temp[tempIdx + 3] * weight;
          weightSum += weight;
        }

        const dstIdx = dstRowOffset + x * 4;
        if (weightSum > 0) {
          const invWeight = 1 / weightSum;
          dst[dstIdx] = r * invWeight;
          dst[dstIdx + 1] = g * invWeight;
          dst[dstIdx + 2] = b * invWeight;
          dst[dstIdx + 3] = a * invWeight;
        }
      }
    }

    return new ImageData(dst, dstWidth, dstHeight);
  }

  function normalizeFitMode(fitMode) {
    return fitMode === 'cover' ? 'cover' : 'contain';
  }

  function fillImageData(dstData, r, g, b, a) {
    const data = dstData.data;
    for (let i = 0; i < data.length; i += 4) {
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }

  function cropImageData(srcData, startX, startY, width, height) {
    const dstData = new ImageData(width, height);
    const src = srcData.data;
    const dst = dstData.data;
    const srcWidth = srcData.width;

    for (let y = 0; y < height; y++) {
      const srcRow = ((y + startY) * srcWidth + startX) * 4;
      const dstRow = y * width * 4;
      dst.set(src.subarray(srcRow, srcRow + width * 4), dstRow);
    }

    return dstData;
  }

  /**
   * Resize an image with aspect-ratio fit.
   * Returns ImageData at dstWidth x dstHeight.
   * @param {ImageData} srcData - Source image data.
   * @param {number} dstWidth - Target width.
   * @param {number} dstHeight - Target height.
   * @param {string} filterType - Filter type: 'nearest', 'bilinear', 'bicubic', 'mitchell', 'lanczos'.
   * @param {string} fitMode - 'contain' or 'cover'.
   * @returns {ImageData} Resized image data.
   */
  function resizeToFit(srcData, dstWidth, dstHeight, filterType, fitMode) {
    const mode = normalizeFitMode(fitMode);
    const srcWidth = srcData.width;
    const srcHeight = srcData.height;

    const scale = mode === 'cover'
      ? Math.max(dstWidth / srcWidth, dstHeight / srcHeight)
      : Math.min(dstWidth / srcWidth, dstHeight / srcHeight);

    const scaledWidth = Math.max(
      1,
      mode === 'cover'
        ? Math.ceil(srcWidth * scale)
        : Math.floor(srcWidth * scale),
    );
    const scaledHeight = Math.max(
      1,
      mode === 'cover'
        ? Math.ceil(srcHeight * scale)
        : Math.floor(srcHeight * scale),
    );
    const resized = resize(srcData, scaledWidth, scaledHeight, filterType);

    if (scaledWidth === dstWidth && scaledHeight === dstHeight) {
      return resized;
    }

    if (mode === 'cover') {
      const cropX = Math.max(0, Math.floor((scaledWidth - dstWidth) / 2));
      const cropY = Math.max(0, Math.floor((scaledHeight - dstHeight) / 2));
      return cropImageData(resized, cropX, cropY, dstWidth, dstHeight);
    }

    const output = new ImageData(dstWidth, dstHeight);
    fillImageData(output, 255, 255, 255, 255);
    const offsetX = Math.max(0, Math.floor((dstWidth - scaledWidth) / 2));
    const offsetY = Math.max(0, Math.floor((dstHeight - scaledHeight) / 2));
    const src = resized.data;
    const dst = output.data;

    for (let y = 0; y < scaledHeight; y++) {
      const srcRow = y * scaledWidth * 4;
      const dstRow = ((y + offsetY) * dstWidth + offsetX) * 4;
      dst.set(src.subarray(srcRow, srcRow + scaledWidth * 4), dstRow);
    }

    return output;
  }

  // Public API.
  return {
    resize: resize,
    resizeToFit: resizeToFit,
    BICUBIC: 'bicubic',
    BILINEAR: 'bilinear',
    LANCZOS: 'lanczos',
    MITCHELL: 'mitchell',
    NEAREST: 'nearest',
    // Expose internals for testing.
    _kernels: {
      nearest: nearest,
      bilinear: bilinear,
      catmullRom: catmullRom,
      lanczos: lanczos,
      mitchell: mitchell
    },
    _getFilter: getFilter
  };
})();

// Export for Node.js/CommonJS (testing).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = FilterLib;
}
