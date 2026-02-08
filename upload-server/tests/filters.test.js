/**
 * Tests for image resampling filter library.
 */

import { describe, it, expect } from 'vitest';
import { loadBrowserModule } from './helpers/load-browser-module.js';

// Load the FilterLib module.
const FilterLib = loadBrowserModule('filters.js');

describe('FilterLib', () => {
  describe('Constants', () => {
    it('should export filter type constants', () => {
      expect(FilterLib.BICUBIC).toBe('bicubic');
      expect(FilterLib.BILINEAR).toBe('bilinear');
      expect(FilterLib.LANCZOS).toBe('lanczos');
      expect(FilterLib.MITCHELL).toBe('mitchell');
      expect(FilterLib.NEAREST).toBe('nearest');
    });
  });

  describe('Kernel Functions', () => {
    const { nearest, bilinear, catmullRom, lanczos, mitchell } = FilterLib._kernels;

    describe('nearest', () => {
      it('should return 1 at center', () => {
        expect(nearest(0)).toBe(1);
      });

      it('should return 1 within [-0.5, 0.5)', () => {
        expect(nearest(0.25)).toBe(1);
        expect(nearest(-0.25)).toBe(1);
        expect(nearest(0.49)).toBe(1);
        expect(nearest(-0.5)).toBe(1);
      });

      it('should return 0 outside [-0.5, 0.5)', () => {
        expect(nearest(0.5)).toBe(0);
        expect(nearest(0.6)).toBe(0);
        expect(nearest(-0.6)).toBe(0);
        expect(nearest(1)).toBe(0);
      });
    });

    describe('bilinear', () => {
      it('should return 1 at center', () => {
        expect(bilinear(0)).toBe(1);
      });

      it('should return 0 at distance 1', () => {
        expect(bilinear(1)).toBe(0);
        expect(bilinear(-1)).toBe(0);
      });

      it('should return 0.5 at distance 0.5', () => {
        expect(bilinear(0.5)).toBe(0.5);
        expect(bilinear(-0.5)).toBe(0.5);
      });

      it('should return 0 beyond distance 1', () => {
        expect(bilinear(1.5)).toBe(0);
        expect(bilinear(-1.5)).toBe(0);
      });
    });

    describe('catmullRom (bicubic)', () => {
      it('should return 1 at center', () => {
        expect(catmullRom(0)).toBe(1);
      });

      it('should return 0 at distance 2', () => {
        expect(catmullRom(2)).toBe(0);
        expect(catmullRom(-2)).toBe(0);
      });

      it('should return 0 beyond distance 2', () => {
        expect(catmullRom(2.5)).toBe(0);
        expect(catmullRom(-2.5)).toBe(0);
      });

      it('should have negative lobes between 1 and 2', () => {
        // Catmull-Rom has negative values in this range.
        expect(catmullRom(1.5)).toBeLessThan(0);
        expect(catmullRom(-1.5)).toBeLessThan(0);
      });
    });

    describe('lanczos', () => {
      it('should return 1 at center', () => {
        expect(lanczos(0)).toBe(1);
      });

      it('should return 0 at integer distances within support', () => {
        // Lanczos returns 0 at non-zero integers (sinc zeros).
        expect(lanczos(1)).toBeCloseTo(0, 10);
        expect(lanczos(2)).toBeCloseTo(0, 10);
        expect(lanczos(-1)).toBeCloseTo(0, 10);
        expect(lanczos(-2)).toBeCloseTo(0, 10);
      });

      it('should return 0 at and beyond support radius', () => {
        expect(lanczos(3)).toBe(0);
        expect(lanczos(-3)).toBe(0);
        expect(lanczos(4)).toBe(0);
      });

      it('should have positive values near center', () => {
        expect(lanczos(0.5)).toBeGreaterThan(0);
        expect(lanczos(-0.5)).toBeGreaterThan(0);
      });
    });

    describe('mitchell', () => {
      it('should return value close to 1 at center', () => {
        // Mitchell with B=1/3, C=1/3 returns (6 - 2B) / 6 = 8/9 at x=0.
        expect(mitchell(0)).toBeCloseTo(8 / 9, 10);
      });

      it('should return 0 at distance 2', () => {
        expect(mitchell(2)).toBe(0);
        expect(mitchell(-2)).toBe(0);
      });

      it('should return 0 beyond distance 2', () => {
        expect(mitchell(2.5)).toBe(0);
        expect(mitchell(-2.5)).toBe(0);
      });

      it('should be symmetric', () => {
        expect(mitchell(0.5)).toBeCloseTo(mitchell(-0.5), 10);
        expect(mitchell(1.5)).toBeCloseTo(mitchell(-1.5), 10);
      });
    });
  });

  describe('getFilter', () => {
    const getFilter = FilterLib._getFilter;

    it('should return correct filter for nearest', () => {
      const filter = getFilter('nearest');
      expect(filter.radius).toBe(0.5);
      expect(filter.fn(0)).toBe(1);
    });

    it('should return correct filter for bilinear', () => {
      const filter = getFilter('bilinear');
      expect(filter.radius).toBe(1.0);
      expect(filter.fn(0)).toBe(1);
    });

    it('should return correct filter for bicubic', () => {
      const filter = getFilter('bicubic');
      expect(filter.radius).toBe(2.0);
      expect(filter.fn(0)).toBe(1);
    });

    it('should return correct filter for mitchell', () => {
      const filter = getFilter('mitchell');
      expect(filter.radius).toBe(2.0);
    });

    it('should return correct filter for lanczos', () => {
      const filter = getFilter('lanczos');
      expect(filter.radius).toBe(3.0);
      expect(filter.fn(0)).toBe(1);
    });

    it('should default to bicubic for unknown filter', () => {
      const filter = getFilter('unknown');
      expect(filter.radius).toBe(2.0);
      expect(filter.fn(0)).toBe(1);
    });
  });

  describe('resize', () => {
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

    it('should resize to target dimensions', () => {
      const src = createSolidImage(100, 100, 255, 0, 0);
      const result = FilterLib.resize(src, 50, 50, 'bilinear');
      expect(result.width).toBe(50);
      expect(result.height).toBe(50);
    });

    it('should preserve solid color with bilinear', () => {
      const src = createSolidImage(100, 100, 128, 64, 32);
      const result = FilterLib.resize(src, 50, 50, 'bilinear');

      // Check center pixel is approximately the same color.
      const idx = (25 * 50 + 25) * 4;
      expect(result.data[idx]).toBeCloseTo(128, 0);
      expect(result.data[idx + 1]).toBeCloseTo(64, 0);
      expect(result.data[idx + 2]).toBeCloseTo(32, 0);
    });

    it('should preserve solid color with bicubic', () => {
      const src = createSolidImage(100, 100, 200, 100, 50);
      const result = FilterLib.resize(src, 50, 50, 'bicubic');

      const idx = (25 * 50 + 25) * 4;
      expect(result.data[idx]).toBeCloseTo(200, 0);
      expect(result.data[idx + 1]).toBeCloseTo(100, 0);
      expect(result.data[idx + 2]).toBeCloseTo(50, 0);
    });

    it('should work with nearest neighbor', () => {
      const src = createSolidImage(10, 10, 255, 255, 255);
      const result = FilterLib.resize(src, 5, 5, 'nearest');
      expect(result.width).toBe(5);
      expect(result.height).toBe(5);
      expect(result.data[0]).toBe(255);
    });

    it('should work with lanczos', () => {
      const src = createSolidImage(100, 100, 100, 150, 200);
      const result = FilterLib.resize(src, 50, 50, 'lanczos');
      expect(result.width).toBe(50);
      expect(result.height).toBe(50);
    });

    it('should work with mitchell', () => {
      const src = createSolidImage(100, 100, 100, 150, 200);
      const result = FilterLib.resize(src, 50, 50, 'mitchell');
      expect(result.width).toBe(50);
      expect(result.height).toBe(50);
    });

    it('should preserve alpha channel', () => {
      const src = createSolidImage(100, 100, 255, 0, 0, 128);
      const result = FilterLib.resize(src, 50, 50, 'bilinear');

      const idx = (25 * 50 + 25) * 4;
      expect(result.data[idx + 3]).toBeCloseTo(128, 0);
    });

    it('should handle upscaling', () => {
      const src = createSolidImage(10, 10, 64, 128, 192);
      const result = FilterLib.resize(src, 50, 50, 'bilinear');
      expect(result.width).toBe(50);
      expect(result.height).toBe(50);
    });
  });

  describe('resizeToFit', () => {
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

    function createTwoToneImage(width, height, left, right) {
      const data = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * 4;
          const color = x < width / 2 ? left : right;
          data[idx] = color[0];
          data[idx + 1] = color[1];
          data[idx + 2] = color[2];
          data[idx + 3] = 255;
        }
      }
      return new ImageData(data, width, height);
    }

    it('should letterbox when using contain mode', () => {
      const src = createSolidImage(100, 50, 10, 200, 30);
      const result = FilterLib.resizeToFit(src, 50, 50, 'nearest', 'contain');

      expect(result.width).toBe(50);
      expect(result.height).toBe(50);

      const topLeft = 0;
      expect(result.data[topLeft]).toBe(255);
      expect(result.data[topLeft + 1]).toBe(255);
      expect(result.data[topLeft + 2]).toBe(255);

      const centerIdx = (25 * 50 + 25) * 4;
      expect(result.data[centerIdx]).toBeCloseTo(10, 0);
      expect(result.data[centerIdx + 1]).toBeCloseTo(200, 0);
      expect(result.data[centerIdx + 2]).toBeCloseTo(30, 0);
    });

    it('should crop when using cover mode', () => {
      const src = createTwoToneImage(100, 50, [255, 0, 0], [0, 0, 255]);
      const result = FilterLib.resizeToFit(src, 50, 50, 'nearest', 'cover');

      const leftIdx = (25 * 50 + 0) * 4;
      const rightIdx = (25 * 50 + 49) * 4;

      expect(result.data[leftIdx]).toBe(255);
      expect(result.data[leftIdx + 1]).toBe(0);
      expect(result.data[leftIdx + 2]).toBe(0);

      expect(result.data[rightIdx]).toBe(0);
      expect(result.data[rightIdx + 1]).toBe(0);
      expect(result.data[rightIdx + 2]).toBe(255);
    });
  });
});
