import {test, expect} from '@playwright/test';

// Exercise the older bundled UI against the real API, including recovery from
// an original uploaded and rotated by a non-browser client.
test('saved photo rotation survives legacy recovery and reprocessing', async ({page, request}) => {
  await page.goto('/');
  const filename = `rotation-${Date.now()}.png`;
  const source = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 48; canvas.height = 32;
    const ctx = canvas.getContext('2d');
    ['#f00','#0f0','#00f','#ff0'].forEach((color,i) => {
      ctx.fillStyle = color; ctx.fillRect((i % 2) * 24, Math.floor(i / 2) * 16, 24, 16);
    });
    return canvas.toDataURL().split(',')[1];
  });
  const original = Buffer.from(source,'base64');
  await request.post('/upload', {multipart:{'submission.file':{name:filename,mimeType:'image/png',buffer:original}}});
  await request.post('/api/lock-image', {data:{filename,session_id:'rotation-test'}});
  const rotation = await request.post('/api/settings/photo-rotation', {data:{filename,session_id:'rotation-test',photo_rotation_degrees:90,expected_revision:0}});
  expect(rotation.ok()).toBeTruthy();
  await request.post('/api/unlock-image', {data:{filename,session_id:'rotation-test'}});
  await page.reload();
  const thumbnail = page.locator(`img[data-filename="${filename}"]`);
  await expect(thumbnail).toBeVisible({timeout:30000});
  await thumbnail.click();
  await expect(page.locator('#detailView')).toBeVisible();
  await page.locator('.filter-btn[data-filter="nearest"]').click();
  const corners = () => page.locator('#filterCanvas').evaluate(canvas => {
    const ctx = canvas.getContext('2d');
    const contentWidth = canvas.height * 32 / 48;
    const left = Math.round((canvas.width - contentWidth) / 2) + 20;
    const right = canvas.width - left - 1;
    return [[left,20],[right,20],[left,canvas.height-21],[right,canvas.height-21]]
      .map(([x,y])=>Array.from(ctx.getImageData(x,y,1,1).data).slice(0,3));
  });
  await expect.poll(corners).toEqual([[0,0,255],[255,0,0],[255,255,0],[0,255,0]]);
  const saved = page.waitForResponse(response => response.url().endsWith('/api/upload-cache') && response.request().method() === 'POST');
  await page.locator('.apply-filter-btn').click();
  expect((await (await saved).json()).success).toBe(true);
  const photos = await (await request.get('/api/images')).json();
  expect(photos.find(photo=>photo.filename===filename)).toMatchObject({photo_rotation_degrees:90,photo_rotation_revision:1});
  const response = await request.get(`/images/${filename}`);
  expect(await response.body()).toEqual(original);
});
