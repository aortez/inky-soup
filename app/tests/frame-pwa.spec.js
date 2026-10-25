import {test,expect} from '@playwright/test';
import {releaseServer} from './helpers/pwa-release-server.js';
test('installed shell and photo draft open offline without caching frame requests',async({page,context})=>{
 await page.route('http://inky-soup.local:8000/**',route=>route.fulfill({json:route.request().url().endsWith('/api/images')?[]:{width:1200,height:1600,physical_width:1600,physical_height:1200,rotation_degrees:270,rotation_revision:8,thumb_width:112,thumb_height:150,model:'impression-13.3-2025'}}));
 await page.goto('/frame/');await page.evaluate(()=>navigator.serviceWorker.ready);
 await page.locator('#connect').click();await expect(page.locator('#pick-photo')).toBeEnabled();
 const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=20;c.height=15;c.getContext('2d').fillRect(0,0,20,15);return c.toDataURL().split(',')[1];});
 await page.locator('#photo').setInputFiles({name:'offline.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
 await expect(page.locator('#send')).toBeEnabled();
 await page.reload();await expect(page.locator('#send')).toBeEnabled();
 const cdp=await context.newCDPSession(page);
 const install=await cdp.send('Page.getInstallabilityErrors');
 expect(install.installabilityErrors).toEqual([]);
 await page.unroute('http://inky-soup.local:8000/**');
 await context.setOffline(true);
 // New Chromium separates transport emulation from navigator.onLine state.
 await cdp.send('Network.overrideNetworkState', {offline:true,latency:0,downloadThroughput:0,uploadThroughput:0});
 await page.reload({waitUntil:'domcontentloaded'});
 await expect(page.locator('#draft-name')).toHaveText('offline.png');
 await expect(page.locator('#preview')).toBeVisible();
 await expect(page.locator('#preview-status')).toContainText('Ready.');
 expect(await page.locator('#preview').evaluate(img => [img.naturalWidth,img.naturalHeight])).toEqual([1200,1600]);
 await expect(page.locator('#connection-status')).toContainText('offline');
 await expect(page.locator('#send')).toBeDisabled();
 await expect(page.locator('#fit')).toBeEnabled();
 await page.locator('#fit').selectOption('cover');
 await page.locator('#brightness').fill('30'); await page.locator('#brightness').dispatchEvent('change');
 await page.locator('#advanced summary').click(); await page.locator('#dither').selectOption('ordered');
 await expect(page.locator('#preview-status')).toContainText('Ready.');
 await page.reload({waitUntil:'domcontentloaded'});
 await expect(page.locator('#fit')).toHaveValue('cover');
 await expect(page.locator('#brightness')).toHaveValue('30'); await expect(page.locator('#dither')).toHaveValue('ordered');
 const keys=await page.evaluate(async()=>{const output=[];for(const name of await caches.keys())for(const req of await(await caches.open(name)).keys())output.push(req.url);return output;});
 expect(keys.length).toBeGreaterThan(5);expect(keys.every(url=>url.startsWith('http://127.0.0.1:4173/'))).toBe(true);
});


test('active app version launches without fetching a newer HTML shell', async ({page}) => {
  await page.goto('/frame/');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  let navigations = 0;
  await page.route('**/frame/', route => {
    navigations++;
    return route.fulfill({contentType: 'text/html', body: '<h1>Different release</h1>'});
  });
  await page.reload();
  await expect(page.locator('#editor-heading')).toHaveText('A new view.');
  expect(navigations).toBe(0);
});


const frameConfig = {width:1600,height:1200,physical_width:1600,physical_height:1200,rotation_degrees:0,
  rotation_revision:0,thumb_width:150,thumb_height:112,model:'impression-13.3-2025'};

async function installed(page, server) {
  await page.goto(server.url);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-release', '1');
  await expect(page.locator('#app-update')).toBeHidden();
}

async function newRelease(page, server) {
  server.state.version = 2;
  // Exercise the app's reconnect update check, without reloading the old app.
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('#app-update')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-release', '1');
}

