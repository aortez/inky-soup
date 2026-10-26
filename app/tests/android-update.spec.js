import {test, expect} from '@playwright/test';

const digest = 'b'.repeat(64);
async function bridge(page, scenario = {}) {
  await page.addInitScript(scenario => {
    const installed = {applicationId:'pizza.allan.frame', versionName:'0.1.0', versionCode:1000, sdk:36, signingSha256:'a'.repeat(64), canInstall:true, downloadedSha256:null, ...scenario.installed};
    const release = {application_id:'pizza.allan.frame', version_name:'0.2.0', version_code:2000, min_sdk:24, apk_url:'https://github.com/aortez/inky-soup/releases/download/app-v0.2.0/frame.apk', apk_sha256:'b'.repeat(64), apk_size:8_200_000, signing_sha256:'a'.repeat(64), notes:'Faster gallery.', ...scenario.release};
    const frame = {id:'f'.repeat(32), instance_id:'c'.repeat(32), name:'Kitchen', api_version:1, capabilities:['device-identity-v1'], base:'http://192.168.1.2:8000',
      config:{model:'impression-5.7', width:600, height:448, thumb_width:150, thumb_height:112, physical_width:600, physical_height:448, rotation_revision:0}};
    if (!localStorage.getItem('initialized')) {
      localStorage.setItem('initialized', '1');
      if (scenario.frame) localStorage.setItem('sparkle-frames-v1', JSON.stringify({version:1, selected:frame.id, frames:[frame]}));
      if (scenario.job) localStorage.setItem('sparkle-job', JSON.stringify({id:7, deviceId:frame.id, instanceId:frame.instance_id, base:frame.base, filename:'photo.jpg', createdAt:123}));
      if (scenario.lastCheckAge) localStorage.setItem('sparkle-update-check', JSON.stringify({at: Date.now() - scenario.lastCheckAge, release}));
    }
    window.updateCalls = []; window.apiCalls = []; window.scenario = scenario;
    const listeners = {}, files = new Map(); let counter = 0;
    window.resumeFrame = () => listeners.appStateChange?.({isActive:true});
    const plugins = ['FrameTransport', 'FrameDiscovery', 'FrameBle', 'App', ...(scenario.noPlugin ? [] : ['FrameUpdate'])];
    window.Capacitor = {PluginHeaders: plugins.map(name => ({name, methods:[
      ...['select', 'request', 'read', 'release', 'create', 'append', 'discover', 'removeListener', 'installed', 'check', 'download', 'install', 'cancel'].map(name => ({name, rtype:'promise'})),
      {name:'addListener', rtype:'callback'},
    ]})), nativeCallback(plugin, method, args, callback) {listeners[args.eventName] = callback; return `${plugin}-${args.eventName}`;},
    async nativePromise(plugin, method, args) {
      if (plugin === 'FrameUpdate') {
        window.updateCalls.push({method, args});
        if (method === 'installed') return installed;
        if (method === 'check') {
          if (window.scenario.offline) throw Error('Cannot reach the update server. Check your internet connection.');
          return {...release, ...window.scenario.nextRelease};
        }
        if (method === 'download') {
          if (window.scenario.failDownload) throw Error('The downloaded update did not match the release. Try again.');
          listeners.updateProgress?.({received:4_100_000, total:8_200_000});
          if (window.scenario.holdDownload) await new Promise((resolve, reject) => {window.finishDownload = resolve; window.rejectDownload = reject;});
          return {};
        }
        if (method === 'install') {
          if (window.scenario.installFails) {installed.downloadedSha256 = null; throw Error('Download the update again before installing it.');}
          return {status: window.scenario.permission ? 'permission' : 'launched'};
        }
        if (method === 'cancel') {window.rejectDownload?.(Error('Download cancelled.')); return {};}
        return {};
      }
      if (plugin === 'FrameDiscovery') return {services:[]};
      if (plugin !== 'FrameTransport') return {};
      if (method === 'select' || method === 'append') return {};
      if (method === 'create') return {id:String(++counter)};
      if (method === 'release') {files.delete(args.id); return {};}
      if (method === 'read') return {data:btoa(files.get(args.id).slice(args.offset))};
      if (method === 'request') {
        window.apiCalls.push({base:args.base, path:args.path, method:args.method});
        const data = args.path === '/api/device' ? {...frame, base:args.base} : args.path === '/api/display-config' ? frame.config
          : args.path === '/api/lock-image' ? {locked:true} : args.path.startsWith('/api/flash/status/') ? {filename:'photo.jpg', created_at:123, status:window.scenario.jobStatus || 'Running'} : [];
        const text = JSON.stringify(data), id = String(++counter); files.set(id, text);
        return {id, size:text.length, status:200, contentType:'application/json'};
      }
      return {};
    }};
  }, scenario);
}

