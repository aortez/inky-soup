import {test, expect} from '@playwright/test';

async function nativeBridge(page, mode = 'success') {
  await page.addInitScript(mode => {
    const callbacks = {}; let session, selected, counter = 0;
    const files = new Map(); window.bleMode = mode; window.bleWrites = []; window.apiCalls = [];
    const encoded = value => btoa(String.fromCharCode(...value));
    const emit = (type, args = {}) => callbacks.FrameBle?.({session, type, ...args});
    const packet = text => {
      const value = new TextEncoder().encode(text), bytes = [1, value.length + 1, value.length, ...value];
      return encoded([...bytes, bytes.reduce((sum, byte) => (sum + byte) & 255, 0)]);
    };
    window.bleEmit = emit;
    const config = {model:'impression-5.7', width:600, height:448, physical_width:600, physical_height:448, rotation_degrees:0, rotation_revision:0};
    window.Capacitor = {
      PluginHeaders: ['FrameBle', 'FrameTransport', 'App'].map(name => ({name, methods: [
        ...['scan','connect','read','write','cancel','settings','select','request','release','removeListener'].map(name => ({name,rtype:'promise'})),
        {name:'addListener', rtype:'callback'},
      ]})),
      nativeCallback(plugin, method, args, callback) {callbacks[plugin] = callback; return `${plugin}-listener`;},
      async nativePromise(plugin, method, args) {
        if (method === 'removeListener' || method === 'cancel' || method === 'settings') return {};
        if (plugin === 'FrameBle') {
          if (method === 'scan') {
            session = args.session;
            if (window.bleMode === 'denied') throw new Error('Allow Nearby devices, then scan again.');
            if (window.bleMode === 'off') throw new Error('Bluetooth is off. Turn it on, then scan again.');
            setTimeout(() => {
              emit('device', {id:'AA:11:22:33:44:55',name:'Inky',rssi:-40});
              emit('device', {id:'BB:66:77:88:99:00',name:'Inky',rssi:-65}); emit('scanDone');
            }, 10);
            return {};
          }
          if (method === 'connect') {selected = args.device; return {mtu:185};}
          if (method === 'read') return {data:encoded(args.kind === 'state' ? [2] : [0])};
          if (method === 'write') {
            window.bleWrites.push({device:selected, data:args.data});
            setTimeout(() => {
              if (window.bleMode === 'failure') emit('value', {kind:'error',data:encoded([3])});
              else if (window.bleMode !== 'silent') emit('value',{kind:'result',data:packet('http://192.168.1.149:8000')});
            }, 10);
            return {};
          }
        }
        if (plugin === 'FrameTransport') {
          if (method === 'select') return {};
          if (method === 'request') {
            window.apiCalls.push(args.path);
            if (window.bleMode === 'slow-api' && args.path === '/api/display-config') await new Promise(resolve => {window.completeApi = resolve;});
            if (window.bleMode === 'unreachable') throw new Error('Cannot reach the frame.');
            const id = String(++counter), text = JSON.stringify(args.path === '/api/device' ? {id:'a'.repeat(32),instance_id:'b'.repeat(32),name:'Inky',api_version:1,capabilities:['device-identity-v1']} : args.path === '/api/display-config' ? config : []);
            files.set(id, text); return {id,size:text.length,status:200,contentType:'application/json'};
          }
          if (method === 'read') return {data:btoa(files.get(args.id).slice(args.offset))};
          if (method === 'release') {files.delete(args.id); return {};}
        }
        return {};
      },
    };
  }, mode);
}
async function select(page) {
  await page.locator('#setup-scan').click();
  await expect(page.locator('#setup-devices button')).toHaveCount(2);
  await page.getByRole('button', {name:'Inky · 33:44:55',exact:false}).click();
  await expect(page.locator('#setup-wifi')).toBeVisible();
}
async function credentials(page) {
  await page.getByLabel('WiFi network name', {exact:true}).fill('家'.repeat(10) + 'ab');
  await page.getByLabel('WiFi password', {exact:true}).fill('é'.repeat(32));
  await page.locator('#setup-submit').click();
}

