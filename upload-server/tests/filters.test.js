/**
 * Tests for the image resampling filter library.
 */

import { describe, it, expect } from 'vitest';
import FilterLib from '../static/js/filters.js';

describe('FilterLib', () => {
  describe('filter constants', () => {
    it('should export filter type constants', () => {
      expect(FilterLib.BICUBIC).toBe('bicubic');
      expect(FilterLib.BILINEAR).toBe('bilinear');
      expect(FilterLib.LANCZOS).toBe('lanczos');
      expect(FilterLib.MITCHELL).toBe('mitchell');
      expect(FilterLib.NEAREST).toBe('nearest');
    });
  });

  describe('kernel functions', () => {
    describe('nearest', () => {
      const nearest = FilterLib._kernels.nearest;

      it('should return 1 for x in [-0.5, 0.5)', () => {
        expect(nearest(0)).toBe(1);
        expect(nearest(0.25)).toBe(1);
        expect(nearest(-0.25)).toBe(1);
        expect(nearest(0.49)).toBe(1);
        expect(nearest(-0.5)).toBe(1);
      });

      it('should return 0 for x outside [-0.5, 0.5)', () => {
        expect(nearest(0.5)).toBe(0);
        expect(nearest(1)).toBe(0);
        expect(nearest(-1)).toBe(0);
      });
    });

    describe('bilinear', () => {
      const bilinear = FilterLib._kernels.bilinear;

      it('should return 1 at center (x=0)', () => {
        expect(bilinear(0)).toBe(1);
      });

      it('should return 0 at edges (|x|=1)', () => {
        expect(bilinear(1)).toBe(0);
        expect(bilinear(-1)).toBe(0);
      });

      it('should interpolate linearly between 0 and 1', () => {
        expect(bilinear(0.5)).toBe(0.5);
        expect(bilinear(-0.5)).toBe(0.5);
        expect(bilinear(0.25)).toBe(0.75);
      });

      it('should return 0 outside support', () => {
        expect(bilinear(2)).toBe(0);
        expect(bilinear(-2)).toBe(0);
      });
    });

    describe('catmullRom (bicubic)', () => {
      const catmullRom = FilterLib._kernels.catmullRom;

      it('should return 1 at center (x=0)', () => {
        expect(catmullRom(0)).toBe(1);
      });

      it('should return 0 at |x|=2', () => {
        expect(catmullRom(2)).toBe(0);
        expect(catmullRom(-2)).toBe(0);
      });

      it('should return 0 outside support', () => {
        expect(catmullRom(3)).toBe(0);
        expect(catmullRom(-3)).toBe(0);
      });

      it('should be symmetric', () => {
        expect(catmullRom(0.5)).toBeCloseTo(catmullRom(-0.5));
        expect(catmullRom(1.5)).toBeCloseTo(catmullRom(-1.5));
      });
    });

    describe('lanczos', () => {
      const lanczos = FilterLib._kernels.lanczos;

      it('should return 1 at center (x=0)', () => {
        expect(lanczos(0)).toBe(1);
      });

      it('should return 0 at |x|>=3 (default a=3)', () => {
        expect(lanczos(3)).toBe(0);
        expect(lanczos(-3)).toBe(0);
        expect(lanczos(4)).toBe(0);
      });

      it('should be symmetric', () => {
        expect(lanczos(1)).toBeCloseTo(lanczos(-1));
        expect(lanczos(2)).toBeCloseTo(lanczos(-2));
      });
    });

    describe('mitchell', () => {
      const mitchell = FilterLib._kernels.mitchell;

      it('should return value at center (x=0)', () => {
        // Mitchell with B=1/3, C=1/3: at x=0, result is (6 - 2*B) / 6 = (6 - 2/3) / 6
        const expected = (6 - 2/3) / 6;
        expect(mitchell(0)).toBeCloseTo(expected);
      });

      it('should return 0 at |x|>=2', () => {
        expect(mitchell(2)).toBe(0);
        expect(mitchell(-2)).toBe(0);
        expect(mitchell(3)).toBe(0);
      });

      it('should be symmetric', () => {
        expect(mitchell(0.5)).toBeCloseTo(mitchell(-0.5));
        expect(mitchell(1.5)).toBeCloseTo(mitchell(-1.5));
      });
    });
  });

  describe('_getFilter', () => {
    it('should return correct filter for each type', () => {
      const bicubic = FilterLib._getFilter('bicubic');
      expect(bicubic.radius).toBe(2.0);
      expect(typeof bicubic.fn).toBe('function');

      const lanczos = FilterLib._getFilter('lanczos');
      expect(lanczos.radius).toBe(3.0);

      const nearest = FilterLib._getFilter('nearest');
      expect(nearest.radius).toBe(0.5);

      const bilinear = FilterLib._getFilter('bilinear');
      expect(bilinear.radius).toBe(1.0);

      const mitchell = FilterLib._getFilter('mitchell');
      expect(mitchell.radius).toBe(2.0);
    });

    it('should default to bicubic for unknown types', () => {
      const unknown = FilterLib._getFilter('unknown');
      expect(unknown.radius).toBe(2.0);
    });
  });

  describe('resize', () => {
    // Helper to create test ImageData.
    function createTestImage(width, height, fillColor = [255, 0, 0, 255]) {
      const data = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < data.length; i += 4) {
        data[i] = fillColor[0];
        data[i + 1] = fillColor[1];
        data[i + 2] = fillColor[2];
        data[i + 3] = fillColor[3];
      }
      return new ImageData(data, width, height);
    }

    it('should resize to target dimensions', () => {
      const src = createTestImage(100, 100);
      const result = FilterLib.resize(src, 50, 50, 'bilinear');

      expect(result.width).toBe(50);
      expect(result.height).toBe(50);
      expect(result.data.length).toBe(50 * 50 * 4);
    });

    it('should preserve solid color when downscaling', () => {
      const src = createTestImage(100, 100, [128, 64, 32, 255]);
      const result = FilterLib.resize(src, 10, 10, 'bilinear');

      // Check first pixel - should be close to original color.
      expect(result.data[0]).toBeCloseTo(128, 0);
      expect(result.data[1]).toBeCloseTo(64, 0);
      expect(result.data[2]).toBeCloseTo(32, 0);
      expect(result.data[3]).toBeCloseTo(255, 0);
    });

    it('should work with all filter types', () => {
      const src = createTestImage(20, 20);
      const filters = ['nearest', 'bilinear', 'bicubic', 'mitchell', 'lanczos'];

      for (const filter of filters) {
        const result = FilterLib.resize(src, 10, 10, filter);
        expect(result.width).toBe(10);
        expect(result.height).toBe(10);
      }
    });

    it('should handle upscaling', () => {
      const src = createTestImage(10, 10, [100, 150, 200, 255]);
      const result = FilterLib.resize(src, 20, 20, 'bilinear');

      expect(result.width).toBe(20);
      expect(result.height).toBe(20);
    });

    it('should handle non-square images', () => {
      const src = createTestImage(100, 50);
      const result = FilterLib.resize(src, 60, 45, 'bicubic');

      expect(result.width).toBe(60);
      expect(result.height).toBe(45);
    });

    it('should resize to exact e-ink display dimensions', () => {
      const src = createTestImage(1200, 800);
      const result = FilterLib.resize(src, 600, 448, 'lanczos');

      expect(result.width).toBe(600);
      expect(result.height).toBe(448);
    });
  });
});
