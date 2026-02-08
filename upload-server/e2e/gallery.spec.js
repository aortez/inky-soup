/**
 * E2E tests for the gallery view.
 */

import { test, expect } from './fixtures.js';

test.describe('Gallery View', () => {
  test('should load the gallery page with required elements', async ({ page }) => {
    await page.goto('/');

    // Check page title.
    await expect(page).toHaveTitle('inky-soup');

    // Gallery view should be visible with required sections.
    await expect(page.locator('#galleryView')).toBeVisible();
    await expect(page.locator('#dropZone')).toBeVisible();
    await expect(page.locator('#fileInput')).toBeAttached();
  });
});

test.describe('Gallery with Images', () => {
  test('thumbnail click should open detail view', async ({ withImage }) => {
    const page = withImage;

    // Click the first thumbnail.
    const thumbnails = page.locator('.thumbnail-item img');
    await thumbnails.first().click();

    // Detail view should become visible.
    await expect(page.locator('#detailView')).toBeVisible();

    // Gallery view should be hidden.
    await expect(page.locator('#galleryView')).not.toBeVisible();
  });

  test('back button should return to gallery', async ({ withImage }) => {
    const page = withImage;

    // Click thumbnail to open detail view.
    const thumbnails = page.locator('.thumbnail-item img');
    await thumbnails.first().click();
    await expect(page.locator('#detailView')).toBeVisible();

    // Click back button.
    await page.locator('.back-button').click();

    // Should return to gallery.
    await expect(page.locator('#galleryView')).toBeVisible();
    await expect(page.locator('#detailView')).not.toBeVisible();
  });
});
