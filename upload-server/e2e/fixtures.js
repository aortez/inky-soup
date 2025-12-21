/**
 * Playwright fixtures for inky-soup e2e tests.
 *
 * Provides a `withImage` fixture that ensures at least one image exists
 * in the gallery before running tests that need it.
 */

import { test as base, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';

const testImagePath = path.join(import.meta.dirname, 'fixtures', 'test-image.png');

/**
 * Extended test with custom fixtures.
 */
export const test = base.extend({
  /**
   * Fixture that ensures at least one image exists in the gallery.
   * Uploads a unique image per test to avoid parallel test interference.
   * Use this for tests that require an image to be present.
   */
  withImage: async ({ page }, use, testInfo) => {
    // Navigate to gallery.
    await page.goto('/');

    // Generate unique filename based on test path to prevent lock conflicts.
    const testPath = testInfo.titlePath.join('-').replace(/[^a-z0-9-]/gi, '_');
    const uniqueFilename = `test_${testPath}_${Date.now()}.png`;

    // Read test image into buffer.
    const buffer = fs.readFileSync(testImagePath);

    // Trigger file chooser and upload with unique filename.
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.locator('#dropZone').click();
    const fileChooser = await fileChooserPromise;

    await fileChooser.setFiles({
      name: uniqueFilename,
      mimeType: 'image/jpeg',
      buffer,
    });

    // Wait for upload to complete.
    await expect(page.locator('#uploadModalTitle')).toHaveText('✓ Upload Complete!', { timeout: 30000 });

    // Close the modal.
    await page.locator('#uploadCloseBtn').click();

    // Wait for THIS test's thumbnail to appear.
    await page.waitForLoadState('networkidle');
    const myThumbnail = page.locator(`.thumbnail-item img[data-filename="${uniqueFilename}"]`);
    await expect(myThumbnail).toBeVisible({ timeout: 10000 });

    // Store the unique filename in page context so openDetailView can find it.
    await page.evaluate((filename) => {
      window._testFilename = filename;
    }, uniqueFilename);

    // Provide the page to the test.
    await use(page);
  },
});

export { expect };

/**
 * Helper to open detail view for the test's specific image.
 * Returns the page with detail view open and initial processing complete.
 */
export async function openDetailView(page) {
  // Get the test's unique filename from window context (set by withImage fixture).
  const testFilename = await page.evaluate(() => window._testFilename);

  // Ensure we're on gallery view (but don't reload if already there).
  const currentUrl = page.url();
  if (!currentUrl.includes('#') || currentUrl.includes('#detail')) {
    await page.goto('/');
  }

  if (testFilename) {
    // Click THIS test's specific thumbnail.
    const myThumbnail = page.locator(`.thumbnail-item img[data-filename="${testFilename}"]`);
    await expect(myThumbnail).toBeVisible({ timeout: 5000 });
    await myThumbnail.click();
  } else {
    // Fallback to first thumbnail if no test filename set.
    const thumbnails = page.locator('.thumbnail-item img');
    await expect(thumbnails.first()).toBeVisible({ timeout: 5000 });
    await thumbnails.first().click();
  }

  await expect(page.locator('#detailView')).toBeVisible();

  // Wait for lock acquisition to complete and verify we have edit access.
  const lockStatus = page.locator('#lockStatus');
  await expect(lockStatus).toBeVisible({ timeout: 3000 });

  // Verify we're in editing mode (not read-only).
  const lockText = await lockStatus.textContent();
  if (lockText.includes('Read-only')) {
    throw new Error(`Failed to acquire lock: ${lockText}`);
  }

  // Wait for initial image processing to complete before tests start.
  await expect(page.locator('#filterProcessing')).toHaveText('', { timeout: 10000 });
  await expect(page.locator('#ditherProcessing')).toHaveText('', { timeout: 10000 });

  return page;
}
