/**
 * E2E tests for orphaned image recovery.
 * Tests that the gallery can recover from images that have no thumbnail.
 */

import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';

test.describe('Orphaned Image Recovery', () => {
  const testImagePath = path.join(import.meta.dirname, 'fixtures', 'test-image.png');
  const imagesDir = path.join(import.meta.dirname, '..', 'static', 'images');

  test('should generate missing thumbnail when placeholder is rendered', async ({ page }) => {
    const filename = `orphaned_test_${Date.now()}.jpg`;
    const destPath = path.join(imagesDir, filename);

    // Manually copy file to create orphaned state (original exists, no thumb).
    fs.copyFileSync(testImagePath, destPath);

    try {
      // Navigate to gallery - should see placeholder.
      await page.goto('/');
      await page.waitForLoadState('networkidle');

      const placeholder = page.locator(`.thumbnail-placeholder[data-filename="${filename}"]`);
      await expect(placeholder).toBeVisible({ timeout: 2000 });
      await expect(placeholder.locator('.label')).toHaveText('Caching...');

      // Client should automatically generate and upload the thumbnail.
      // Placeholder should be replaced with actual image.
      const thumbnail = page.locator(`.thumbnail-item img[data-filename="${filename}"]`);
      await expect(thumbnail).toBeVisible({ timeout: 10000 });

      // Verify thumbnail is actually loaded.
      const isLoaded = await thumbnail.evaluate((img) => img.complete && img.naturalWidth > 0);
      expect(isLoaded).toBe(true);
    } finally {
      // Cleanup: Remove test files.
      try {
        fs.unlinkSync(destPath);
        fs.unlinkSync(path.join(imagesDir, 'cache', `${filename}.png`));
        fs.unlinkSync(path.join(imagesDir, 'thumbs', `${filename}.png`));
      } catch {
        // Files may not exist.
      }
    }
  });
});
