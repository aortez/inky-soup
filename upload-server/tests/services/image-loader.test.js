/**
 * Tests for image-loader service.
 * Verifies cache-first loading and lazy recompute behavior.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the state module.
vi.mock('../../static/js/core/state.js', () => ({
  getOriginalImageCache: vi.fn(() => ({})),
  setOriginalImageCache: vi.fn(),
  getDisplayWidth: vi.fn(() => 1600),
  getDisplayHeight: vi.fn(() => 1200),
  getCurrentCacheVersion: vi.fn(() => 2),
}));

// Mock the dom module.
vi.mock('../../static/js/core/dom.js', () => ({
  elements: {
    filterProcessing: { textContent: '' },
  },
}));

// Mock the image-utils module.
vi.mock('../../static/js/utils/image-utils.js', () => ({
  createImageDataFromImage: vi.fn((img) => ({
    width: img.width,
    height: img.height,
    data: new Uint8ClampedArray(img.width * img.height * 4),
  })),
}));

describe('image-loader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('loadImageUsingCache', () => {
    it('should return needsFiltering=false when cache dimensions match', async () => {
      const { loadImageUsingCache } = await import('../../static/js/services/image-loader.js');

      // Create a mock cached image with MATCHING dimensions.
      const mockCachedImage = {
        width: 1600,
        height: 1200,
        onload: null,
        onerror: null,
        crossOrigin: null,
        src: '',
      };

      const originalImage = global.Image;
      global.Image = vi.fn(() => mockCachedImage);

      const promise = loadImageUsingCache('test.jpg');

      // Simulate successful cache load.
      mockCachedImage.onload();

      const result = await promise;

      expect(result.needsFiltering).toBe(false);
      expect(result.imageData).toBeDefined();
      expect(result.imageData.width).toBe(1600);
      expect(result.imageData.height).toBe(1200);

      global.Image = originalImage;
    });

    it('should return needsFiltering=true when cache dimensions mismatch', async () => {
      const { loadImageUsingCache } = await import('../../static/js/services/image-loader.js');

      // Create a mock cached image with OLD dimensions (600x448).
      const mockCachedImage = {
        width: 600,
        height: 448,
        onload: null,
        onerror: null,
        crossOrigin: null,
        src: '',
      };

      // Create a mock original image.
      const mockOriginalImage = {
        width: 2000,
        height: 1500,
        onload: null,
        onerror: null,
        crossOrigin: null,
        src: '',
      };

      let imageCount = 0;
      const originalImage = global.Image;
      global.Image = vi.fn(() => {
        imageCount += 1;
        return imageCount === 1 ? mockCachedImage : mockOriginalImage;
      });

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const promise = loadImageUsingCache('test.jpg');

      // Simulate cached image load (with wrong dimensions).
      mockCachedImage.onload();

      // Wait a tick for the async flow.
      await new Promise((resolve) => { setTimeout(resolve, 0); });

      // Simulate original image load.
      mockOriginalImage.onload();

      const result = await promise;

      // Should log the mismatch.
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Cache dimensions mismatch'),
      );

      // Should indicate filtering is needed.
      expect(result.needsFiltering).toBe(true);
      expect(result.imageData).toBeDefined();

      consoleSpy.mockRestore();
      global.Image = originalImage;
    });

    it('should return needsFiltering=true when cache does not exist', async () => {
      const { loadImageUsingCache } = await import('../../static/js/services/image-loader.js');

      // Create mock images.
      const mockCachedImage = {
        onload: null,
        onerror: null,
        crossOrigin: null,
        src: '',
      };

      const mockOriginalImage = {
        width: 2000,
        height: 1500,
        onload: null,
        onerror: null,
        crossOrigin: null,
        src: '',
      };

      let imageCount = 0;
      const originalImage = global.Image;
      global.Image = vi.fn(() => {
        imageCount += 1;
        return imageCount === 1 ? mockCachedImage : mockOriginalImage;
      });

      const promise = loadImageUsingCache('test.jpg');

      // Simulate cache miss (404).
      mockCachedImage.onerror();

      // Wait a tick for the async flow.
      await new Promise((resolve) => { setTimeout(resolve, 0); });

      // Simulate original image load.
      mockOriginalImage.onload();

      const result = await promise;

      // Should indicate filtering is needed.
      expect(result.needsFiltering).toBe(true);
      expect(result.imageData).toBeDefined();

      global.Image = originalImage;
    });

    it('should return needsFiltering=true when cache version mismatch', async () => {
      const { loadImageUsingCache } = await import('../../static/js/services/image-loader.js');
      const { getCurrentCacheVersion } = await import('../../static/js/core/state.js');

      getCurrentCacheVersion.mockReturnValue(1);

      const mockOriginalImage = {
        width: 2000,
        height: 1500,
        onload: null,
        onerror: null,
        crossOrigin: null,
        src: '',
      };

      const originalImage = global.Image;
      global.Image = vi.fn(() => mockOriginalImage);
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const promise = loadImageUsingCache('test.jpg');

      mockOriginalImage.onload();

      const result = await promise;

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Cache version mismatch'),
      );
      expect(result.needsFiltering).toBe(true);
      expect(result.imageData).toBeDefined();

      consoleSpy.mockRestore();
      global.Image = originalImage;
    });
  });

  describe('loadOriginal', () => {
    it('should resolve with loaded image', async () => {
      const { loadOriginal } = await import('../../static/js/services/image-loader.js');

      const mockImage = {
        width: 2000,
        height: 1500,
        onload: null,
        onerror: null,
        crossOrigin: null,
        src: '',
      };

      const originalImage = global.Image;
      global.Image = vi.fn(() => mockImage);

      const promise = loadOriginal('test.jpg');

      // Simulate successful load.
      mockImage.onload();

      const result = await promise;
      expect(result).toBe(mockImage);

      global.Image = originalImage;
    });

    it('should cache loaded image in memory', async () => {
      const { setOriginalImageCache } = await import('../../static/js/core/state.js');
      const { loadOriginal } = await import('../../static/js/services/image-loader.js');

      const mockImage = {
        width: 2000,
        height: 1500,
        onload: null,
        onerror: null,
        crossOrigin: null,
        src: '',
      };

      const originalImage = global.Image;
      global.Image = vi.fn(() => mockImage);

      const promise = loadOriginal('test.jpg');
      mockImage.onload();
      await promise;

      // Should have cached the image.
      expect(setOriginalImageCache).toHaveBeenCalledWith(
        expect.objectContaining({ 'test.jpg': mockImage }),
      );

      global.Image = originalImage;
    });
  });
});
