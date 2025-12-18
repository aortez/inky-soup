/**
 * E2E tests for the image processing pipeline in detail view.
 */

import { test, expect } from '@playwright/test';
import path from 'path';

const testImagePath = path.join(import.meta.dirname, 'fixtures', 'test-image.png');

// Shared helper to navigate to detail view (requires at least one image in gallery).
async function openDetailView(page) {
  await page.goto('/');

  const thumbnails = page.locator('.thumbnail-item img');
  const count = await thumbnails.count();

  if (count === 0) {
    return false;
  }

  await thumbnails.first().click();
  await expect(page.locator('#detailView')).toBeVisible();
  return true;
}

test.describe('Pipeline Detail View', () => {

  test('should display pipeline with all required elements', async ({ page }) => {
    const hasImages = await openDetailView(page);
    if (!hasImages) {
      test.skip();
      return;
    }

    // Check pipeline structure exists with canvases and controls.
    await expect(page.locator('.pipeline')).toBeVisible();
    await expect(page.locator('#filterCanvas')).toBeVisible();
    await expect(page.locator('#ditherCanvas')).toBeVisible();
    await expect(page.locator('#flashBtn')).toBeVisible();
    await expect(page.locator('#saturationSlider')).toBeVisible();

    // All filter buttons should exist with exactly one active.
    const filters = ['bicubic', 'lanczos', 'mitchell', 'bilinear', 'nearest'];
    for (const filter of filters) {
      await expect(page.locator(`.filter-btn[data-filter="${filter}"]`)).toBeVisible();
    }
    await expect(page.locator('.filter-btn.active')).toHaveCount(1);
  });

  test('clicking filter button should change active state', async ({ page }) => {
    const hasImages = await openDetailView(page);
    if (!hasImages) {
      test.skip();
      return;
    }

    // Get current active filter.
    const initialActive = await page.locator('.filter-btn.active').getAttribute('data-filter');

    // Click a different filter.
    const targetFilter = initialActive === 'lanczos' ? 'mitchell' : 'lanczos';
    await page.locator(`.filter-btn[data-filter="${targetFilter}"]`).click();

    // New filter should be active.
    await expect(page.locator(`.filter-btn[data-filter="${targetFilter}"]`)).toHaveClass(/active/);

    // Old filter should not be active.
    await expect(page.locator(`.filter-btn[data-filter="${initialActive}"]`)).not.toHaveClass(/active/);
  });

  test('all settings should persist after Save button', async ({ page }) => {
    await page.goto('/');

    // Upload an image if there are none.
    let thumbnails = page.locator('.thumbnail-item img');
    let count = await thumbnails.count();

    if (count === 0) {
      const fileInput = page.locator('#fileInput');
      await fileInput.setInputFiles(testImagePath);
      await expect(page.locator('#uploadModalTitle')).toHaveText('✓ Upload Complete!', { timeout: 30000 });
      await page.locator('#uploadCloseBtn').click();
      await page.waitForLoadState('networkidle');
      thumbnails = page.locator('.thumbnail-item img');
    }

    // Open detail view.
    await thumbnails.first().click();
    await expect(page.locator('#detailView')).toBeVisible();

    // Get the current filename.
    const filename = await page.locator('#detailFilename').textContent();

    // Wait for initial processing to complete.
    await expect(page.locator('#filterProcessing')).toHaveText('', { timeout: 10000 });
    await expect(page.locator('#ditherProcessing')).toHaveText('', { timeout: 10000 });

    // Get initial values.
    const initialFilter = await page.locator('.filter-btn.active').getAttribute('data-filter');
    const initialDither = await page.locator('.dither-btn.active').getAttribute('data-dither');

    // Change all settings to known values.
    const targetFilter = initialFilter === 'lanczos' ? 'mitchell' : 'lanczos';
    const targetDither = initialDither === 'atkinson' ? 'ordered' : 'atkinson';

    await page.locator(`.filter-btn[data-filter="${targetFilter}"]`).click();
    await expect(page.locator('#filterProcessing')).toHaveText('', { timeout: 10000 });

    await page.locator('#saturationSlider').fill('0.7');
    await page.locator('#brightnessSlider').fill('15');
    await page.locator('#contrastSlider').fill('-10');
    await page.locator(`.dither-btn[data-dither="${targetDither}"]`).click();

    // Wait for dither processing.
    await expect(page.locator('#ditherProcessing')).toHaveText('', { timeout: 10000 });

    // Click Save button.
    await page.locator('.apply-filter-btn').click();
    await expect(page.locator('#filterStatus')).toContainText('saved', { timeout: 10000 });

    // Go back to gallery (without page reload - typical user flow).
    await page.locator('.back-button').click();
    await expect(page.locator('#galleryView')).toBeVisible();

    // Re-open the same image.
    const thumbnail = page.locator(`.thumbnail-item img[data-filename="${filename}"]`);
    await thumbnail.click();
    await expect(page.locator('#detailView')).toBeVisible();

    // Wait for processing to complete.
    await expect(page.locator('#filterProcessing')).toHaveText('', { timeout: 10000 });
    await expect(page.locator('#ditherProcessing')).toHaveText('', { timeout: 10000 });

    // Verify all settings were restored.
    await expect(page.locator(`.filter-btn[data-filter="${targetFilter}"]`)).toHaveClass(/active/);
    await expect(page.locator('#saturationValue')).toHaveText('0.7');
    await expect(page.locator('#brightnessValue')).toHaveText('15');
    await expect(page.locator('#contrastValue')).toHaveText('-10');
    await expect(page.locator(`.dither-btn[data-dither="${targetDither}"]`)).toHaveClass(/active/);
  });

  test('all settings should persist after Flash button', async ({ page }) => {
    await page.goto('/');

    // Upload an image if there are none.
    let thumbnails = page.locator('.thumbnail-item img');
    let count = await thumbnails.count();

    if (count === 0) {
      const fileInput = page.locator('#fileInput');
      await fileInput.setInputFiles(testImagePath);
      await expect(page.locator('#uploadModalTitle')).toHaveText('✓ Upload Complete!', { timeout: 30000 });
      await page.locator('#uploadCloseBtn').click();
      await page.waitForLoadState('networkidle');
      thumbnails = page.locator('.thumbnail-item img');
    }

    // Open detail view.
    await thumbnails.first().click();
    await expect(page.locator('#detailView')).toBeVisible();

    // Get the current filename.
    const filename = await page.locator('#detailFilename').textContent();

    // Wait for initial processing to complete.
    await expect(page.locator('#filterProcessing')).toHaveText('', { timeout: 10000 });
    await expect(page.locator('#ditherProcessing')).toHaveText('', { timeout: 10000 });

    // Get initial values.
    const initialFilter = await page.locator('.filter-btn.active').getAttribute('data-filter');
    const initialDither = await page.locator('.dither-btn.active').getAttribute('data-dither');

    // Change all settings to different known values.
    const targetFilter = initialFilter === 'bilinear' ? 'nearest' : 'bilinear';
    const targetDither = initialDither === 'floyd-steinberg' ? 'ordered' : 'floyd-steinberg';

    await page.locator(`.filter-btn[data-filter="${targetFilter}"]`).click();
    await expect(page.locator('#filterProcessing')).toHaveText('', { timeout: 10000 });

    await page.locator('#saturationSlider').fill('0.9');
    await page.locator('#brightnessSlider').fill('-20');
    await page.locator('#contrastSlider').fill('25');
    await page.locator(`.dither-btn[data-dither="${targetDither}"]`).click();

    // Wait for dither processing.
    await expect(page.locator('#ditherProcessing')).toHaveText('', { timeout: 10000 });

    // Click Flash button.
    const flashBtn = page.locator('#flashBtn');
    await flashBtn.click();

    // Wait for flash to queue.
    await expect(page.locator('#flashStatusBar')).toHaveClass(/visible/, { timeout: 10000 });

    // Go back to gallery (without page reload - typical user flow).
    await page.locator('.back-button').click();
    await expect(page.locator('#galleryView')).toBeVisible();

    // Re-open the same image.
    const thumbnail = page.locator(`.thumbnail-item img[data-filename="${filename}"]`);
    await thumbnail.click();
    await expect(page.locator('#detailView')).toBeVisible();

    // Wait for processing to complete.
    await expect(page.locator('#filterProcessing')).toHaveText('', { timeout: 10000 });
    await expect(page.locator('#ditherProcessing')).toHaveText('', { timeout: 10000 });

    // Verify all settings were restored.
    await expect(page.locator(`.filter-btn[data-filter="${targetFilter}"]`)).toHaveClass(/active/);
    await expect(page.locator('#saturationValue')).toHaveText('0.9');
    await expect(page.locator('#brightnessValue')).toHaveText('-20');
    await expect(page.locator('#contrastValue')).toHaveText('25');
    await expect(page.locator(`.dither-btn[data-dither="${targetDither}"]`)).toHaveClass(/active/);
  });

  test('changing saturation should update dither canvas', async ({ page }) => {
    const hasImages = await openDetailView(page);
    if (!hasImages) {
      test.skip();
      return;
    }

    // Wait for initial dithering to complete.
    await expect(page.locator('#ditherProcessing')).toHaveText('', { timeout: 10000 });

    // Get initial dither canvas data.
    const getCanvasData = async () => {
      return await page.evaluate(() => {
        const canvas = document.getElementById('ditherCanvas');
        return canvas.toDataURL();
      });
    };

    const initialData = await getCanvasData();

    // Change saturation significantly (0.5 -> 1.0).
    const slider = page.locator('#saturationSlider');
    await slider.fill('1.0');

    // Value display should update.
    await expect(page.locator('#saturationValue')).toHaveText('1.0');

    // Wait for re-dithering to complete.
    await expect(page.locator('#ditherProcessing')).toHaveText('', { timeout: 10000 });

    // Dither canvas should have changed.
    const newData = await getCanvasData();
    expect(newData).not.toBe(initialData);
  });

  test('clicking flash button should submit flash job successfully', async ({ page }) => {
    await page.goto('/');

    // Upload an image if there are none.
    let thumbnails = page.locator('.thumbnail-item img');
    let count = await thumbnails.count();

    if (count === 0) {
      // Upload test image first.
      const fileInput = page.locator('#fileInput');
      await fileInput.setInputFiles(testImagePath);

      // Wait for upload to complete.
      await expect(page.locator('#uploadModalTitle')).toHaveText('✓ Upload Complete!', { timeout: 30000 });
      await page.locator('#uploadCloseBtn').click();
      await page.waitForLoadState('networkidle');

      // Refresh thumbnails reference.
      thumbnails = page.locator('.thumbnail-item img');
      count = await thumbnails.count();
    }

    // Open detail view.
    await thumbnails.first().click();
    await expect(page.locator('#detailView')).toBeVisible();

    // Wait for dithering to complete before flashing.
    await expect(page.locator('#ditherProcessing')).toHaveText('', { timeout: 10000 });

    // Capture any alerts (which indicate errors).
    const alerts = [];
    page.on('dialog', async (dialog) => {
      alerts.push(dialog.message());
      await dialog.dismiss();
    });

    // Track API requests to detect duplicate submissions.
    const apiRequests = [];
    page.on('request', request => {
      const url = request.url();
      if (url.includes('/api/upload-dithered') || url.includes('/flash')) {
        apiRequests.push({ url, timestamp: Date.now() });
      }
    });

    // Click the flash button.
    const flashBtn = page.locator('#flashBtn');
    await flashBtn.click();

    // Wait for the flash status bar to become visible (indicates success).
    await expect(page.locator('#flashStatusBar')).toHaveClass(/visible/, { timeout: 10000 });

    // Status text should show "Queued" with the filename.
    await expect(page.locator('#statusText')).toContainText('Queued:', { timeout: 5000 });

    // No alerts should have been shown.
    expect(alerts).toEqual([]);

    // Should have exactly 1 upload-dithered and 1 flash request (no duplicates).
    const uploadDitheredRequests = apiRequests.filter(r => r.url.includes('/api/upload-dithered'));
    const flashRequests = apiRequests.filter(r => r.url.includes('/flash') && !r.url.includes('/status'));
    expect(uploadDitheredRequests.length).toBe(1);
    expect(flashRequests.length).toBe(1);
  });

  test('delete button should actually delete the image', async ({ page }) => {
    await page.goto('/');

    // Upload an image if there are none (we need something to delete).
    let thumbnails = page.locator('.thumbnail-item img');
    let count = await thumbnails.count();

    if (count === 0) {
      const fileInput = page.locator('#fileInput');
      await fileInput.setInputFiles(testImagePath);
      await expect(page.locator('#uploadModalTitle')).toHaveText('✓ Upload Complete!', { timeout: 30000 });
      await page.locator('#uploadCloseBtn').click();
      await page.waitForLoadState('networkidle');
    }

    // Get initial count and open detail view.
    thumbnails = page.locator('.thumbnail-item');
    const initialCount = await thumbnails.count();
    expect(initialCount).toBeGreaterThan(0);

    // Open detail view.
    await page.locator('.thumbnail-item img').first().click();
    await expect(page.locator('#detailView')).toBeVisible();

    // Get the filename being deleted.
    const filename = await page.locator('#detailFilename').textContent();

    // Click delete button.
    await page.locator('.delete-button').click();

    // Confirmation modal should appear.
    await expect(page.locator('#deleteConfirmModal')).toHaveClass(/active/);
    await expect(page.locator('#deleteConfirmModal h2')).toHaveText('Delete Image?');

    // Confirm deletion.
    await page.locator('#deleteConfirmModal .delete-btn').click();

    // Should redirect to gallery.
    await page.waitForURL('/');
    await expect(page.locator('#galleryView')).toBeVisible();

    // Image should be gone from gallery.
    const newCount = await page.locator('.thumbnail-item').count();
    expect(newCount).toBe(initialCount - 1);

    // The deleted filename should not appear in any thumbnail.
    const remainingFilenames = await page.locator('.thumbnail-item').evaluateAll(
      (items) => items.map((item) => item.getAttribute('data-filename'))
    );
    expect(remainingFilenames).not.toContain(filename);
  });

  test('delete cancel should not delete the image', async ({ page }) => {
    const hasImages = await openDetailView(page);
    if (!hasImages) {
      test.skip();
      return;
    }

    // Get the filename.
    const filename = await page.locator('#detailFilename').textContent();

    // Click delete button.
    await page.locator('.delete-button').click();
    await expect(page.locator('#deleteConfirmModal')).toHaveClass(/active/);

    // Cancel deletion.
    await page.locator('.cancel-btn').click();
    await expect(page.locator('#deleteConfirmModal')).not.toHaveClass(/active/);

    // Go back to gallery.
    await page.locator('.back-button').click();
    await expect(page.locator('#galleryView')).toBeVisible();

    // Image should still be in gallery.
    const thumbnailFilenames = await page.locator('.thumbnail-item').evaluateAll(
      (items) => items.map((item) => item.getAttribute('data-filename'))
    );
    expect(thumbnailFilenames).toContain(filename);
  });

});

