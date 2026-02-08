/**
 * Tests for e-ink dithering library.
 */

import { describe, it, expect } from 'vitest';
import { loadBrowserModule } from './helpers/load-browser-module.js';

// Load the dither module.
const {
  BAYER_4X4,
  DITHER_ALGORITHMS,
  USE_WEIGHTED_RGB,
  applyBrightnessContrast,
  atkinsonDither,
  ditherForEInk,
  findClosestPaletteColor,
  floydSteinbergDither,
  generatePalette,
  orderedDither,
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

    it('should accept algorithm parameter', () => {
      const src = createSolidImage(100, 100, 128, 128, 128);

      const fsResult = ditherForEInk(src, 0.5, 'floyd-steinberg');
      expect(fsResult.width).toBe(100);

      const atkinsonResult = ditherForEInk(createSolidImage(100, 100, 128, 128, 128), 0.5, 'atkinson');
      expect(atkinsonResult.width).toBe(100);

      const orderedResult = ditherForEInk(createSolidImage(100, 100, 128, 128, 128), 0.5, 'ordered');
      expect(orderedResult.width).toBe(100);
    });

    it('should fall back to floyd-steinberg for unknown algorithm', () => {
      const src = createSolidImage(100, 100, 128, 128, 128);
      const result = ditherForEInk(src, 0.5, 'unknown-algorithm');
      expect(result.width).toBe(100);
    });
  });

  describe('atkinsonDither', () => {
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
      const result = atkinsonDither(src, simplePalette);
      expect(result.width).toBe(10);
      expect(result.height).toBe(10);
    });

    it('should preserve white pixels', () => {
      const src = createSolidImage(10, 10, 255, 255, 255);
      const result = atkinsonDither(src, simplePalette);

      for (let i = 0; i < result.data.length; i += 4) {
        expect(result.data[i]).toBe(255);
        expect(result.data[i + 1]).toBe(255);
        expect(result.data[i + 2]).toBe(255);
      }
    });

    it('should preserve black pixels', () => {
      const src = createSolidImage(10, 10, 0, 0, 0);
      const result = atkinsonDither(src, simplePalette);

      for (let i = 0; i < result.data.length; i += 4) {
        expect(result.data[i]).toBe(0);
        expect(result.data[i + 1]).toBe(0);
        expect(result.data[i + 2]).toBe(0);
      }
    });

    it('should dither gray to mix of black and white', () => {
      const src = createSolidImage(10, 10, 128, 128, 128);
      const result = atkinsonDither(src, simplePalette);

      let blackCount = 0;
      let whiteCount = 0;
      for (let i = 0; i < result.data.length; i += 4) {
        if (result.data[i] === 0) blackCount++;
        if (result.data[i] === 255) whiteCount++;
      }

      expect(blackCount).toBeGreaterThan(0);
      expect(whiteCount).toBeGreaterThan(0);
    });

    it('should preserve alpha channel', () => {
      const src = createSolidImage(10, 10, 128, 128, 128, 200);
      const result = atkinsonDither(src, simplePalette);

      for (let i = 0; i < result.data.length; i += 4) {
        expect(result.data[i + 3]).toBe(200);
      }
    });

    it('should not modify the original ImageData', () => {
      const src = createSolidImage(5, 5, 128, 128, 128);
      const originalData = new Uint8ClampedArray(src.data);
      atkinsonDither(src, simplePalette);
      expect(src.data).toEqual(originalData);
    });

    it('should differ from Floyd-Steinberg (only diffuses 75% of error)', () => {
      // Atkinson only diffuses 6/8 of error vs Floyd-Steinberg's 16/16.
      // This means Atkinson tends to produce higher contrast results.
      const src = createSolidImage(20, 20, 100, 100, 100);
      const fsResult = floydSteinbergDither(createSolidImage(20, 20, 100, 100, 100), simplePalette);
      const atkinsonResult = atkinsonDither(src, simplePalette);

      // They should produce different results (not identical).
      let differences = 0;
      for (let i = 0; i < fsResult.data.length; i += 4) {
        if (fsResult.data[i] !== atkinsonResult.data[i]) differences++;
      }

      // Expect at least some difference in the dither patterns.
      expect(differences).toBeGreaterThan(0);
    });
  });

  describe('orderedDither', () => {
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
      const result = orderedDither(src, simplePalette);
      expect(result.width).toBe(10);
      expect(result.height).toBe(10);
    });

    it('should preserve white pixels', () => {
      const src = createSolidImage(10, 10, 255, 255, 255);
      const result = orderedDither(src, simplePalette);

      for (let i = 0; i < result.data.length; i += 4) {
        expect(result.data[i]).toBe(255);
        expect(result.data[i + 1]).toBe(255);
        expect(result.data[i + 2]).toBe(255);
      }
    });

    it('should preserve black pixels', () => {
      const src = createSolidImage(10, 10, 0, 0, 0);
      const result = orderedDither(src, simplePalette);

      for (let i = 0; i < result.data.length; i += 4) {
        expect(result.data[i]).toBe(0);
        expect(result.data[i + 1]).toBe(0);
        expect(result.data[i + 2]).toBe(0);
      }
    });

    it('should dither gray to mix of black and white', () => {
      const src = createSolidImage(10, 10, 128, 128, 128);
      const result = orderedDither(src, simplePalette);

      let blackCount = 0;
      let whiteCount = 0;
      for (let i = 0; i < result.data.length; i += 4) {
        if (result.data[i] === 0) blackCount++;
        if (result.data[i] === 255) whiteCount++;
      }

      expect(blackCount).toBeGreaterThan(0);
      expect(whiteCount).toBeGreaterThan(0);
    });

    it('should produce deterministic pattern (same input = same output)', () => {
      const src1 = createSolidImage(8, 8, 128, 128, 128);
      const src2 = createSolidImage(8, 8, 128, 128, 128);
      const result1 = orderedDither(src1, simplePalette);
      const result2 = orderedDither(src2, simplePalette);

      for (let i = 0; i < result1.data.length; i++) {
        expect(result1.data[i]).toBe(result2.data[i]);
      }
    });

    it('should create 4x4 repeating pattern for uniform input', () => {
      // For a uniform gray, the Bayer pattern should create a repeating 4x4 tile.
      const src = createSolidImage(8, 8, 128, 128, 128);
      const result = orderedDither(src, simplePalette);

      // Check that the pattern repeats every 4 pixels.
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) {
          const idx1 = (y * 8 + x) * 4;
          const idx2 = ((y + 4) * 8 + x) * 4;
          const idx3 = (y * 8 + (x + 4)) * 4;
          const idx4 = ((y + 4) * 8 + (x + 4)) * 4;

          expect(result.data[idx1]).toBe(result.data[idx2]);
          expect(result.data[idx1]).toBe(result.data[idx3]);
          expect(result.data[idx1]).toBe(result.data[idx4]);
        }
      }
    });
  });

  describe('BAYER_4X4', () => {
    it('should be a 4x4 matrix', () => {
      expect(BAYER_4X4).toHaveLength(4);
      BAYER_4X4.forEach((row) => {
        expect(row).toHaveLength(4);
      });
    });

    it('should contain values 0-15', () => {
      const allValues = BAYER_4X4.flat().sort((a, b) => a - b);
      expect(allValues).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    });
  });

  describe('DITHER_ALGORITHMS', () => {
    it('should contain all three algorithms', () => {
      expect(DITHER_ALGORITHMS).toHaveProperty('floyd-steinberg');
      expect(DITHER_ALGORITHMS).toHaveProperty('atkinson');
      expect(DITHER_ALGORITHMS).toHaveProperty('ordered');
    });

    it('should map to correct functions', () => {
      expect(DITHER_ALGORITHMS['floyd-steinberg']).toBe(floydSteinbergDither);
      expect(DITHER_ALGORITHMS['atkinson']).toBe(atkinsonDither);
      expect(DITHER_ALGORITHMS['ordered']).toBe(orderedDither);
    });
  });

  describe('USE_WEIGHTED_RGB', () => {
    it('should be a boolean', () => {
      expect(typeof USE_WEIGHTED_RGB).toBe('boolean');
    });
  });

  describe('applyBrightnessContrast', () => {
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

    it('should return same image when brightness and contrast are 0', () => {
      const src = createSolidImage(5, 5, 128, 128, 128);
      const result = applyBrightnessContrast(src, 0, 0);

      // Should be the same object (no modification needed).
      expect(result).toBe(src);

      // Values should be unchanged.
      for (let i = 0; i < result.data.length; i += 4) {
        expect(result.data[i]).toBe(128);
        expect(result.data[i + 1]).toBe(128);
        expect(result.data[i + 2]).toBe(128);
      }
    });

    it('should increase brightness', () => {
      const src = createSolidImage(5, 5, 100, 100, 100);
      applyBrightnessContrast(src, 50, 0);

      // 100 + 50 = 150.
      for (let i = 0; i < src.data.length; i += 4) {
        expect(src.data[i]).toBe(150);
        expect(src.data[i + 1]).toBe(150);
        expect(src.data[i + 2]).toBe(150);
      }
    });

    it('should decrease brightness', () => {
      const src = createSolidImage(5, 5, 100, 100, 100);
      applyBrightnessContrast(src, -50, 0);

      // 100 - 50 = 50.
      for (let i = 0; i < src.data.length; i += 4) {
        expect(src.data[i]).toBe(50);
        expect(src.data[i + 1]).toBe(50);
        expect(src.data[i + 2]).toBe(50);
      }
    });

    it('should clamp brightness to 0-255', () => {
      const src = createSolidImage(5, 5, 200, 50, 200);
      applyBrightnessContrast(src, 100, 0);

      // 200 + 100 = 300, clamped to 255.
      // 50 + 100 = 150.
      for (let i = 0; i < src.data.length; i += 4) {
        expect(src.data[i]).toBe(255);
        expect(src.data[i + 1]).toBe(150);
        expect(src.data[i + 2]).toBe(255);
      }
    });

    it('should increase contrast', () => {
      const src = createSolidImage(5, 5, 192, 192, 192);
      applyBrightnessContrast(src, 0, 100);

      // Contrast 100 means factor = 2.
      // (192 - 128) * 2 + 128 = 64 * 2 + 128 = 256, clamped to 255.
      for (let i = 0; i < src.data.length; i += 4) {
        expect(src.data[i]).toBe(255);
      }
    });

    it('should decrease contrast', () => {
      const src = createSolidImage(5, 5, 200, 200, 200);
      applyBrightnessContrast(src, 0, -50);

      // Contrast -50 means factor = 0.5.
      // (200 - 128) * 0.5 + 128 = 72 * 0.5 + 128 = 36 + 128 = 164.
      for (let i = 0; i < src.data.length; i += 4) {
        expect(src.data[i]).toBe(164);
      }
    });

    it('should apply both brightness and contrast', () => {
      const src = createSolidImage(5, 5, 128, 128, 128);
      applyBrightnessContrast(src, 20, 50);

      // Contrast 50 means factor = 1.5.
      // (128 - 128) * 1.5 + 128 + 20 = 0 + 128 + 20 = 148.
      for (let i = 0; i < src.data.length; i += 4) {
        expect(src.data[i]).toBe(148);
      }
    });

    it('should preserve alpha channel', () => {
      const src = createSolidImage(5, 5, 100, 100, 100, 200);
      applyBrightnessContrast(src, 50, 50);

      for (let i = 0; i < src.data.length; i += 4) {
        expect(src.data[i + 3]).toBe(200);
      }
    });

    it('should modify image in place', () => {
      const src = createSolidImage(5, 5, 100, 100, 100);
      const result = applyBrightnessContrast(src, 50, 0);

      // Should return the same object.
      expect(result).toBe(src);
    });

    it('should handle edge case of maximum contrast reduction', () => {
      // At contrast = -100, factor = 0, everything becomes middle gray.
      const src = createSolidImage(5, 5, 200, 50, 128);
      applyBrightnessContrast(src, 0, -100);

      // (value - 128) * 0 + 128 = 128 for all.
      for (let i = 0; i < src.data.length; i += 4) {
        expect(src.data[i]).toBe(128);
        expect(src.data[i + 1]).toBe(128);
        expect(src.data[i + 2]).toBe(128);
      }
    });
  });
});