test('launch shows the installed version, checks once per interval, and remembers an offered release', async ({page}) => {
  await bridge(page); await page.goto('/');
  await expect(page.locator('#app-update')).toBeVisible();
  await expect(page.locator('#app-update-detail')).toHaveText('Version 0.2.0 is available (8.2 MB). Faster gallery.');
  await expect(page.locator('#reload-app')).toHaveText('Download');
  await page.locator('#settings-tab').click();
  await expect(page.locator('#app-version')).toHaveText('Sparkle Duck 0.1.0 (build 1000)');
  await expect(page.locator('#download-update')).toBeVisible();
  // The launch reads the installed version, and each check refreshes it before comparing the release.
  expect(await page.evaluate(() => window.updateCalls.map(call => call.method))).toEqual(['installed', 'installed', 'check']);
  expect(await page.evaluate(() => window.updateCalls[2].args.url)).toBe('https://github.com/aortez/inky-soup/releases/download/frame-app/frame-release.json');
  await page.reload();
  await expect(page.locator('#app-update-detail')).toHaveText('Version 0.2.0 is available (8.2 MB). Faster gallery.');
  expect(await page.evaluate(() => window.updateCalls.map(call => call.method))).toEqual(['installed']);
  await page.evaluate(() => window.resumeFrame());
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.updateCalls.map(call => call.method))).toEqual(['installed']);
});

for (const permission of [false, true]) test(`download verifies with progress and install hands off to Android; permission=${permission}`, async ({page}) => {
  await bridge(page, {permission}); await page.goto('/');
  await page.locator('#reload-app').click();
  await expect(page.locator('#reload-app')).toHaveText('Install');
  await page.locator('#settings-tab').click();
  await expect(page.locator('#install-update')).toBeVisible();
  await expect(page.locator('#update-progress')).toBeHidden();
  await expect(page.locator('#update-status')).toHaveText('Version 0.2.0 is ready to install. Your draft and remembered frames are kept.');
  await page.locator('#install-update').click();
  await expect(page.locator('#update-status')).toContainText(permission ? 'Allow Sparkle Duck to install updates in Android Settings' : 'Confirm the update in the Android installer');
  await expect(page.locator('#install-update')).toBeEnabled();
  const calls = await page.evaluate(() => window.updateCalls);
  expect(calls.find(call => call.method === 'download').args).toEqual({url:'https://github.com/aortez/inky-soup/releases/download/app-v0.2.0/frame.apk', size:8_200_000, sha256:'b'.repeat(64)});
  expect(calls.at(-1)).toEqual({method:'install', args:{sha256:'b'.repeat(64)}});
});

test('a failed or cancelled download keeps the release available and can be retried', async ({page}) => {
  await bridge(page, {failDownload:true}); await page.goto('/');
  await page.locator('#settings-tab').click();
  await page.locator('#download-update').click();
  await expect(page.locator('#update-status')).toHaveText('The downloaded update did not match the release. Try again. Version 0.2.0 is available (8.2 MB). Faster gallery.');
  await expect(page.locator('#install-update')).toBeHidden();
  await page.evaluate(() => {window.scenario.failDownload = false; window.scenario.holdDownload = true;});
  await page.locator('#download-update').click();
  await expect(page.locator('#download-update')).toHaveText('Cancel download');
  await expect(page.locator('#update-progress')).toBeVisible();
  await expect(page.locator('#update-status')).toHaveText('Downloading version 0.2.0… 4.1 MB of 8.2 MB.');
  await expect(page.locator('#check-updates')).toBeDisabled();
  await expect(page.locator('#app-update')).toBeVisible();
  await expect(page.locator('#reload-app')).toHaveText('Downloading…');
  await expect(page.locator('#reload-app')).toBeDisabled();
  // Cancel arms shortly after the download starts so a double tap does not abort it.
  await expect(page.locator('#download-update')).toBeEnabled();
  await page.locator('#download-update').click();
  await expect(page.locator('#update-status')).toContainText('Download cancelled.');
  await expect(page.locator('#download-update')).toHaveText('Download update');
  await page.evaluate(() => {window.scenario.holdDownload = false;});
  await page.locator('#download-update').click();
  await expect(page.locator('#install-update')).toBeVisible();
});