test('fresh Android app selects a distinct frame and opens editor only after API verification', async ({page}) => {
  await nativeBridge(page); await page.goto('/'); await page.locator('#add-frame').click();
  await select(page); await credentials(page);
  await expect(page.locator('#setup-status')).toHaveText('Your frame is connected and ready for photos.');
  await expect(page.locator('#setup-password')).toHaveValue(''); await expect(page.locator('#setup-ssid')).toHaveValue('');
  expect(await page.evaluate(() => window.bleWrites[0].device)).toBe('AA:11:22:33:44:55');
  expect(await page.evaluate(() => window.apiCalls)).toEqual(['/api/device','/api/display-config','/api/images','/api/device']);
  const bytes = await page.evaluate(() => Array.from(atob(window.bleWrites[0].data), c => c.charCodeAt(0)));
  expect(bytes.length).toBe(101);
  await page.locator('#setup-done').click(); await expect(page.locator('#setup-dialog')).not.toBeVisible();
  await expect(page.locator('#frame-detail')).toHaveText('Connected · 600 × 448');
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('é');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('incorrect credentials and cancellation offer a clean retry inside the app', async ({page}) => {
  await nativeBridge(page, 'failure'); await page.goto('/'); await page.locator('#add-frame').click();
  await select(page); await credentials(page); await expect(page.locator('#setup-status')).toContainText('Check the network name and password');
  await expect(page.locator('#setup-password')).toHaveValue('');
  await page.evaluate(() => {window.bleMode = 'silent';}); await select(page); await credentials(page);
  await page.locator('#setup-cancel').click(); await expect(page.locator('#setup-dialog')).not.toBeVisible();
  await page.evaluate(() => {window.bleMode = 'success';}); await page.locator('#add-frame').click();
  await select(page); await credentials(page); await expect(page.locator('#setup-done')).toBeVisible();
});

for (const mode of ['denied', 'off']) test(`${mode}: permission/radio recovery stays in the app`, async ({page}) => {
  await nativeBridge(page, mode); await page.goto('/'); await page.locator('#add-frame').click();
  await page.locator('#setup-scan').click(); await expect(page.locator('#setup-status')).toContainText(mode === 'off' ? 'Bluetooth is off' : 'Allow Nearby devices');
  await expect(page.locator('#setup-help')).toBeVisible();
  await page.evaluate(() => {window.bleMode = 'success';}); await select(page); await expect(page.locator('#setup-wifi')).toBeVisible();
});

test('BLE success without API connectivity is not setup success, and API retry does not provision again', async ({page}) => {
  await nativeBridge(page, 'unreachable'); await page.goto('/'); await page.locator('#add-frame').click();
  await select(page); await credentials(page); await expect(page.locator('#setup-status')).toContainText('app could not reach the frame');
  await expect(page.locator('#setup-done')).toBeHidden(); await expect(page.locator('#setup-password')).toHaveValue('');
  await page.evaluate(() => {window.bleMode = 'success';}); await page.locator('#setup-retry').click();
  await expect(page.locator('#setup-done')).toBeVisible(); expect(await page.evaluate(() => window.bleWrites.length)).toBe(1);
});


test('cancelling API verification cannot remember or connect the abandoned frame', async ({page}) => {
  await nativeBridge(page, 'slow-api'); await page.goto('/'); await page.locator('#add-frame').click();
  await select(page); await credentials(page);
  await expect(page.locator('#setup-status')).toContainText('Connecting directly');
  await page.waitForFunction(() => Boolean(window.completeApi));
  await page.locator('#setup-cancel').click();
  await page.evaluate(() => {window.completeApi();});
  await expect(page.locator('#connect')).toBeEnabled();
  expect(await page.evaluate(() => localStorage.getItem('sparkle-frame'))).toBeNull();
  await expect(page.locator('#frame-detail')).not.toContainText('Connected ·');
  await page.evaluate(() => {window.bleMode = 'success';});
  await page.locator('#add-frame').click(); await select(page); await credentials(page);
  await expect(page.locator('#setup-done')).toBeVisible();
});


test('late Bluetooth disconnect cannot cancel the verified WiFi handoff', async ({page}) => {
  await nativeBridge(page, 'slow-api'); await page.goto('/'); await page.locator('#add-frame').click();
  await select(page); await credentials(page);
  await page.waitForFunction(() => Boolean(window.completeApi));
  await page.evaluate(() => {
    window.bleEmit('error', {message: 'Bluetooth disconnected'});
    window.completeApi();
  });
  await expect(page.locator('#setup-done')).toBeVisible();
  await expect(page.locator('#frame-detail')).toHaveText('Connected · 600 × 448');
});

test('cancelling setup during the durable registry commit leaves no saved frame', async ({page}) => {
  await nativeBridge(page);
  await page.addInitScript(() => {
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function(...args) {
      const transaction = original.apply(this, args);
      if (this.name === 'sparkle-frame-registry' && args[1] === 'readwrite') {
        window.registryCommitPending = true;
        const store = transaction.objectStore('settings');
        const hold = () => {store.get('keep-alive').onsuccess = hold;};
        hold();
      }
      return transaction;
    };
  });
  await page.goto('/'); await page.locator('#add-frame').click();
  await select(page); await credentials(page);
  await page.waitForFunction(() => window.registryCommitPending);
  await page.locator('#setup-cancel').click();
  await expect(page.locator('#connect')).toBeEnabled();
  expect(await page.evaluate(() => localStorage.getItem('sparkle-frames-v1'))).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('sparkle-frame'))).toBeNull();
  await page.reload(); await expect(page.locator('#frame-name')).toHaveText('Your frame');
  expect(await page.evaluate(() => window.apiCalls)).toEqual([]);
});
