/**
 * E2E tests for the gallery view.
 */

import { test, expect } from '@playwright/test';

test.describe('Gallery View', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('should load the gallery page', async ({ page }) => {
    // Check page title.
    await expect(page).toHaveTitle('inky-soup');

    // Gallery view should be visible.
    await expect(page.locator('#galleryView')).toBeVisible();

    // Upload fieldset should be present.
    await expect(page.locator('fieldset legend').first()).toHaveText('Upload New Image');

    // Gallery fieldset should be present.
    await expect(page.locator('fieldset legend').nth(1)).toHaveText('Gallery');
  });

  test('should have a working drop zone', async ({ page }) => {
    const dropZone = page.locator('#dropZone');

    // Drop zone should be visible.
    await expect(dropZone).toBeVisible();

    // Should show upload prompt.
    await expect(dropZone.locator('.drop-zone-prompt')).toHaveText('Drop image here or click to upload');

    // Should show file type hint.
    await expect(dropZone.locator('.drop-zone-hint')).toContainText('JPEG, PNG, GIF, WebP');
  });

  test('should have hidden file input', async ({ page }) => {
    const fileInput = page.locator('#fileInput');

    // File input exists but is hidden.
    await expect(fileInput).toBeAttached();
    await expect(fileInput).toHaveAttribute('accept', 'image/*');
  });

  test('drop zone should be clickable', async ({ page }) => {
    const dropZone = page.locator('#dropZone');

    // Clicking drop zone should trigger file input (we can't fully test file dialog).
    // Just verify it's interactive.
    await expect(dropZone).toHaveCSS('cursor', 'pointer');
  });
});

test.describe('Gallery with Images', () => {
  // These tests assume there are images in the gallery.
  // They will be skipped if the gallery is empty.

  test('thumbnail click should open detail view', async ({ page }) => {
    await page.goto('/');

    // Check if there are any thumbnails.
    const thumbnails = page.locator('.thumbnail-item img');
    const count = await thumbnails.count();

    if (count === 0) {
      test.skip();
      return;
    }

    // Click the first thumbnail.
    await thumbnails.first().click();

    // Detail view should become visible.
    await expect(page.locator('#detailView')).toBeVisible();

    // Gallery view should be hidden.
    await expect(page.locator('#galleryView')).not.toBeVisible();
  });

  test('back button should return to gallery', async ({ page }) => {
    await page.goto('/');

    const thumbnails = page.locator('.thumbnail-item img');
    const count = await thumbnails.count();

    if (count === 0) {
      test.skip();
      return;
    }

    // Click thumbnail to open detail view.
    await thumbnails.first().click();
    await expect(page.locator('#detailView')).toBeVisible();

    // Click back button.
    await page.locator('.back-button').click();

    // Should return to gallery.
    await expect(page.locator('#galleryView')).toBeVisible();
    await expect(page.locator('#detailView')).not.toBeVisible();
  });
});