async function draft(page) {
  await page.route('http://inky-soup.local:8000/**', route => route.fulfill({json:
    route.request().url().endsWith('/api/images') ? [] : frameConfig}));
  await page.locator('#connect').click();
  await expect(page.locator('#pick-photo')).toBeEnabled();
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width=60; canvas.height=40;
    const ctx = canvas.getContext('2d'); ctx.fillStyle='#e8b859'; ctx.fillRect(0,0,60,40);
    ctx.fillStyle='#42765b'; ctx.fillRect(0,25,60,15); return canvas.toDataURL().split(',')[1];
  });
  await page.locator('#photo').setInputFiles({name:'keep-me.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
  await expect(page.locator('#send')).toBeEnabled();
  await page.locator('#brightness').fill('25'); await page.locator('#brightness').dispatchEvent('change');
  await expect(page.locator('#send')).toBeEnabled();
}

test('downloaded update reloads once offline and preserves the latest photo draft', async ({page, context}) => {
  const server = await releaseServer();
  try {
    await installed(page, server);
    await draft(page);
    await newRelease(page, server);
    await expect(page.locator('#reload-app')).toBeEnabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({path:'docs/screenshots/frame-update-available.png',fullPage:true});
    let navigations = 0;
    page.on('framenavigated', frame => {if (frame === page.mainFrame()) navigations++;});
    await context.setOffline(true);
    await page.locator('#reload-app').click();
    await expect(page.locator('html')).toHaveAttribute('data-release', '2');
    await expect(page.locator('#app-update')).toBeHidden();
    await expect(page.locator('#draft-name')).toHaveText('keep-me.png');
    await expect(page.locator('#brightness')).toHaveValue('25');
    await expect(page.locator('#preview-status')).toContainText('Ready.');
    expect(navigations).toBe(1);
  } finally {await server.close();}
});

test('a waiting update survives reopening and cannot interrupt another app window', async ({page, context}) => {
  const server = await releaseServer();
  try {
    await installed(page, server);
    const other = await context.newPage(); await other.goto(server.url);
    await newRelease(page, server);
    await page.reload();
    await expect(page.locator('#app-update')).toBeVisible();
    await page.locator('#reload-app').click();
    await expect(page.locator('#app-update-detail')).toContainText('Close other frame app tabs');
    await expect(page.locator('html')).toHaveAttribute('data-release', '1');
    await expect(other.locator('html')).toHaveAttribute('data-release', '1');
    await other.close();
    await page.locator('#reload-app').click();
    await expect(page.locator('html')).toHaveAttribute('data-release', '2');
  } finally {await server.close();}
});

test('update waits for a remembered display job without submitting another flash', async ({page}) => {
  const server = await releaseServer();
  let finished = false;
  const writes = [];
  try {
    await installed(page, server);
    await page.route('http://inky-soup.local:8000/**', route => {
      const request = route.request(); const path = new URL(request.url()).pathname;
      if (request.method() === 'POST') writes.push(path);
      const json = path === '/api/images' ? [] : path === '/api/flash/status/1'
        ? {filename:'photo.png',created_at:100,status:finished ? 'Completed' : 'Flashing'} : frameConfig;
      return route.fulfill({json});
    });
    await page.evaluate(config => {
      const base = 'http://inky-soup.local:8000';
      localStorage.setItem('sparkle-frame',JSON.stringify({base,name:'inky-soup',config}));
      localStorage.setItem('sparkle-job',JSON.stringify({base,id:1,filename:'photo.png',createdAt:100}));
    }, frameConfig);
    await page.reload();
    await expect(page.locator('#activity-title')).toHaveText('Refreshing your frame…');
    await newRelease(page, server);
    await expect(page.locator('#reload-app')).toBeDisabled();
    await expect(page.locator('#app-update-detail')).toContainText('finishes refreshing');
    finished = true;
    await expect(page.locator('#reload-app')).toBeEnabled();
    await page.locator('#reload-app').click();
    await expect(page.locator('html')).toHaveAttribute('data-release', '2');
    expect(writes).not.toContain('/flash');
  } finally {await server.close();}
});

test('a draft storage failure keeps the current app open and makes reload retryable', async ({page}) => {
  const server = await releaseServer();
  try {
    await installed(page, server); await draft(page); await newRelease(page, server);
    await page.evaluate(() => {
      window.originalTransaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function(...args) {
        if (args[1] === 'readwrite') throw new DOMException('Storage full', 'QuotaExceededError');
        return window.originalTransaction.apply(this, args);
      };
    });
    await page.locator('#reload-app').click();
    await expect(page.locator('#app-update-detail')).toContainText('Your draft could not be saved');
    await expect(page.locator('html')).toHaveAttribute('data-release', '1');
    await expect(page.locator('#send')).toBeEnabled();
    await page.evaluate(() => {IDBDatabase.prototype.transaction = window.originalTransaction;});
    await page.locator('#reload-app').click();
    await expect(page.locator('html')).toHaveAttribute('data-release', '2');
    await expect(page.locator('#brightness')).toHaveValue('25');
  } finally {await server.close();}
});

test('reload stays disabled until a photo upload has finished', async ({page}) => {
  const server = await releaseServer();
  let resume;
  let uploading = false;
  const upload = new Promise(resolve => {resume = resolve;});
  try {
    await installed(page, server); await draft(page); await newRelease(page, server);
    await page.unroute('http://inky-soup.local:8000/**');
    await page.route('http://inky-soup.local:8000/**', async route => {
      const request = route.request(); const path = new URL(request.url()).pathname;
      if (path === '/api/upload-dithered') {uploading = true; await upload;}
      const json = path === '/api/display-config' ? frameConfig : path === '/api/images' ? []
        : path === '/api/lock-image' ? {locked:true}
        : path === '/upload' ? {filename:/filename="([^"]+)"/.exec(request.postData())[1]} : {success:true};
      await route.fulfill({json});
    });
    await page.locator('#save').click();
    await expect.poll(() => uploading).toBe(true);
    await expect(page.locator('#reload-app')).toBeDisabled();
    await expect(page.locator('#app-update-detail')).toContainText('Finish the current task');
    resume();
    await expect(page.locator('#reload-app')).toBeEnabled();
    await page.locator('#reload-app').click();
    await expect(page.locator('html')).toHaveAttribute('data-release', '2');
    await expect(page.locator('#draft-name')).toHaveText('keep-me.png');
  } finally {resume?.(); await server.close();}
});

test('a failed update download leaves the current app usable until a complete update arrives', async ({page}) => {
  const server = await releaseServer();
  let resume;
  try {
    await installed(page, server);
    server.state.version = 2; server.state.failDownload = true;
    server.state.holdDownload = new Promise(resolve => {resume = resolve;});
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      await registration.update();
    });
    await expect.poll(() => page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration()).installing))).toBe(true);
    await expect(page.locator('#app-update')).toBeHidden();
    resume(); server.state.holdDownload = null;
    await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).installing?.state || 'none')).toBe('none');
    await expect(page.locator('#app-update')).toBeHidden();
    await expect(page.locator('#connect')).toBeEnabled();
    server.state.failDownload = false;
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
    await expect(page.locator('#app-update')).toBeVisible();
    await page.locator('#reload-app').click();
    await expect(page.locator('html')).toHaveAttribute('data-release', '2');
  } finally {resume?.(); await server.close();}
});
