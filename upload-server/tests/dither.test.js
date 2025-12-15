/**
 * Tests for e-ink dithering library.
 */

import { describe, it, expect } from 'vitest';
import { loadBrowserModule } from './helpers/load-browser-module.js';

// Load the dither module.
const {
  generatePalette,
  findClosestPaletteColor,
  floydSteinbergDither,
  ditherForEInk,
} = loadBrowserModule('dither.js');

describe('Dither Library', () => {
  describe('generatePalette', () => {
    it('should return 8 colors', () => {
      const palette = generatePalette(0.5);
      expect(palette).toHaveLength(8);
    });

    it('should return saturated palette at saturation 1.0', () => {
      const palette = generatePalette(1.0);

      // Black should be [57, 48, 57] at full saturation.
      expect(palette[0]).toEqual([57, 48, 57]);

      // White should be [255, 255, 255].
      expect(palette[1]).toEqual([255, 255, 255]);
    });

    it('should return desaturated palette at saturation 0.0', () => {
      const palette = generatePalette(0.0);

      // Black should be [0, 0, 0] at zero saturation.
      expect(palette[0]).toEqual([0, 0, 0]);

      // White should be [255, 255, 255].
      expect(palette[1]).toEqual([255, 255, 255]);

      // Green should be [0, 255, 0].
      expect(palette[2]).toEqual([0, 255, 0]);

      // Blue should be [0, 0, 255].
      expect(palette[3]).toEqual([0, 0, 255]);

      // Red should be [255, 0, 0].
      expect(palette[4]).toEqual([255, 0, 0]);
    });

    it('should blend colors at saturation 0.5', () => {
      const palette = generatePalette(0.5);

      // Black: (57*0.5 + 0*0.5, 48*0.5 + 0*0.5, 57*0.5 + 0*0.5) = (29, 24, 29).
      expect(palette[0]).toEqual([29, 24, 29]);
    });

    it('should always have white as the last color (CLEAN)', () => {
      expect(generatePalette(0.0)[7]).toEqual([255, 255, 255]);
      expect(generatePalette(0.5)[7]).toEqual([255, 255, 255]);
      expect(generatePalette(1.0)[7]).toEqual([255, 255, 255]);
    });

    it('should parse string saturation values', () => {
      const palette = generatePalette('0.5');
      expect(palette).toHaveLength(8);
      expect(palette[0]).toEqual([29, 24, 29]);
    });
  });

  describe('findClosestPaletteColor', () => {
    const palette = [
      [0, 0, 0],       // Black
      [255, 255, 255], // White
      [255, 0, 0],     // Red
      [0, 255, 0],     // Green
      [0, 0, 255],     // Blue
    ];

    it('should find exact black match', () => {
      expect(findClosestPaletteColor(0, 0, 0, palette)).toBe(0);
    });

    it('should find exact white match', () => {
      expect(findClosestPaletteColor(255, 255, 255, palette)).toBe(1);
    });

    it('should find exact red match', () => {
      expect(findClosestPaletteColor(255, 0, 0, palette)).toBe(2);
    });

    it('should find exact green match', () => {
      expect(findClosestPaletteColor(0, 255, 0, palette)).toBe(3);
    });

    it('should find exact blue match', () => {
      expect(findClosestPaletteColor(0, 0, 255, palette)).toBe(4);
    });

    it('should find closest color for dark gray', () => {
      // Dark gray (50, 50, 50) should be closest to black (0, 0, 0).
      expect(findClosestPaletteColor(50, 50, 50, palette)).toBe(0);
    });

    it('should find closest color for light gray', () => {
      // Light gray (200, 200, 200) should be closest to white (255, 255, 255).
      expect(findClosestPaletteColor(200, 200, 200, palette)).toBe(1);
    });

    it('should find closest color for orange', () => {
      // Orange (255, 128, 0) should be closest to red (255, 0, 0).
      expect(findClosestPaletteColor(255, 128, 0, palette)).toBe(2);
    });

    it('should find closest color for cyan', () => {
      // Cyan (0, 255, 255) is equidistant from white, green, and blue (all distance 255).
      // Should pick white (index 1) since it comes first.
      const result = findClosestPaletteColor(0, 255, 255, palette);
      expect([1, 3, 4]).toContain(result);
    });

    it('should find closest color for magenta', () => {
      // Magenta (255, 0, 255) is equidistant from white, red, and blue (all distance 255).
      // Should pick white (index 1) since it comes first.
      const result = findClosestPaletteColor(255, 0, 255, palette);
      expect([1, 2, 4]).toContain(result);
    });
  });

  describe('floydSteinbergDither', () => {
    // Helper to create solid color ImageData.
    function createSolidImage(width, height, r, g, b, a = 255) {
      const data = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < data.length; i += 4) {
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        data[i + 3] = a;
      }
      return new ImageData(data, width, height);
    }

    const simplePalette = [
      [0, 0, 0],       // Black
      [255, 255, 255], // White
    ];

    it('should return ImageData with same dimensions', () => {
      const src = createSolidImage(10, 10, 128, 128, 128);
      const result = floydSteinbergDither(src, simplePalette);
      expect(result.width).toBe(10);
      expect(result.height).toBe(10);
    });

    it('should preserve white pixels', () => {
      const src = createSolidImage(10, 10, 255, 255, 255);
      const result = floydSteinbergDither(src, simplePalette);

      // All pixels should be white.
      for (let i = 0; i < result.data.length; i += 4) {
        expect(result.data[i]).toBe(255);
        expect(result.data[i + 1]).toBe(255);
        expect(result.data[i + 2]).toBe(255);
      }
    });

    it('should preserve black pixels', () => {
      const src = createSolidImage(10, 10, 0, 0, 0);
      const result = floydSteinbergDither(src, simplePalette);

      // All pixels should be black.
      for (let i = 0; i < result.data.length; i += 4) {
        expect(result.data[i]).toBe(0);
        expect(result.data[i + 1]).toBe(0);
        expect(result.data[i + 2]).toBe(0);
      }
    });

    it('should dither gray to mix of black and white', () => {
      const src = createSolidImage(10, 10, 128, 128, 128);
      const result = floydSteinbergDither(src, simplePalette);

      // Count black and white pixels.
      let blackCount = 0;
      let whiteCount = 0;
      for (let i = 0; i < result.data.length; i += 4) {
        if (result.data[i] === 0) blackCount++;
        if (result.data[i] === 255) whiteCount++;
      }

      // Should have a mix of both.
      expect(blackCount).toBeGreaterThan(0);
      expect(whiteCount).toBeGreaterThan(0);
    });

    it('should preserve alpha channel', () => {
      const src = createSolidImage(10, 10, 128, 128, 128, 200);
      const result = floydSteinbergDither(src, simplePalette);

      // Alpha should be unchanged.
      for (let i = 0; i < result.data.length; i += 4) {
        expect(result.data[i + 3]).toBe(200);
      }
    });

    it('should not modify the original ImageData', () => {
      const src = createSolidImage(5, 5, 128, 128, 128);
      const originalData = new Uint8ClampedArray(src.data);
      floydSteinbergDither(src, simplePalette);

      // Original should be unchanged.
      expect(src.data).toEqual(originalData);
    });
  });

  describe('ditherForEInk', () => {
    function createSolidImage(width, height, r, g, b, a = 255) {
      const data = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < data.length; i += 4) {
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        data[i + 3] = a;
      }
      return new ImageData(data, width, height);
    }

    it('should return dithered ImageData', () => {
      const src = createSolidImage(600, 448, 128, 128, 128);
      const result = ditherForEInk(src, 0.5);
      expect(result.width).toBe(600);
      expect(result.height).toBe(448);
    });

    it('should use default saturation of 0.5', () => {
      const src = createSolidImage(600, 448, 128, 128, 128);
      const result = ditherForEInk(src);
      expect(result.width).toBe(600);
      expect(result.height).toBe(448);
    });

    it('should work with non-standard dimensions (with warning)', () => {
      const src = createSolidImage(100, 100, 128, 128, 128);
      const result = ditherForEInk(src, 0.5);
      expect(result.width).toBe(100);
      expect(result.height).toBe(100);
    });

    it('should produce 7-color output', () => {
      // Create a gradient-ish image to trigger different palette colors.
      const data = new Uint8ClampedArray(600 * 448 * 4);
      for (let i = 0; i < 600 * 448; i++) {
        const idx = i * 4;
        data[idx] = (i % 256);
        data[idx + 1] = ((i * 2) % 256);
        data[idx + 2] = ((i * 3) % 256);
        data[idx + 3] = 255;
      }
      const src = new ImageData(data, 600, 448);
      const result = ditherForEInk(src, 0.5);

      // Collect unique colors.
      const colors = new Set();
      for (let i = 0; i < result.data.length; i += 4) {
        const key = `${result.data[i]},${result.data[i + 1]},${result.data[i + 2]}`;
        colors.add(key);
      }

      // Should have at most 8 colors (7 colors + CLEAN white).
      expect(colors.size).toBeLessThanOrEqual(8);
    });
  });
});
