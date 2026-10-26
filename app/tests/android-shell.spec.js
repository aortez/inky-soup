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
      await expect(page.locator('#photo_rotation_degrees')).toBeEnabled();
      await page.locator('#photo_rotation_degrees').selectOption('90');
      await expect(page.locator('#preview-status')).toContainText('Ready.');
      await page.reload();
      await expect(page.locator('#preview-status')).toContainText('Ready.', {timeout: 30000});
      await expect(page.locator('#draft-name')).toHaveText('colors.png');
      await expect(page.locator('#fit')).toHaveValue('cover');
      await expect(page.locator('#photo_rotation_degrees')).toHaveValue('90');
      await expect(page.locator('#test-orientation')).toBeHidden();
      await expect(page.locator('#test-orientation')).toBeDisabled();
      expect(await page.locator('#preview').evaluate(img => [img.naturalWidth, img.naturalHeight])).toEqual(expected);
      expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      expect(outside).toEqual([]);
    });
  }
}

test('bundled photo rotation moves source corners clockwise before fitting', async ({page}) => {
  await page.goto('/');
  const png = await page.evaluate(() => {
    const canvas=document.createElement('canvas');canvas.width=48;canvas.height=32;
    const ctx=canvas.getContext('2d');
    ['#f00','#0f0','#00f','#ff0'].forEach((color,i)=>{
      ctx.fillStyle=color;ctx.fillRect(i%2*24,Math.floor(i/2)*16,24,16);
    });
    return canvas.toDataURL().split(',')[1];
  });
  await page.locator('#photo').setInputFiles({name:'corners.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
  await expect(page.locator('#preview-status')).toContainText('Ready.');
  await page.locator('#fit').selectOption('cover');
  await page.locator('#preview-before').click();
  const R=[255,0,0],G=[0,255,0],B=[0,0,255],Y=[255,255,0];
  const corners=[[R,G,B,Y],[B,R,Y,G],[Y,B,G,R],[G,Y,R,B]];
  for (const model of ['impression-5.7','impression-13.3-2025']) {
    for (const layout of ['landscape','portrait']) {
      await page.locator('#settings-tab').click();
      await page.locator('#preview-model').selectOption(model);
      await page.locator('#preview-layout').selectOption(layout);
      await page.locator('#choose-tab').click();
      for (const [index,angle] of [0,90,180,270].entries()) {
        await page.locator('#photo_rotation_degrees').selectOption(String(angle));
        await expect(page.locator('#preview-status')).toContainText('Ready.');
        await expect.poll(() => page.locator('#preview').evaluate(image => {
          if (!image.complete || !image.naturalWidth) return null;
          const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
          const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
          return [[.25,.25],[.75,.25],[.25,.75],[.75,.75]].map(([x,y])=>
            Array.from(ctx.getImageData(Math.floor(x*canvas.width),Math.floor(y*canvas.height),1,1).data).slice(0,3));
        })).toEqual(corners[index]);
      }
    }
  }
});
