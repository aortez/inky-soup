/**
 * E2E tests for Settings view and global display rotation workflow.
 */

import { test, expect, openDetailView } from './fixtures.js';

test.describe('Display Settings', () => {
  test('invalid rotation API values should return 400 with clear message', async ({ request }) => {
    const response = await request.post('/api/settings/display-rotation', {
      data: { rotation_degrees: 45 },
    });

    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.message).toContain('rotation_degrees must be one of 0, 90, 180, 270');
  });

  test('settings view should open from gallery and reflect current rotation', async ({ page, request }) => {
    const displayConfigResponse = await request.get('/api/display-config');
    expect(displayConfigResponse.ok()).toBeTruthy();
    const displayConfig = await displayConfigResponse.json();

    await page.goto('/');
    await page.locator('#galleryView .settings-button').click();

    await expect(page.locator('#settingsView')).toBeVisible();
    await expect(page.locator('#galleryView')).not.toBeVisible();
    await expect(page.locator('#rotationSelect')).toHaveValue(`${displayConfig.rotation_degrees}`);

    await page.locator('#settingsView .back-button').click();
    await expect(page.locator('#galleryView')).toBeVisible();
  });

  test('opening settings from detail view should release lock first', async ({ withImage }) => {
    const page = withImage;
    await openDetailView(page);

    const filename = await page.locator('#detailFilename').textContent();
    const unlockRequestPromise = page.waitForRequest(
      (req) => req.url().includes('/api/unlock-image') && req.method() === 'POST',
    );

    await page.locator('#detailView .settings-button').click();

    const unlockRequest = await unlockRequestPromise;
    const unlockPayload = JSON.parse(unlockRequest.postData() || '{}');

    expect(unlockPayload.filename).toBe(filename);
    expect(typeof unlockPayload.session_id).toBe('string');
    expect(unlockPayload.session_id.length).toBeGreaterThan(5);

    await expect(page.locator('#settingsView')).toBeVisible();
    await expect(page.locator('#detailView')).not.toBeVisible();

    const sessionId = await page.evaluate(() => (
      window.getCurrentSessionId ? window.getCurrentSessionId() : null
    ));
    expect(sessionId).toBeNull();
  });

  test('saving rotation from settings should post selected value and show success state', async ({ page }) => {
    let payload = null;
    await page.route('**/api/settings/display-rotation', async (route) => {
      payload = JSON.parse(route.request().postData() || '{}');
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          message: 'ok',
          rotation_degrees: 270,
          removed_assets: { cache: 3, thumbs: 2, dithered: 1 },
          regenerated_assets: { cache: 0, thumbs: 0, dithered: 0 },
          originals_to_regenerate: 1,
        }),
      });
    });

    await page.goto('/');
    await page.locator('#galleryView .settings-button').click();
    await page.selectOption('#rotationSelect', '270');

    await page.locator('#saveRotationBtn').click();

    expect(payload).toEqual({ rotation_degrees: 270 });
    await expect(page.locator('#rotationStatus')).toContainText('Saved 270°');
    await expect(page.locator('#rotationStatus')).toContainText('Cleared 3 cache, 2 thumbs, 1 dithered');

    // Success path triggers reload after a short delay.
    await page.waitForLoadState('domcontentloaded');
  });

  test('failed rotation save should keep settings view visible and show error', async ({ page }) => {
    await page.route('**/api/settings/display-rotation', async (route) => {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          message: 'rotation_degrees must be one of 0, 90, 180, 270',
        }),
      });
    });

    await page.goto('/');
    await page.locator('#galleryView .settings-button').click();
    await page.selectOption('#rotationSelect', '90');
    await page.locator('#saveRotationBtn').click();

    await expect(page.locator('#rotationStatus')).toContainText(
      'Error: rotation_degrees must be one of 0, 90, 180, 270',
    );

    await page.waitForTimeout(1100);
    await expect(page.locator('#settingsView')).toBeVisible();
  });
});
