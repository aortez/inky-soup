/**
 * Exercise the configured panel through the real upload, editor, and PNG paths.
 * Run against a server with disposable INKY_SOUP_IMAGES_DIR storage.
 */

import { test, expect } from '@playwright/test';

test('configured display preserves dimensions and inks through save and flash preparation', async ({ page, request }, testInfo) => {
  const config = await (await request.get('/api/display-config')).json();
  const profiles = {
    'impression-5.7': [600, 448, 7],
    'impression-13.3-2025': [1600, 1200, 6],
  };
  const profile = profiles[config.model];
  expect(profile).toBeDefined();
  expect([config.physical_width ?? config.width, config.physical_height ?? config.height])
    .toEqual(profile.slice(0, 2));
  const dimensions = [config.width, config.height];
  await page.goto('/');

  const source = await page.evaluate(({ width, height, model }) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    const inks = ['#000000', '#ffffff', '#00ff00', '#0000ff', '#ff0000', '#ffff00'];
    if (model === 'impression-5.7') inks.push('#ff8c00');
    inks.forEach((ink, index) => {
      context.fillStyle = ink;
      context.fillRect(Math.floor(index * width / inks.length), 0,
        Math.ceil(width / inks.length), height);
    });
    return canvas.toDataURL('image/png').split(',')[1];
  }, config);
  const uploaded = page.waitForResponse((response) => response.url().endsWith('/upload')
    && response.request().method() === 'POST');
  await page.locator('#fileInput').setInputFiles({
    name: `display-profile-${Date.now()}.png`,
    mimeType: 'image/png',
    buffer: Buffer.from(source, 'base64'),
  });
  const { filename } = await (await uploaded).json();
  await expect(page.locator('#uploadModalTitle')).toHaveText('✓ Upload Complete!', { timeout: 30000 });
  // Closing reloads the page. The initial status request runs after async UI
  // setup, so wait for it before clicking the newly rendered gallery.
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith('/api/flash/status')
      && response.request().method() === 'GET'),
    page.locator('#uploadCloseBtn').click(),
  ]);
  await page.locator(`.thumbnail-item img[data-filename="${filename}"]`).click();
  await expect(page.locator('#detailView')).toBeVisible();
  await expect(page.locator('#lockStatus')).toContainText('Editing');
  await expect(page.locator('#filterProcessing')).toHaveText('');
  await expect(page.locator('#ditherProcessing')).toHaveText('');

  for (const algorithm of ['floyd-steinberg', 'atkinson', 'ordered']) {
    await page.locator(`.dither-btn[data-dither="${algorithm}"]`).click();
    await expect(page.locator('#ditherProcessing')).toHaveText('');
    const pixels = await page.locator('#ditherCanvas').evaluate((canvas) => {
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      const colors = new Set();
      for (let i = 0; i < data.length; i += 4) colors.add(Array.from(data.slice(i, i + 4)).join(','));
      return { width: canvas.width, height: canvas.height, colors: [...colors].sort() };
    });
    expect([pixels.width, pixels.height]).toEqual(dimensions);
    const expected = ['0,0,0,255', '255,255,255,255', '0,255,0,255', '0,0,255,255',
      '255,0,0,255', '255,255,0,255'];
    if (profile[2] === 7) expected.push('255,140,0,255');
    expect(pixels.colors).toEqual(expected.sort());
  }

  const saved = page.waitForResponse((response) => response.url().endsWith('/api/upload-thumb')
    && response.request().method() === 'POST');
  await page.locator('.apply-filter-btn').click();
  expect((await saved).ok()).toBe(true);

  // Exercise the real prepared-PNG upload, but never submit a physical refresh.
  let flashIntercepted = false;
  await page.route('**/flash', async (route) => {
    flashIntercepted = true;
    await route.fulfill({ json: { success: false, message: 'Physical refresh disabled in this test' } });
  });
  page.on('dialog', (dialog) => dialog.dismiss());
  const dithered = page.waitForResponse((response) => response.url().endsWith('/api/upload-dithered')
    && response.request().method() === 'POST');
  await page.locator('#flashBtn').click();
  expect((await dithered).ok()).toBe(true);
  await expect.poll(() => flashIntercepted).toBe(true);
  const assets = await page.evaluate(async (name) => {
    const dimensions = {};
    for (const folder of ['cache', 'thumbs', 'dithered']) {
      const response = await fetch(`/images/${folder}/${name}.png`);
      if (!response.ok) throw new Error(`Missing ${folder}`);
      const bitmap = await createImageBitmap(await response.blob());
      dimensions[folder] = [bitmap.width, bitmap.height];
      bitmap.close();
    }
    return dimensions;
  }, filename);
  expect(assets.cache).toEqual(dimensions);
  expect(assets.dithered).toEqual(dimensions);
  expect(assets.thumbs).toEqual([config.thumb_width, config.thumb_height]);
  await page.screenshot({ path: testInfo.outputPath('display-profile.png'), fullPage: true });
});
