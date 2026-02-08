/**
 * E2E tests for the image processing pipeline in detail view.
 */

import { test, expect, openDetailView } from './fixtures.js';
import path from 'path';

const testImagePath = path.join(import.meta.dirname, 'fixtures', 'test-image.png');

test.describe('Pipeline Detail View', () => {
  test('should display pipeline with all required elements', async ({ withImage }) => {
    const page = withImage;
    await openDetailView(page);

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

  test('clicking filter button should change active state', async ({ withImage }) => {
    const page = withImage;
    await openDetailView(page);

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
    await expect(page.locator('#filterProcessing')).toHaveText('', { timeout: 1000 });
    await expect(page.locator('#ditherProcessing')).toHaveText('', { timeout: 1000 });

    // Get initial values.
    const initialFilter = await page.locator('.filter-btn.active').getAttribute('data-filter');
    const initialDither = await page.locator('.dither-btn.active').getAttribute('data-dither');

    // Change all settings to known values.
    const targetFilter = initialFilter === 'lanczos' ? 'mitchell' : 'lanczos';
    const targetDither = initialDither === 'atkinson' ? 'ordered' : 'atkinson';

    await page.locator(`.filter-btn[data-filter="${targetFilter}"]`).click();
    await expect(page.locator('#filterProcessing')).toHaveText('', { timeout: 1000 });

    await page.locator('#saturationSlider').fill('0.7');
    await page.locator('#brightnessSlider').fill('15');
    await page.locator('#contrastSlider').fill('-10');
    await page.locator(`.dither-btn[data-dither="${targetDither}"]`).click();

    // Wait for dither processing.
    await expect(page.locator('#ditherProcessing')).toHaveText('', { timeout: 1000 });

    // Click Save button.
    await page.locator('.apply-filter-btn').click();
    await expect(page.locator('#filterStatus')).toContainText('saved', { timeout: 1000 });

    // Go back to gallery (without page reload - typical user flow).
    await page.locator('#detailView .back-button').click();
    await expect(page.locator('#galleryView')).toBeVisible();

    // Re-open the same image.
    const thumbnail = page.locator(`.thumbnail-item img[data-filename="${filename}"]`);
    await thumbnail.click();
    await expect(page.locator('#detailView')).toBeVisible();

    // Wait for processing to complete.
    await expect(page.locator('#filterProcessing')).toHaveText('', { timeout: 1000 });
    await expect(page.locator('#ditherProcessing')).toHaveText('', { timeout: 1000 });

    // Verify all settings were restored.
    await expect(page.locator(`.filter-btn[data-filter="${targetFilter}"]`)).toHaveClass(/active/);
    await expect(page.locator('#saturationValue')).toHaveText('0.7');
    await expect(page.locator('#brightnessValue')).toHaveText('15');
    await expect(page.locator('#contrastValue')).toHaveText('-10');
    await expect(page.locator(`.dither-btn[data-dither="${targetDither}"]`)).toHaveClass(/active/);
  });

  test('all settings should persist after Flash button', async ({ withImage }) => {
    const page = withImage;
    await openDetailView(page);

    // Get the current filename.
    const filename = await page.locator('#detailFilename').textContent();

    // Get initial values.
    const initialFilter = await page.locator('.filter-btn.active').getAttribute('data-filter');
    const initialDither = await page.locator('.dither-btn.active').getAttribute('data-dither');

    // Change all settings to different known values.
    const targetFilter = initialFilter === 'bilinear' ? 'nearest' : 'bilinear';
    const targetDither = initialDither === 'floyd-steinberg' ? 'ordered' : 'floyd-steinberg';

    await page.locator(`.filter-btn[data-filter="${targetFilter}"]`).click();
    await expect(page.locator('#filterProcessing')).toHaveText('', { timeout: 1000 });

    await page.locator('#saturationSlider').fill('0.9');
    await page.locator('#brightnessSlider').fill('-20');
    await page.locator('#contrastSlider').fill('25');
    await page.locator(`.dither-btn[data-dither="${targetDither}"]`).click();

    // Wait for dither processing.
    await expect(page.locator('#ditherProcessing')).toHaveText('', { timeout: 1000 });

    // Click Flash button.
    const flashBtn = page.locator('#flashBtn');
    await flashBtn.click();

    // Wait for flash to queue.
    await expect(page.locator('#flashStatusBar')).toHaveClass(/visible/, { timeout: 1000 });

    // Go back to gallery (without page reload - typical user flow).
    await page.locator('#detailView .back-button').click();
    await expect(page.locator('#galleryView')).toBeVisible();

    // Re-open the same image.
    const thumbnail = page.locator(`.thumbnail-item img[data-filename="${filename}"]`);
    await thumbnail.click();
    await expect(page.locator('#detailView')).toBeVisible();

    // Wait for processing to complete.
    await expect(page.locator('#filterProcessing')).toHaveText('', { timeout: 1000 });
    await expect(page.locator('#ditherProcessing')).toHaveText('', { timeout: 1000 });

    // Verify all settings were restored.
    await expect(page.locator(`.filter-btn[data-filter="${targetFilter}"]`)).toHaveClass(/active/);
    await expect(page.locator('#saturationValue')).toHaveText('0.9');
    await expect(page.locator('#brightnessValue')).toHaveText('-20');
    await expect(page.locator('#contrastValue')).toHaveText('25');
    await expect(page.locator(`.dither-btn[data-dither="${targetDither}"]`)).toHaveClass(/active/);
  });

  test('changing saturation should update dither canvas', async ({ withImage }) => {
    const page = withImage;
    await openDetailView(page);

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
    await slider.evaluate((el) => {
      el.value = '1.0';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // Value display should update (formatted as "1" not "1.0").
    await expect(page.locator('#saturationValue')).toHaveText('1');

    // Wait for re-dithering to complete.
    await expect(page.locator('#ditherProcessing')).toHaveText('', { timeout: 1000 });

    // Dither canvas should have changed.
    const newData = await getCanvasData();
    expect(newData).not.toBe(initialData);
  });

  test('clicking flash button should submit flash job successfully', async ({ withImage }) => {
    const page = withImage;
    await openDetailView(page);

    // Capture console logs for debugging.
    const consoleLogs = [];
    page.on('console', (msg) => {
      consoleLogs.push(`${msg.type()}: ${msg.text()}`);
    });

    // Capture any alerts (which indicate errors).
    const alerts = [];
    page.on('dialog', async (dialog) => {
      alerts.push(dialog.message());
      await dialog.dismiss();
    });

    // Track API calls to detect duplicate submissions.
    // Patch `fetch` in-page so we can reliably attribute requests to THIS filename even in parallel E2E runs.
    const filename = ((await page.locator('#detailFilename').textContent()) || '').trim();
    await page.evaluate((targetFilename) => {
      const originalFetch = window.fetch.bind(window);
      window.__flashRequestCounts = { uploadDithered: 0, flash: 0 };

      window.fetch = async (input, init = {}) => {
        try {
          const url = typeof input === 'string' ? input : input.url;
          const body = init?.body;

          if (url.includes('/api/upload-dithered') && body instanceof FormData) {
            if (body.get('filename') === targetFilename) {
              window.__flashRequestCounts.uploadDithered += 1;
            }
          }

          if (url.endsWith('/flash') && body instanceof FormData) {
            if (body.get('submission.filename') === targetFilename) {
              window.__flashRequestCounts.flash += 1;
            }
          }
        } catch {
          // Ignore fetch instrumentation errors and let the request proceed.
        }

        return originalFetch(input, init);
      };
    }, filename);

    // Verify session ID exists before clicking flash.
    const sessionId = await page.evaluate(() => {
      // Access internal state to verify session ID.
      return window.getCurrentSessionId ? window.getCurrentSessionId() : 'NOT_EXPORTED';
    });
    console.log('Session ID before flash:', sessionId);

    // Click the flash button.
    const flashBtn = page.locator('#flashBtn');
    await flashBtn.click();

    // Wait for the flash status bar to become visible (indicates success).
    try {
      await expect(page.locator('#flashStatusBar')).toHaveClass(/visible/, { timeout: 1000 });
    } catch (err) {
      // Log debug info on failure.
      console.log('Alerts captured:', alerts);
      console.log('Console logs:', consoleLogs);
      const counts = await page.evaluate(() => window.__flashRequestCounts);
      console.log('API counts:', counts);
      throw err;
    }

    // Status text should show "Queued" with the filename.
    await expect(page.locator('#statusText')).toContainText('Queued:', { timeout: 5000 });

    // No alerts should have been shown.
    expect(alerts).toEqual([]);

    // Should have exactly 1 upload-dithered and 1 flash request (no duplicates).
    const counts = await page.evaluate(() => window.__flashRequestCounts);
    expect(counts).toEqual({ uploadDithered: 1, flash: 1 });
  });

  test('delete button should actually delete the image', async ({ withImage }) => {
    const page = withImage;
    await openDetailView(page);

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

    // The deleted filename should not appear in gallery.
    const remainingFilenames = await page.locator('.thumbnail-item img').evaluateAll(
      (items) => items.map((item) => item.getAttribute('data-filename'))
    );
    expect(remainingFilenames).not.toContain(filename);
  });

  test('delete cancel should not delete the image', async ({ withImage }) => {
    const page = withImage;
    await openDetailView(page);

    // Get the filename.
    const filename = await page.locator('#detailFilename').textContent();

    // Click delete button.
    await page.locator('.delete-button').click();
    await expect(page.locator('#deleteConfirmModal')).toHaveClass(/active/);

    // Cancel deletion.
    await page.locator('.cancel-btn').click();
    await expect(page.locator('#deleteConfirmModal')).not.toHaveClass(/active/);

    // Go back to gallery.
    await page.locator('#detailView .back-button').click();
    await expect(page.locator('#galleryView')).toBeVisible();

    // Image should still be in gallery.
    const thumbnailFilenames = await page.locator('.thumbnail-item img').evaluateAll(
      (items) => items.map((item) => item.getAttribute('data-filename'))
    );
    expect(thumbnailFilenames).toContain(filename);
  });

});

test.describe('Pipeline Processing', () => {
  test('filter change should update canvas without errors', async ({ withImage }) => {
    const page = withImage;
    await openDetailView(page);

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

    // Get initial canvas data.
    const getCanvasData = async () => page.evaluate(() => {
      const canvas = document.getElementById('filterCanvas');
      return canvas.toDataURL();
    });

    const initialData = await getCanvasData();

    // Get current active filter.
    const initialActive = await page.locator('.filter-btn.active').getAttribute('data-filter');

    // Choose a very different filter (nearest vs lanczos should produce visible differences).
    const targetFilter = initialActive === 'nearest' ? 'lanczos' : 'nearest';

    // Click the new filter.
    await page.locator(`.filter-btn[data-filter="${targetFilter}"]`).click();

    // Wait for processing to complete.
    await expect(page.locator('#filterProcessing')).toHaveText('', { timeout: 1000 });
    await expect(page.locator('#ditherProcessing')).toHaveText('', { timeout: 1000 });

    // Small delay to ensure canvas painting completes.
    await page.waitForTimeout(200);

    // Get new canvas data.
    const newData = await getCanvasData();

    // Canvas content should have changed.
    expect(newData).not.toBe(initialData);

    // Verify no errors occurred.
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test('should handle multiple rapid filter changes', async ({ withImage }) => {
    const page = withImage;
    await openDetailView(page);

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
    await expect(page.locator('#filterProcessing')).toHaveText('', { timeout: 1000 });
    await expect(page.locator('#ditherProcessing')).toHaveText('', { timeout: 1000 });

    // Verify no errors occurred.
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});

test.describe('Cache Optimization', () => {
  test('should load from server cache when available', async ({ withImage }) => {
    const page = withImage;

    // Track network requests to see if cache or original is loaded.
    const networkRequests = [];
    page.on('request', request => {
      const url = request.url();
      if (url.includes('/images/')) {
        networkRequests.push(url);
      }
    });

    await openDetailView(page);

    // Get the current filename.
    const filename = await page.locator('#detailFilename').textContent();

    // Go back to gallery.
    await page.locator('#detailView .back-button').click();
    await expect(page.locator('#galleryView')).toBeVisible();

    // Clear network requests.
    networkRequests.length = 0;

    // Hard reload to bypass browser cache and force server request.
    await page.reload({ waitUntil: 'networkidle' });

    // Re-open the same image.
    const thumbnail = page.locator(`.thumbnail-item img[data-filename="${filename}"]`);
    await thumbnail.click();
    await expect(page.locator('#detailView')).toBeVisible();

    // Wait for processing to complete.
    await expect(page.locator('#filterProcessing')).toHaveText('', { timeout: 1000 });
    await expect(page.locator('#ditherProcessing')).toHaveText('', { timeout: 1000 });

    // Should have loaded from cache (cache URL contains "/cache/").
    const cacheRequests = networkRequests.filter(url => url.includes('/images/cache/'));
    expect(cacheRequests.length).toBeGreaterThan(0);
  });
});
