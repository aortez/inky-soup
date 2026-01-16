/**
 * E2E tests for upload queue behavior.
 */

import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';

const testImagePath = path.join(import.meta.dirname, 'fixtures', 'test-image.png');

function uniqueName(prefix, ext = 'png') {
  const nonce = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${nonce}.${ext}`;
}

function buildImagePayload(prefix, buffer) {
  return {
    name: uniqueName(prefix),
    mimeType: 'image/png',
    buffer,
  };
}

test.describe('Upload Queue', () => {
  test('should queue multiple uploads and show completion', async ({ page }) => {
    await page.goto('/');

    const buffer = fs.readFileSync(testImagePath);
    const fileOne = buildImagePayload('queue_one', buffer);
    const fileTwo = buildImagePayload('queue_two', buffer);

    const fileInput = page.locator('#fileInput');
    await fileInput.setInputFiles([fileOne, fileTwo]);

    await expect(page.locator('#uploadModal')).toHaveClass(/active/);
    await expect(page.locator('.upload-queue-item')).toHaveCount(2);
    await expect(page.locator('#uploadQueueCount')).toHaveText('2 files');

    await expect(page.locator('#uploadModalTitle')).toHaveText('✓ Upload Complete!', { timeout: 60000 });
    await expect(page.locator('.upload-queue-item.complete')).toHaveCount(2, { timeout: 60000 });
  });

  test('should skip invalid files and still upload valid ones', async ({ page }) => {
    await page.goto('/');

    const buffer = fs.readFileSync(testImagePath);
    const validFile = buildImagePayload('queue_valid', buffer);
    const invalidFile = {
      name: uniqueName('queue_invalid', 'txt'),
      mimeType: 'text/plain',
      buffer: Buffer.from('not an image'),
    };

    const dialogPromise = page.waitForEvent('dialog').then(async (dialog) => {
      expect(dialog.message()).toContain('Skipped 1 file');
      await dialog.accept();
    });

    await Promise.all([
      dialogPromise,
      page.locator('#fileInput').setInputFiles([invalidFile, validFile]),
    ]);

    await expect(page.locator('#uploadModal')).toHaveClass(/active/);
    await expect(page.locator('.upload-queue-item')).toHaveCount(1);
    await expect(page.locator('#uploadQueueCount')).toHaveText('1 file');

    await expect(page.locator('#uploadModalTitle')).toHaveText('✓ Upload Complete!', { timeout: 60000 });
    await expect(page.locator('.upload-queue-item.complete')).toHaveCount(1, { timeout: 60000 });
  });
});
