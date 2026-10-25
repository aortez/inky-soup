import {test, expect} from '@playwright/test';

for (const [model, width, height] of [['impression-5.7', 600, 448], ['impression-13.3-2025', 1600, 1200]]) {
  for (const portrait of [false, true]) {
    test(`bundled editor processes and restores ${model} ${portrait ? 'portrait' : 'landscape'}`, async ({page}) => {
      const outside = [];
      page.on('request', request => {
        if (/^https?:/.test(request.url()) && !request.url().startsWith('http://127.0.0.1:4174/')) outside.push(request.url());
      });
      await page.goto('/');
      await expect(page.locator('#pick-photo')).toBeEnabled();
      await expect(page.locator('#connection')).toBeVisible();
      await expect(page.locator('#setup-link')).toBeHidden();
      await page.locator('#settings-tab').click();
      await page.locator('#preview-model').selectOption(model);
      await page.locator('#preview-layout').selectOption(portrait ? 'portrait' : 'landscape');
      await page.locator('#choose-tab').click();
      const png = await page.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = 140; canvas.height = 100;
        const context = canvas.getContext('2d');
        ['#000', '#fff', '#0f0', '#00f', '#f00', '#ff0', '#ff8000'].forEach((color, index) => {
          context.fillStyle = color; context.fillRect(index * 20, 0, 20, 100);
        });
        return canvas.toDataURL().split(',')[1];
      });
      await page.locator('#photo').setInputFiles({name: 'colors.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64')});
      await expect(page.locator('#preview-status')).toContainText('Ready.', {timeout: 30000});
      const expected = portrait ? [height, width] : [width, height];
      expect(await page.locator('#preview').evaluate(img => [img.naturalWidth, img.naturalHeight])).toEqual(expected);
      const colors = await page.locator('#preview').evaluate(img => {
        const canvas = document.createElement('canvas'); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
        const context = canvas.getContext('2d'); context.drawImage(img, 0, 0);
        const {data} = context.getImageData(0, 0, canvas.width, canvas.height);
        const palette = new Set();
        for (let offset = 0; offset < data.length; offset += 4) palette.add([...data.slice(offset, offset + 4)].join(','));
        return [...palette];
      });
      const allowed = ['0,0,0,255', '255,255,255,255', '0,255,0,255', '0,0,255,255', '255,0,0,255', '255,255,0,255'];
      if (model === 'impression-5.7') allowed.push('255,140,0,255');
      expect(colors.length).toBeGreaterThan(1);
      expect(colors.every(color => allowed.includes(color))).toBe(true);
      await page.locator('#fit').selectOption('cover');
      await expect(page.locator('#preview-status')).toContainText('Ready.');
      await page.reload();
      await expect(page.locator('#preview-status')).toContainText('Ready.', {timeout: 30000});
      await expect(page.locator('#draft-name')).toHaveText('colors.png');
      await expect(page.locator('#fit')).toHaveValue('cover');
      expect(await page.locator('#preview').evaluate(img => [img.naturalWidth, img.naturalHeight])).toEqual(expected);
      expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      expect(outside).toEqual([]);
    });
  }
}
