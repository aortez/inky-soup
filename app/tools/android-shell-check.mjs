import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {_android} from 'playwright';

// Operates only on this prototype's debug WebView. Select a disposable photo
// using the system picker first. Wi-Fi/data/stay-awake settings are restored.
const {values} = parseArgs({options: {
  serial: {type: 'string'}, output: {type: 'string', default: '/tmp/inky-android-shell-check.json'},
}});
const devices = await _android.devices({omitDriverInstall: true});
const device = values.serial ? devices.find(item => item.serial() === values.serial) : devices.length === 1 ? devices[0] : null;
if (!device) {
  for (const item of devices) await item.close();
  throw new Error('Connect one authorized Android device or provide --serial.');
}
const pkg = 'pizza.allan.frame';
const adb = (...args) => execFileSync('adb', ['-s', device.serial(), ...args], {maxBuffer:8 * 1024 * 1024});
const shell = (...args) => adb('shell', ...args).toString().trim();
const original = Object.fromEntries(['wifi_on', 'mobile_data', 'stay_on_while_plugged_in'].map(key => [key, shell('settings', 'get', 'global', key)]));
const output = resolve(values.output);
mkdirSync(dirname(output), {recursive: true});
const result = {
  package: pkg, model: device.model(), android: shell('getprop', 'ro.build.version.release'),
  sdk: shell('getprop', 'ro.build.version.sdk'), checks: [],
};
const externalRequests = [];
const errors = [];
async function pageForApp() {
  const pid = shell('pidof', pkg).split(' ')[0];
  // Playwright gives pkg precedence over socketName; match only the new process
  // so a cold restart cannot attach to its cached, closing predecessor.
  const view = await device.webView({socketName: `webview_devtools_remote_${pid}`});
  const page = await view.page();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && !request.url().startsWith('https://localhost/')) externalRequests.push(request.url());
  });
  await page.waitForFunction(() => document.body.classList.contains('native-shell') && !document.querySelector('#pick-photo').disabled);
  return page;
}
async function ready(page) {
  await page.waitForFunction(() => {
    const image = document.querySelector('#preview');
    return document.querySelector('#preview-status').textContent.startsWith('Ready.') && image.complete && image.naturalWidth > 0;
  }, null, {timeout: 60000});
}
async function snapshot(page) {
  return page.evaluate(async () => ({
    origin: location.origin, platform: window.Capacitor.getPlatform(), userAgent: navigator.userAgent,
    name: document.querySelector('#draft-name').textContent,
    dimensions: [document.querySelector('#preview').naturalWidth, document.querySelector('#preview').naturalHeight],
    fit: document.querySelector('#fit').value, brightness: document.querySelector('#brightness').value,
    photoRotation: document.querySelector('#photo_rotation_degrees').value,
    model: document.querySelector('#preview-model').value, layout: document.querySelector('#preview-layout').value,
    viewport: innerWidth, contentWidth: document.documentElement.scrollWidth,
    workers: (await navigator.serviceWorker.getRegistrations()).map(item => item.scope),
  }));
}
try {
  shell('input', 'keyevent', 'KEYCODE_WAKEUP');
  shell('wm', 'dismiss-keyguard');
  shell('settings', 'put', 'global', 'stay_on_while_plugged_in', '3');
  shell('am', 'start', '-W', '-n', `${pkg}/.MainActivity`);
  let page = await pageForApp();
  await ready(page);
  result.initial = await snapshot(page);
  assert.equal(result.initial.platform, 'android');
  assert.equal(result.initial.origin, 'https://localhost');

  // Exercise the actual system photo picker and its cancellation callback.
  await page.locator('#pick-photo').click();
  const deadline = Date.now() + 10000;
  while (!/mCurrentFocus=.*(?:providers.media|documentsui)/.test(shell('dumpsys', 'window', 'displays'))) {
    if (Date.now() > deadline) throw new Error('System photo picker did not open.');
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  shell('input', 'keyevent', 'KEYCODE_BACK');
  await page.waitForFunction(() => document.visibilityState === 'visible');
  assert.equal((await snapshot(page)).name, result.initial.name);
  result.checks.push('System photo-picker cancellation preserves the selected draft.');

  for (const [model, width, height] of [['impression-5.7', 600, 448], ['impression-13.3-2025', 1600, 1200]]) {
    for (const portrait of [false, true]) {
      await page.locator('#settings-tab').click();
      await page.locator('#preview-model').selectOption(model);
      await page.locator('#preview-layout').selectOption(portrait ? 'portrait' : 'landscape');
      shell('input', 'keyevent', 'KEYCODE_BACK');
      await page.waitForFunction(() => !document.querySelector('#editor-panel').hidden);
      await ready(page);
      const state = await snapshot(page);
      assert.deepEqual(state.dimensions, portrait ? [height, width] : [width, height]);
      assert.equal(state.workers.length, 0);
      assert.ok(state.contentWidth <= state.viewport);
      result.checks.push(`${model} ${state.layout}: ${state.dimensions.join(' × ')} native worker preview and Back navigation.`);
      for (const angle of [0, 90, 180, 270]) {
        assert.equal(await page.locator('#photo_rotation_degrees').isEnabled(), true);
        await page.locator('#photo_rotation_degrees').selectOption(String(angle));
        await ready(page);
        const rotated = await snapshot(page);
        assert.equal(rotated.photoRotation, String(angle));
        assert.deepEqual(rotated.dimensions, state.dimensions);
      }
      result.checks.push(`${model} ${state.layout}: all four source rotations process without changing output dimensions.`);
    }
  }
  await page.locator('#fit').selectOption('cover');
  await page.locator('#brightness').fill('25');
  await page.locator('#brightness').dispatchEvent('change');
  await ready(page);
  const before = await snapshot(page);
  // Back saves the draft before minimizing, then a cold start restores it.
  shell('input', 'keyevent', 'KEYCODE_BACK');
  // Android can suspend all WebView JS without updating document.visibilityState.
  // Observe the actual foreground Activity instead of polling the paused page.
  const minimizeDeadline = Date.now() + 10000;
  while (true) {
    const focus = shell('dumpsys', 'window', 'displays').match(/mCurrentFocus=.*$/m)?.[0];
    if (focus && !focus.includes(pkg) && !focus.endsWith('null')) break;
    if (Date.now() > minimizeDeadline) throw new Error('Back did not minimize the app.');
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  result.checks.push('Back from Create saves the draft and minimizes the app.');
  shell('svc', 'wifi', 'disable');
  shell('svc', 'data', 'disable');
  shell('am', 'force-stop', pkg);
  shell('am', 'start', '-W', '-n', `${pkg}/.MainActivity`);
  page = await pageForApp();
  await ready(page);
  const restored = await snapshot(page);
  for (const key of ['name', 'dimensions', 'fit', 'brightness', 'photoRotation', 'model', 'layout']) assert.deepEqual(restored[key], before[key]);
  assert.equal(shell('settings', 'get', 'global', 'wifi_on'), '0');
  assert.equal(shell('settings', 'get', 'global', 'mobile_data'), '0');
  result.checks.push('Cold launch with Wi-Fi and mobile data disabled restores the draft, profile, and adjustments.');
  assert.equal(restored.workers.length, 0);
  assert.deepEqual(externalRequests, []);
  assert.deepEqual(errors, []);
  result.final = restored;
  result.externalRequests = externalRequests;
  result.pageErrors = errors;
  shell('input', 'keyevent', 'KEYCODE_WAKEUP');
  await page.evaluate(async () => {
    scrollTo({top: 0, behavior: 'instant'});
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  writeFileSync(output.replace(/\.json$/, '.png'), adb('exec-out', 'screencap', '-p'));
  result.passed = true;
} catch (error) {
  result.passed = false; result.error = error.stack;
  throw error;
} finally {
  shell('svc', 'wifi', original.wifi_on === '1' ? 'enable' : 'disable');
  shell('svc', 'data', original.mobile_data === '1' ? 'enable' : 'disable');
  if (original.stay_on_while_plugged_in === 'null') shell('settings', 'delete', 'global', 'stay_on_while_plugged_in');
  else shell('settings', 'put', 'global', 'stay_on_while_plugged_in', original.stay_on_while_plugged_in);
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  for (const item of devices) await item.close();
}
console.log(JSON.stringify(result, null, 2));
