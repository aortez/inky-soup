/**
 * Tests for the e-ink dithering library.
 */

import { describe, it, expect } from 'vitest';
import {
  generatePalette,
  findClosestPaletteColor,
  floydSteinbergDither,
  ditherForEInk
} from '../static/js/dither.js';

describe('Dither Library', () => {
  describe('generatePalette', () => {
    it('should generate 8 colors', () => {
      const palette = generatePalette(0.5);
      expect(palette.length).toBe(8);
    });

    it('should return arrays of [r, g, b] values', () => {
      const palette = generatePalette(0.5);
      for (const color of palette) {
        expect(color.length).toBe(3);
        expect(typeof color[0]).toBe('number');
        expect(typeof color[1]).toBe('number');
        expect(typeof color[2]).toBe('number');
      }
    });

    it('should have white as the last color (CLEAN)', () => {
      const palette = generatePalette(0.5);
      expect(palette[7]).toEqual([255, 255, 255]);
    });

    it('should return desaturated palette at saturation=0', () => {
      const palette = generatePalette(0);
      // BLACK should be pure black at saturation=0.
      expect(palette[0]).toEqual([0, 0, 0]);
      // WHITE should be pure white.
      expect(palette[1]).toEqual([255, 255, 255]);
      // RED should be pure red.
      expect(palette[4]).toEqual([255, 0, 0]);
    });

    it('should return saturated palette at saturation=1', () => {
      const palette = generatePalette(1);
      // BLACK should match SATURATED_PALETTE[0].
      expect(palette[0]).toEqual([57, 48, 57]);
      // WHITE should match SATURATED_PALETTE[1].
      expect(palette[1]).toEqual([255, 255, 255]);
    });

    it('should blend colors at saturation=0.5', () => {
      const palette = generatePalette(0.5);
      // Check that values are between saturated and desaturated.
      // BLACK: saturated [57, 48, 57], desaturated [0, 0, 0]
      // At 0.5: [(57*0.5 + 0*0.5), ...] = [28.5, 24, 28.5] -> [29, 24, 29]
      expect(palette[0][0]).toBeCloseTo(29, 0);
      expect(palette[0][1]).toBeCloseTo(24, 0);
      expect(palette[0][2]).toBeCloseTo(29, 0);
    });

    it('should handle string saturation values', () => {
      const palette = generatePalette('0.5');
      expect(palette.length).toBe(8);
    });
  });

  describe('findClosestPaletteColor', () => {
    const testPalette = [
      [0, 0, 0],       // BLACK
      [255, 255, 255], // WHITE
      [255, 0, 0],     // RED
      [0, 255, 0],     // GREEN
      [0, 0, 255],     // BLUE
    ];

    it('should find exact match for black', () => {
      const index = findClosestPaletteColor(0, 0, 0, testPalette);
      expect(index).toBe(0);
    });

    it('should find exact match for white', () => {
      const index = findClosestPaletteColor(255, 255, 255, testPalette);
      expect(index).toBe(1);
    });

    it('should find exact match for red', () => {
      const index = findClosestPaletteColor(255, 0, 0, testPalette);
      expect(index).toBe(2);
    });

    it('should find closest color for dark gray', () => {
      // Dark gray (50, 50, 50) should be closest to black (0, 0, 0).
      const index = findClosestPaletteColor(50, 50, 50, testPalette);
      expect(index).toBe(0);
    });

    it('should find closest color for light gray', () => {
      // Light gray (200, 200, 200) should be closest to white (255, 255, 255).
      const index = findClosestPaletteColor(200, 200, 200, testPalette);
      expect(index).toBe(1);
    });

    it('should find closest color for orange-ish', () => {
      // Orange (255, 128, 0) should be closest to red (255, 0, 0).
      const index = findClosestPaletteColor(255, 128, 0, testPalette);
      expect(index).toBe(2);
    });

    it('should find closest color for cyan', () => {
      // Cyan (0, 255, 255) is equidistant from WHITE, GREEN, and BLUE.
      // Distance to WHITE (255, 255, 255): sqrt(255^2 + 0 + 0) = 255
      // Distance to GREEN (0, 255, 0): sqrt(0 + 0 + 255^2) = 255
      // Distance to BLUE (0, 0, 255): sqrt(0 + 255^2 + 0) = 255
      // WHITE comes first in palette (index 1), so it wins.
      const index = findClosestPaletteColor(0, 255, 255, testPalette);
      expect(index).toBe(1);
    });
  });

  describe('floydSteinbergDither', () => {
    // Helper to create test ImageData.
    function createTestImage(width, height, fillColor = [128, 128, 128, 255]) {
      const data = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < data.length; i += 4) {
        data[i] = fillColor[0];
        data[i + 1] = fillColor[1];
        data[i + 2] = fillColor[2];
        data[i + 3] = fillColor[3];
      }
      return new ImageData(data, width, height);
    }

    it('should return ImageData with same dimensions', () => {
      const src = createTestImage(10, 10);
      const palette = generatePalette(0.5);
      const result = floydSteinbergDither(src, palette);

      expect(result.width).toBe(10);
      expect(result.height).toBe(10);
      expect(result.data.length).toBe(10 * 10 * 4);
    });

    it('should quantize pixels to palette colors', () => {
      const src = createTestImage(5, 5, [255, 255, 255, 255]);
      const palette = generatePalette(0.5);
      const result = floydSteinbergDither(src, palette);

      // White input should stay close to white in output.
      // Check that pixels are valid palette colors.
      for (let i = 0; i < result.data.length; i += 4) {
        const r = result.data[i];
        const g = result.data[i + 1];
        const b = result.data[i + 2];

        // Find if this color exists in palette.
        const found = palette.some(c => c[0] === r && c[1] === g && c[2] === b);
        expect(found).toBe(true);
      }
    });

    it('should preserve alpha channel', () => {
      const src = createTestImage(5, 5, [128, 128, 128, 200]);
      const palette = generatePalette(0.5);
      const result = floydSteinbergDither(src, palette);

      // Check that alpha values are preserved.
      for (let i = 3; i < result.data.length; i += 4) {
        expect(result.data[i]).toBe(200);
      }
    });

    it('should handle solid black image', () => {
      const src = createTestImage(10, 10, [0, 0, 0, 255]);
      const palette = generatePalette(0.5);
      const result = floydSteinbergDither(src, palette);

      // Black should stay black (first palette color).
      const blackColor = palette[0];
      expect(result.data[0]).toBe(blackColor[0]);
      expect(result.data[1]).toBe(blackColor[1]);
      expect(result.data[2]).toBe(blackColor[2]);
    });

    it('should handle solid white image', () => {
      const src = createTestImage(10, 10, [255, 255, 255, 255]);
      const palette = generatePalette(0.5);
      const result = floydSteinbergDither(src, palette);

      // White should stay white (second palette color).
      const whiteColor = palette[1];
      expect(result.data[0]).toBe(whiteColor[0]);
      expect(result.data[1]).toBe(whiteColor[1]);
      expect(result.data[2]).toBe(whiteColor[2]);
    });
  });

  describe('ditherForEInk', () => {
    function createTestImage(width, height, fillColor = [128, 128, 128, 255]) {
      const data = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < data.length; i += 4) {
        data[i] = fillColor[0];
        data[i + 1] = fillColor[1];
        data[i + 2] = fillColor[2];
        data[i + 3] = fillColor[3];
      }
      return new ImageData(data, width, height);
    }

    it('should dither image with default saturation', () => {
      const src = createTestImage(600, 448);
      const result = ditherForEInk(src);

      expect(result.width).toBe(600);
      expect(result.height).toBe(448);
    });

    it('should dither image with custom saturation', () => {
      const src = createTestImage(600, 448);
      const result = ditherForEInk(src, 0.8);

      expect(result.width).toBe(600);
      expect(result.height).toBe(448);
    });

    it('should handle non-standard dimensions', () => {
      // Should work but log a warning.
      const src = createTestImage(100, 100);
      const result = ditherForEInk(src);

      expect(result.width).toBe(100);
      expect(result.height).toBe(100);
    });

    it('should produce valid palette colors only', () => {
      const src = createTestImage(20, 20, [100, 150, 200, 255]);
      const saturation = 0.5;
      const result = ditherForEInk(src, saturation);
      const palette = generatePalette(saturation);

      // Every pixel should be a valid palette color.
      for (let i = 0; i < result.data.length; i += 4) {
        const r = result.data[i];
        const g = result.data[i + 1];
        const b = result.data[i + 2];

        const found = palette.some(c => c[0] === r && c[1] === g && c[2] === b);
        expect(found).toBe(true);
      }
    });
  });
});
