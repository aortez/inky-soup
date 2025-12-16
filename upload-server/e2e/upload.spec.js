/**
 * E2E tests for image upload functionality.
 */

import { test, expect } from '@playwright/test';
import path from 'path';

test.describe('Image Upload', () => {
  const testImagePath = path.join(import.meta.dirname, 'fixtures', 'test-image.png');

  test('should upload an image and show completion', async ({ page }) => {
    await page.goto('/');

    // Get the file input.
    const fileInput = page.locator('#fileInput');

    // Upload the test image.
    await fileInput.setInputFiles(testImagePath);

    // Upload modal should appear with progress.
    await expect(page.locator('#uploadModal')).toHaveClass(/active/);
    await expect(page.locator('#uploadProgress')).toBeAttached();

    // Wait for upload to complete (modal title changes).
    await expect(page.locator('#uploadModalTitle')).toHaveText('✓ Upload Complete!', { timeout: 30000 });

    // Close button should be visible.
    await expect(page.locator('#uploadCloseBtn')).toBeVisible();
  });

  test('uploaded image should appear in gallery after closing modal', async ({ page }) => {
    await page.goto('/');

    // Check initial thumbnail count.
    const initialCount = await page.locator('.thumbnail-item').count();

    // Upload image.
    const fileInput = page.locator('#fileInput');
    await fileInput.setInputFiles(testImagePath);

    // Wait for completion.
    await expect(page.locator('#uploadModalTitle')).toHaveText('✓ Upload Complete!', { timeout: 30000 });

    // Close modal (this reloads the page).
    await page.locator('#uploadCloseBtn').click();

    // Wait for page to reload and gallery to have more thumbnails.
    await page.waitForLoadState('networkidle');

    // Should have at least one thumbnail now.
    const thumbnailItems = page.locator('.thumbnail-item');
    await expect(thumbnailItems).not.toHaveCount(0);
  });
});

test.describe('Upload with existing images', () => {
  test('should be able to click uploaded image and open detail view', async ({ page }) => {
    await page.goto('/');

    // Check if there are any ready thumbnails (img tags, not placeholders).
    const thumbnails = page.locator('.thumbnail-item img');
    const count = await thumbnails.count();

    if (count === 0) {
      // Upload an image first.
      const testImagePath = path.join(import.meta.dirname, 'fixtures', 'test-image.png');
      const fileInput = page.locator('#fileInput');
      await fileInput.setInputFiles(testImagePath);

      // Wait for completion and close.
      await expect(page.locator('#uploadModalTitle')).toHaveText('✓ Upload Complete!', { timeout: 30000 });
      await page.locator('#uploadCloseBtn').click();
      await page.waitForLoadState('networkidle');

      // Wait for thumbnail to be ready (poll for img tag).
      await expect(page.locator('.thumbnail-item img').first()).toBeVisible({ timeout: 10000 });
    }

    // Now click the first thumbnail.
    await page.locator('.thumbnail-item img').first().click();

    // Detail view should open.
    await expect(page.locator('#detailView')).toBeVisible();

    // Pipeline should be visible.
    await expect(page.locator('.pipeline')).toBeVisible();
    await expect(page.locator('#filterCanvas')).toBeVisible();
    await expect(page.locator('#ditherCanvas')).toBeVisible();
  });
});
