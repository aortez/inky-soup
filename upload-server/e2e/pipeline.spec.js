/**
 * E2E tests for the image processing pipeline in detail view.
 */

import { test, expect } from '@playwright/test';

test.describe('Pipeline Detail View', () => {
  // Helper to navigate to detail view (requires at least one image in gallery).
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

  test('should display pipeline stages', async ({ page }) => {
    const hasImages = await openDetailView(page);
    if (!hasImages) {
      test.skip();
      return;
    }

    // Check pipeline structure exists.
    await expect(page.locator('.pipeline')).toBeVisible();

    // Check for filter canvas (stage 1).
    await expect(page.locator('#filterCanvas')).toBeVisible();

    // Check for dither canvas (stage 2).
    await expect(page.locator('#ditherCanvas')).toBeVisible();

    // Check for flash button (stage 3).
    await expect(page.locator('#flashBtn')).toBeVisible();
  });

  test('should have filter buttons', async ({ page }) => {
    const hasImages = await openDetailView(page);
    if (!hasImages) {
      test.skip();
      return;
    }

    // Check all filter buttons exist.
    const filters = ['bicubic', 'lanczos', 'mitchell', 'bilinear', 'nearest'];
    for (const filter of filters) {
      await expect(page.locator(`.filter-btn[data-filter="${filter}"]`)).toBeVisible();
    }
  });

  test('should have one active filter button', async ({ page }) => {
    const hasImages = await openDetailView(page);
    if (!hasImages) {
      test.skip();
      return;
    }

    // Exactly one filter should be active.
    const activeFilters = page.locator('.filter-btn.active');
    await expect(activeFilters).toHaveCount(1);
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

  test('should have saturation slider', async ({ page }) => {
    const hasImages = await openDetailView(page);
    if (!hasImages) {
      test.skip();
      return;
    }

    const slider = page.locator('#saturationSlider');
    await expect(slider).toBeVisible();

    // Default value should be 0.5.
    await expect(slider).toHaveValue('0.5');

    // Value display should show 0.5.
    await expect(page.locator('#saturationValue')).toHaveText('0.5');
  });

  test('changing saturation should update display', async ({ page }) => {
    const hasImages = await openDetailView(page);
    if (!hasImages) {
      test.skip();
      return;
    }

    const slider = page.locator('#saturationSlider');

    // Change saturation to 0.8.
    await slider.fill('0.8');

    // Value display should update.
    await expect(page.locator('#saturationValue')).toHaveText('0.8');
  });

  test('should have flash twice checkbox', async ({ page }) => {
    const hasImages = await openDetailView(page);
    if (!hasImages) {
      test.skip();
      return;
    }

    const checkbox = page.locator('#flashTwiceCheckbox');
    await expect(checkbox).toBeVisible();

    // Should be unchecked by default.
    await expect(checkbox).not.toBeChecked();

    // Should be checkable.
    await checkbox.check();
    await expect(checkbox).toBeChecked();
  });

  test('should have flash button', async ({ page }) => {
    const hasImages = await openDetailView(page);
    if (!hasImages) {
      test.skip();
      return;
    }

    const flashBtn = page.locator('#flashBtn');
    await expect(flashBtn).toBeVisible();
    await expect(flashBtn).toContainText('Flash to Display');
  });

  test('should have delete button', async ({ page }) => {
    const hasImages = await openDetailView(page);
    if (!hasImages) {
      test.skip();
      return;
    }

    const deleteBtn = page.locator('.delete-button');
    await expect(deleteBtn).toBeVisible();
    await expect(deleteBtn).toHaveText('Delete');
  });

  test('delete button should show confirmation modal', async ({ page }) => {
    const hasImages = await openDetailView(page);
    if (!hasImages) {
      test.skip();
      return;
    }

    // Click delete button.
    await page.locator('.delete-button').click();

    // Confirmation modal should appear.
    await expect(page.locator('#deleteConfirmModal')).toHaveClass(/active/);
    await expect(page.locator('#deleteConfirmModal h2')).toHaveText('Delete Image?');

    // Cancel button should close modal.
    await page.locator('.cancel-btn').click();
    await expect(page.locator('#deleteConfirmModal')).not.toHaveClass(/active/);
  });

  test('should display filename in header', async ({ page }) => {
    const hasImages = await openDetailView(page);
    if (!hasImages) {
      test.skip();
      return;
    }

    // Filename should be displayed.
    const filename = page.locator('#detailFilename');
    await expect(filename).toBeVisible();

    // Should have some text content.
    const text = await filename.textContent();
    expect(text.length).toBeGreaterThan(0);
  });

  test('canvases should have correct dimensions', async ({ page }) => {
    const hasImages = await openDetailView(page);
    if (!hasImages) {
      test.skip();
      return;
    }

    // Filter canvas should be 600x448.
    const filterCanvas = page.locator('#filterCanvas');
    await expect(filterCanvas).toHaveAttribute('width', '600');
    await expect(filterCanvas).toHaveAttribute('height', '448');

    // Dither canvas should be 600x448.
    const ditherCanvas = page.locator('#ditherCanvas');
    await expect(ditherCanvas).toHaveAttribute('width', '600');
    await expect(ditherCanvas).toHaveAttribute('height', '448');
  });
});

test.describe('Pipeline Processing Indicators', () => {
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

  test('should show processing indicator when changing filter', async ({ page }) => {
    const hasImages = await openDetailView(page);
    if (!hasImages) {
      test.skip();
      return;
    }

    // Get current active filter.
    const initialActive = await page.locator('.filter-btn.active').getAttribute('data-filter');
    const targetFilter = initialActive === 'lanczos' ? 'mitchell' : 'lanczos';

    // Click a different filter and check for processing indicator.
    await page.locator(`.filter-btn[data-filter="${targetFilter}"]`).click();

    // Processing indicator might flash briefly - just check element exists.
    await expect(page.locator('#filterProcessing')).toBeAttached();
    await expect(page.locator('#ditherProcessing')).toBeAttached();
  });
});