test.describe('Pipeline Processing', () => {
  test('filter change should update canvas without errors', async ({ page }) => {
    const hasImages = await openDetailView(page);
    if (!hasImages) {
      test.skip();
      return;
    }

    // Monitor for errors.
    const consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    const pageErrors = [];
    page.on('pageerror', (error) => {
      pageErrors.push(error.message);
    });

    // Get initial canvas data URL.
    const getCanvasData = async () => page.evaluate(() => {
      const canvas = document.getElementById('filterCanvas');
      return canvas.toDataURL();
    });

    // Wait for initial processing to complete.
    await expect(page.locator('#filterProcessing')).toHaveText('', { timeout: 10000 });
    await expect(page.locator('#ditherProcessing')).toHaveText('', { timeout: 10000 });

    const initialData = await getCanvasData();

    // Get current active filter.
    const initialActive = await page.locator('.filter-btn.active').getAttribute('data-filter');

    // Choose a very different filter (nearest vs lanczos should produce visible differences).
    const targetFilter = initialActive === 'nearest' ? 'lanczos' : 'nearest';

    // Click the new filter.
    await page.locator(`.filter-btn[data-filter="${targetFilter}"]`).click();

    // Wait for processing to complete.
    await expect(page.locator('#filterProcessing')).toHaveText('', { timeout: 10000 });
    await expect(page.locator('#ditherProcessing')).toHaveText('', { timeout: 10000 });

    // Get new canvas data.
    const newData = await getCanvasData();

    // Canvas content should have changed.
    expect(newData).not.toBe(initialData);

    // Verify no errors occurred.
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test('should handle multiple rapid filter changes', async ({ page }) => {
    const hasImages = await openDetailView(page);
    if (!hasImages) {
      test.skip();
      return;
    }

    // Monitor for errors.
    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    const pageErrors = [];
    page.on('pageerror', error => {
      pageErrors.push(error.message);
    });

    // Rapidly click through several filters.
    const filters = ['bicubic', 'lanczos', 'mitchell', 'bilinear'];
    for (const filter of filters) {
      await page.locator(`.filter-btn[data-filter="${filter}"]`).click();
      // Small delay to allow worker to receive message.
      await page.waitForTimeout(100);
    }

    // Wait for final processing to complete.
    await expect(page.locator('#filterProcessing')).toHaveText('', { timeout: 10000 });
    await expect(page.locator('#ditherProcessing')).toHaveText('', { timeout: 10000 });

    // Verify no errors occurred.
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});

test.describe('Cache Optimization', () => {
  test('should load from server cache when available', async ({ page }) => {
    const hasImages = await openDetailView(page);
    if (!hasImages) {
      test.skip();
      return;
    }

    // Track network requests to see if cache or original is loaded.
    const networkRequests = [];
    page.on('request', request => {
      const url = request.url();
      if (url.includes('/images/')) {
        networkRequests.push(url);
      }
    });

    // Get the current filename.
    const filename = await page.locator('#detailFilename').textContent();

    // Go back to gallery.
    await page.locator('.back-button').click();
    await expect(page.locator('#galleryView')).toBeVisible();

    // Clear network requests.
    networkRequests.length = 0;

    // Re-open the same image.
    const thumbnail = page.locator(`.thumbnail-item img[data-filename="${filename}"]`);
    await thumbnail.click();
    await expect(page.locator('#detailView')).toBeVisible();

    // Wait for processing to complete.
    await expect(page.locator('#filterProcessing')).toHaveText('', { timeout: 10000 });
    await expect(page.locator('#ditherProcessing')).toHaveText('', { timeout: 10000 });

    // Should have loaded from cache (cache URL contains "/cache/").
    const cacheRequests = networkRequests.filter(url => url.includes('/images/cache/'));
    expect(cacheRequests.length).toBeGreaterThan(0);
  });
});