test('install waits for an active display job and never submits a refresh', async ({page}) => {
  await bridge(page, {frame:true, job:true, installed:{downloadedSha256:digest}}); await page.goto('/');
  await expect(page.locator('#frame-detail')).toHaveText('Connected · 600 × 448');
  await expect(page.locator('#activity-title')).toHaveText('Refreshing your frame…');
  await expect(page.locator('#reload-app')).toHaveText('Install');
  await expect(page.locator('#reload-app')).toBeDisabled();
  await expect(page.locator('#app-update-detail')).toHaveText('Install will be available when your frame finishes refreshing.');
  await page.locator('#settings-tab').click();
  await expect(page.locator('#install-update')).toBeDisabled();
  await page.evaluate(() => {window.scenario.jobStatus = 'Completed';});
  await expect(page.locator('#install-update')).toBeEnabled({timeout:10000});
  await page.locator('#install-update').click();
  await expect(page.locator('#update-status')).toContainText('Confirm the update in the Android installer');
  expect(await page.evaluate(() => window.apiCalls.every(call => call.method === 'GET'))).toBe(true);
  expect(await page.evaluate(() => window.updateCalls.filter(call => call.method === 'download').length)).toBe(0);
});

test('current, incompatible, and unreachable releases are explained without downloading', async ({page}) => {
  await bridge(page, {release:{version_code:1000}}); await page.goto('/');
  await page.locator('#settings-tab').click();
  await expect(page.locator('#update-status')).toHaveText('Updates are checked automatically a few times a day.');
  await expect(page.locator('#app-update')).toBeHidden();
  await page.locator('#check-updates').click();
  await expect(page.locator('#update-status')).toHaveText('You have the latest version.');
  await page.evaluate(() => {window.scenario.nextRelease = {version_code:2000, signing_sha256:'d'.repeat(64)};});
  await page.locator('#check-updates').click();
  await expect(page.locator('#update-status')).toContainText('different signing key');
  await expect(page.locator('#download-update')).toBeHidden();
  await expect(page.locator('#app-update')).toBeHidden();
  await page.evaluate(() => {window.scenario.offline = true;});
  await page.locator('#check-updates').click();
  await expect(page.locator('#update-status')).toHaveText('Cannot reach the update server. Check your internet connection.');
  expect(await page.evaluate(() => window.updateCalls.filter(call => call.method === 'download').length)).toBe(0);
});

for (const age of [1000, 7 * 3600 * 1000]) test(`a verified download stays installable without the update server; checkAge=${age}`, async ({page}) => {
  await bridge(page, {installed:{downloadedSha256:digest}, offline:true, lastCheckAge:age}); await page.goto('/');
  await expect(page.locator('#reload-app')).toHaveText('Install');
  await page.locator('#settings-tab').click();
  await expect(page.locator('#install-update')).toBeVisible();
  expect(await page.evaluate(() => window.updateCalls.map(call => call.method))).toEqual(age > 3600 * 1000 ? ['installed', 'installed', 'check'] : ['installed']);
  // A manual check that fails reports the problem but keeps the package installable.
  await page.locator('#check-updates').click();
  await expect(page.locator('#update-status')).toContainText('Cannot reach the update server');
  await expect(page.locator('#install-update')).toBeVisible();
  await expect(page.locator('#reload-app')).toHaveText('Install');
});

test('an install rejected for a missing or altered package offers the download again', async ({page}) => {
  await bridge(page, {installed:{downloadedSha256:digest}, installFails:true}); await page.goto('/');
  await page.locator('#settings-tab').click();
  await page.locator('#install-update').click();
  await expect(page.locator('#update-status')).toHaveText('Download the update again before installing it. Version 0.2.0 is available (8.2 MB). Faster gallery.');
  await expect(page.locator('#download-update')).toBeVisible();
  await expect(page.locator('#install-update')).toBeHidden();
  await expect(page.locator('#reload-app')).toHaveText('Download');
});

test('a shell without the update plugin shows no version and makes no release requests', async ({page}) => {
  await bridge(page, {noPlugin:true}); await page.goto('/');
  await expect(page.locator('#pick-photo')).toBeEnabled();
  await page.locator('#settings-tab').click();
  await expect(page.locator('#app-version')).toHaveText('The app version is unavailable.');
  await expect(page.locator('#check-updates')).toBeDisabled();
  await expect(page.locator('#app-update')).toBeHidden();
  expect(await page.evaluate(() => window.updateCalls)).toEqual([]);
});
