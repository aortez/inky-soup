import { describe, it, expect } from 'vitest';

import { normalizeRotationDegrees, rotateImageData } from '../../static/js/utils/image-utils.js';

function pixelAt(imageData, x, y) {
  const idx = (y * imageData.width + x) * 4;
  return Array.from(imageData.data.slice(idx, idx + 4));
}

describe('image-utils rotation helpers', () => {
  it('normalizes unsupported rotations to zero', () => {
    expect(normalizeRotationDegrees(0)).toBe(0);
    expect(normalizeRotationDegrees(90)).toBe(90);
    expect(normalizeRotationDegrees(180)).toBe(180);
    expect(normalizeRotationDegrees(270)).toBe(270);
    expect(normalizeRotationDegrees(45)).toBe(0);
    expect(normalizeRotationDegrees(-90)).toBe(0);
  });

  it('rotates image data 90 degrees clockwise before resize', () => {
    // 2x1 source: [red, green].
    const src = new ImageData(new Uint8ClampedArray([
      255, 0, 0, 255,
      0, 255, 0, 255,
    ]), 2, 1);

    const rotated = rotateImageData(src, 90);
    expect(rotated.width).toBe(1);
    expect(rotated.height).toBe(2);
    expect(pixelAt(rotated, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(rotated, 0, 1)).toEqual([0, 255, 0, 255]);
  });

  it('rotates image data 180 degrees', () => {
    // 2x1 source: [red, green].
    const src = new ImageData(new Uint8ClampedArray([
      255, 0, 0, 255,
      0, 255, 0, 255,
    ]), 2, 1);

    const rotated = rotateImageData(src, 180);
    expect(rotated.width).toBe(2);
    expect(rotated.height).toBe(1);
    expect(pixelAt(rotated, 0, 0)).toEqual([0, 255, 0, 255]);
    expect(pixelAt(rotated, 1, 0)).toEqual([255, 0, 0, 255]);
  });
});
