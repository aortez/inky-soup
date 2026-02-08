/**
 * E2E tests for orphaned image recovery.
 * Tests that the gallery can recover from images that have no thumbnail.
 */

import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';

test.describe('Orphaned Image Recovery', () => {
  const testImagePath = path.join(import.meta.dirname, 'fixtures', 'test-image.png');

  test('should generate missing thumbnail when placeholder is rendered', async ({ page, request }) => {
    const filename = `orphaned_test_${Date.now()}.png`;

    // Upload directly to /upload API without going through browser JS.
    // This creates an orphaned state: original exists but no thumbnail.
    const fileBuffer = fs.readFileSync(testImagePath);
    const response = await request.post('/upload', {
      multipart: {
        'submission.file': {
          name: filename,
          mimeType: 'image/png',
          buffer: fileBuffer,
        },
      },
    });
    expect(response.ok()).toBe(true);
    const uploadResult = await response.json();
    expect(uploadResult.success).toBe(true);

    try {
      // Navigate to gallery - should see placeholder for orphaned image.
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
      // Cleanup via delete API.
      await request.post('/delete', {
        form: {
          'submission.image_file_path': `images/${filename}`,
        },
      });
    }
  });
});
