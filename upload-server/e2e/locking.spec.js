/**
 * E2E tests for image locking system.
 * Verifies multi-user edit protection.
 */

import { test, expect } from './fixtures.js';
import path from 'path';
import fs from 'fs';

const testImagePath = path.join(import.meta.dirname, 'fixtures', 'test-image.png');

/**
 * Helper to click a specific thumbnail and wait for detail view.
 * Does not verify lock state (allows read-only mode).
 */
async function clickThumbnail(page, filename) {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  const thumb = page.locator(`.thumbnail-item img[data-filename="${filename}"]`);
  await expect(thumb).toBeVisible();
  await thumb.click();
  await expect(page.locator('#detailView')).toBeVisible();

  // Wait for processing to complete.
  await expect(page.locator('#filterProcessing')).toHaveText('', { timeout: 10000 });
  await expect(page.locator('#ditherProcessing')).toHaveText('', { timeout: 10000 });
}

test.describe('Image Locking', () => {
  test('should enforce exclusive edit access between users', async ({ browser }) => {
    // Create two browser contexts to simulate two users.
    const userA = await browser.newContext();
    const userB = await browser.newContext();

    const pageA = await userA.newPage();
    const pageB = await userB.newPage();

    try {
      // Upload an image with unique filename as setup.
      await pageA.goto('/');

      const uniqueFilename = `test_locking_exclusive_${Date.now()}.png`;
      const buffer = fs.readFileSync(testImagePath);

      const fileChooserPromise = pageA.waitForEvent('filechooser');
      await pageA.locator('#dropZone').click();
      const fileChooser = await fileChooserPromise;
      await fileChooser.setFiles({
        name: uniqueFilename,
        mimeType: 'image/jpeg',
        buffer,
      });

      await expect(pageA.locator('#uploadModalTitle')).toHaveText('✓ Upload Complete!', { timeout: 30000 });
      await pageA.locator('#uploadCloseBtn').click();
      await pageA.waitForLoadState('networkidle');

      // User A enters detail view for the specific image → should acquire lock.
      await clickThumbnail(pageA, uniqueFilename);

      const lockStatusA = pageA.locator('#lockStatus');

      // User A should see editing lock status.
      await expect(lockStatusA).toContainText('Editing');
      await expect(lockStatusA).toContainText('lock expires in');

      // User A's Save and Flash buttons should be enabled.
      const saveBtnA = pageA.locator('.apply-filter-btn');
      const flashBtnA = pageA.locator('#flashBtn');
      await expect(saveBtnA).toBeEnabled();
      await expect(flashBtnA).toBeEnabled();

      // User B tries to enter detail view for SAME image → should get read-only mode.
      await clickThumbnail(pageB, uniqueFilename);

      // User B should see read-only status.
      const lockStatusB = pageB.locator('#lockStatus');
      await expect(lockStatusB).toBeVisible();
      await expect(lockStatusB).toContainText('Read-only');
      await expect(lockStatusB).toContainText('Being edited');

      // User B's Save and Flash buttons should be disabled.
      const saveBtnB = pageB.locator('.apply-filter-btn');
      const flashBtnB = pageB.locator('#flashBtn');
      await expect(saveBtnB).toBeDisabled();
      await expect(flashBtnB).toBeDisabled();

      // User A exits → releases lock.
      await pageA.locator('.back-button').click();
      await expect(pageA.locator('#galleryView')).toBeVisible();

      // Small delay for unlock to propagate.
      await pageB.waitForTimeout(1000);

      // User B goes back and re-enters → should now acquire lock.
      await pageB.locator('.back-button').click();
      await expect(pageB.locator('#galleryView')).toBeVisible();
      await clickThumbnail(pageB, uniqueFilename);

      // User B should now see editing status.
      await expect(lockStatusB).toBeVisible();
      await expect(lockStatusB).toContainText('Editing');

      // User B's buttons should be enabled.
      await expect(saveBtnB).toBeEnabled();
      await expect(flashBtnB).toBeEnabled();

      // User A tries to re-enter → should get read-only mode.
      await clickThumbnail(pageA, uniqueFilename);

      // User A should see read-only status.
      await expect(lockStatusA).toBeVisible();
      await expect(lockStatusA).toContainText('Read-only');

      // User A's buttons should be disabled.
      await expect(saveBtnA).toBeDisabled();
      await expect(flashBtnA).toBeDisabled();

      // User B changes settings and saves.
      await pageB.locator('.filter-btn[data-filter="lanczos"]').click();
      await expect(pageB.locator('#filterProcessing')).toHaveText('', { timeout: 10000 });
      await saveBtnB.click();
      await expect(pageB.locator('#filterStatus')).toContainText('saved', { timeout: 10000 });

      // User B exits → releases lock.
      await pageB.locator('.back-button').click();
      await expect(pageB.locator('#galleryView')).toBeVisible();

      // Small delay for unlock.
      await pageA.waitForTimeout(1000);

      // User A goes back and re-enters → should now acquire lock.
      await pageA.locator('.back-button').click();
      await expect(pageA.locator('#galleryView')).toBeVisible();
      await clickThumbnail(pageA, uniqueFilename);

      // User A should now see editing status.
      await expect(lockStatusA).toBeVisible();
      await expect(lockStatusA).toContainText('Editing');

      // User A's buttons should be enabled.
      await expect(saveBtnA).toBeEnabled();
      await expect(flashBtnA).toBeEnabled();

      // User A exits.
      await pageA.locator('.back-button').click();
      await expect(pageA.locator('#galleryView')).toBeVisible();
    } finally {
      // Cleanup.
      await pageA.close();
      await pageB.close();
      await userA.close();
      await userB.close();
    }
  });

  test('should auto-expire locks after timeout', async ({ page }) => {
    // Upload an image with unique filename.
    await page.goto('/');

    const uniqueFilename = `test_locking_expiry_${Date.now()}.png`;
    const buffer = fs.readFileSync(testImagePath);

    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.locator('#dropZone').click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles({
      name: uniqueFilename,
      mimeType: 'image/jpeg',
      buffer,
    });

    await expect(page.locator('#uploadModalTitle')).toHaveText('✓ Upload Complete!', { timeout: 30000 });
    await page.locator('#uploadCloseBtn').click();
    await page.waitForLoadState('networkidle');

    // Acquire lock.
    await clickThumbnail(page, uniqueFilename);
    await expect(page.locator('#lockStatus')).toContainText('Editing');

    // Simulate lock expiry by stopping keepalive and waiting for expiration.
    // (Server configured with LOCK_DURATION_SECS=3 for fast tests).
    await page.evaluate(() => {
      // Stop keepalive interval to let lock expire.
      const intervalId = window._lockKeepaliveInterval;
      if (intervalId) clearInterval(intervalId);
    });

    // Go back to gallery.
    await page.locator('.back-button').click();
    await expect(page.locator('#galleryView')).toBeVisible();

    // Wait for lock to expire (3 seconds + buffer for test environment).
    await page.waitForTimeout(4000);

    // Another "user" (same browser, new navigation) should be able to acquire lock.
    await clickThumbnail(page, uniqueFilename);

    // Should show editing status (lock was acquired).
    await expect(page.locator('#lockStatus')).toContainText('Editing');
  });
});
