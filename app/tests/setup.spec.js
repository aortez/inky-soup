import { test, expect } from '@playwright/test';

async function mockBluetooth(page, mode = 'success') {
  await page.addInitScript((mode) => {
    const chars = {};
    const view = bytes => new DataView(new Uint8Array(bytes).buffer);
    window.setupMode = mode;
    window.setupWrites = [];
    class Characteristic extends EventTarget {
      constructor(bytes) { super(); this.value = view(bytes); }
      async readValue() { return this.value; }
      async startNotifications() { return this; }
      notify(bytes) { this.value = view(bytes); this.dispatchEvent(new Event('characteristicvaluechanged')); }
      async writeValueWithResponse(packet) {
        window.setupWrites.push(Array.from(packet));
        chars[2].value = view([0]);
        chars[1].value = view([3]);
        if (window.setupMode === 'silent') return;
        if (window.setupMode === 'failure') {
          chars[1].value = view([2]);
          chars[2].notify([3]);
        } else if (window.setupMode === 'legacy-failure') {
          chars[1].value = view([2]);
          chars[2].value = view([3]);
        } else {
          const url = new TextEncoder().encode(window.setupMode === 'unsafe' ? 'javascript:alert(1)' : 'http://inky-soup.local:8000');
          const bytes = [1, url.length + 1, url.length, ...url];
          bytes.push(bytes.reduce((a,b) => (a+b)&255, 0));
          chars[1].value = view([4]);
          if (window.setupMode === 'legacy-success') chars[4].value = view(bytes);
          else chars[4].notify(bytes);
        }
      }
    }
    chars[1] = new Characteristic([2]); chars[2] = new Characteristic([0]);
    chars[3] = new Characteristic([]); chars[4] = new Characteristic([]);
    window.setupChars = chars;
    const device = new EventTarget(); device.name = 'inky-soup';
    device.gatt = {
      connected: false,
      async connect() { this.connected = true; return this; },
      async getPrimaryService() { return { getCharacteristic: async uuid => chars[Number(uuid.slice(-1))] }; },
      disconnect() { this.connected = false; device.dispatchEvent(new Event('gattserverdisconnected')); },
    };
    window.setupDevice = device;
    Object.defineProperty(navigator, 'bluetooth', { value: {
      requestDevice: async () => {
        if (window.setupMode === 'cancel') throw new DOMException('Cancelled', 'NotFoundError');
        chars[1].value = view([2]); chars[2].value = view([0]);
        return device;
      },
    } });
  }, mode);
}

async function credentials(page) {
  await page.getByRole('button', { name: 'Connect to a frame' }).click();
  await expect(page.getByLabel('WiFi network name')).toBeVisible();
  await page.getByLabel('WiFi network name').fill('Test network');
  await page.getByLabel('WiFi password', { exact: true }).fill('test-password');
}

for (const mode of ['success', 'legacy-success']) {
  test(`${mode}: app handoff, device fallback, and cleared credentials`, async ({ page }) => {
    await mockBluetooth(page, mode);
    await page.goto('/setup/');
    await credentials(page);
    await page.getByRole('button', { name: 'Connect to WiFi' }).click();
    await expect(page.getByRole('link', { name: 'Open inky-soup' })).toHaveAttribute('href', '/frame/#device=http%3A%2F%2Finky-soup.local%3A8000%2F');
    await expect(page.locator('#device-interface-link')).toHaveAttribute('href', 'http://inky-soup.local:8000/');
    await expect(page.locator('#device-interface-link')).toHaveText('Open the original device interface');
    await expect(page.locator('#password')).toHaveValue('');
  });
}

for (const mode of ['failure', 'legacy-failure']) {
  test(`${mode}: error recovers without reloading`, async ({ page }) => {
    await mockBluetooth(page, mode);
    await page.goto('/setup/');
    await credentials(page);
    await page.getByRole('button', { name: 'Connect to WiFi' }).click();
    await expect(page.getByRole('status')).toContainText('Check the network name and password');
    await expect(page.getByRole('button', { name: 'Connect to WiFi' })).toBeEnabled();
    await page.evaluate(() => { window.setupMode = 'success'; });
    await page.getByRole('button', { name: 'Connect to WiFi' }).click();
    await expect(page.getByRole('link', { name: 'Open inky-soup' })).toBeVisible();
  });
}

test('cancel during provisioning ignores the abandoned attempt', async ({ page }) => {
  await mockBluetooth(page, 'silent');
  await page.goto('/setup/');
  await credentials(page);
  await page.getByRole('button', { name: 'Connect to WiFi' }).click();
  await page.getByRole('button', { name: 'Cancel setup' }).click();
  await expect(page.getByRole('status')).toContainText('Setup cancelled');
  await expect(page.locator('#password')).toHaveValue('');
  await page.evaluate(() => { window.setupMode = 'success'; });
  await credentials(page);
  await page.getByRole('button', { name: 'Connect to WiFi' }).click();
  await expect(page.getByRole('link', { name: 'Open inky-soup' })).toBeVisible();
});

test('chooser cancellation and unsafe device links are handled', async ({ page }) => {
  await mockBluetooth(page, 'cancel');
  await page.goto('/setup/');
  await page.getByRole('button', { name: 'Connect to a frame' }).click();
  await expect(page.getByRole('status')).toContainText('No device selected');
  await page.evaluate(() => { window.setupMode = 'unsafe'; });
  await credentials(page);
  await page.getByRole('button', { name: 'Connect to WiFi' }).click();
  await expect(page.getByRole('status')).toContainText('unsafe link');
  await expect(page.locator('#device-link')).toBeHidden();
});

test('bounded request timeout does not leave a pending command', async ({ page }) => {
  await mockBluetooth(page, 'silent');
  await page.goto('/setup/');
  const result = await page.evaluate(async () => {
    const { ImprovClient } = await import('/setup/improv-client.js');
    const events = [];
    const client = new ImprovClient({ requestTimeout: 30, onStatus: e => events.push(e.state) });
    await client.connect();
    try { await client.provision('Test', 'test-password'); } catch {}
    return { events, pending: client.pending, device: client.device };
  });
  expect(result.events).toContain('error');
  expect(result.pending).toBeNull();
  expect(result.device).toBeNull();
});

test('a late read failure from an earlier attempt does not cancel a retry', async ({ page }) => {
  await mockBluetooth(page, 'silent');
  await page.goto('/setup/');
  const result = await page.evaluate(async () => {
    const { ImprovClient, encodeRequest } = await import('/setup/improv-client.js');
    const client = new ImprovClient();
    await client.connect();
    let rejectRead;
    let readStarted;
    const started = new Promise(resolve => { readStarted = resolve; });
    window.setupChars[2].readValue = () => {
      readStarted();
      return new Promise((_, reject) => { rejectRead = reject; });
    };
    const first = client.provision('Test', 'wrong-password').catch(error => error.message);
    await started;
    window.setupChars[2].notify([3]);
    await first;
    const retry = client.provision('Test', 'correct-password').catch(error => error.message);
    rejectRead(new Error('Abandoned read failed'));
    await new Promise(resolve => setTimeout(resolve, 10));
    window.setupChars[4].notify(encodeRequest(1, ['http://inky-soup.local:8000']));
    return await retry;
  });
  expect(result).toBe('http://inky-soup.local:8000/');
});

test('old QR address redirects to setup', async ({ page }) => {
  await page.goto('/wifi/');
  await expect(page).toHaveURL(/\/setup\/$/);
  await expect(page.getByRole('heading', { name: 'Give your frame a connection.' })).toBeVisible();
});

test('a cancelled connection cannot disconnect a newer connection to the same device', async ({ page }) => {
  await mockBluetooth(page);
  await page.goto('/setup/');
  const result = await page.evaluate(async () => {
    const { ImprovClient } = await import('/setup/improv-client.js');
    const client = new ImprovClient();
    const gatt = window.setupDevice.gatt;
    let finishFirst;
    let started;
    const firstStarted = new Promise(resolve => { started = resolve; });
    let attempts = 0;
    gatt.connect = async function () {
      this.connected = true;
      if (++attempts === 1) {
        started();
        await new Promise(resolve => { finishFirst = resolve; });
      }
      return this;
    };
    const first = client.connect();
    await firstStarted;
    client.disconnect();
    await client.connect();
    finishFirst();
    await first;
    const connected = client.device?.gatt.connected === true;
    client.disconnect();
    return connected;
  });
  expect(result).toBe(true);
});

test('mobile layout fits and explains unsupported browsers', async ({ page }) => {
  await page.addInitScript(() => { delete Navigator.prototype.bluetooth; });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/setup/');
  await expect(page.getByRole('status')).toContainText('iPhone and iPad');
  await expect(page.getByRole('button', { name: 'Connect to a frame' })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});


test('Bluetooth setup returns the device address to the frame app', async ({page}) => {
  await mockBluetooth(page);
  await page.goto('/setup/?return=frame');
  await credentials(page);
  await page.getByRole('button', {name: 'Connect to WiFi'}).click();
  await expect(page.locator('#device-link')).toHaveAttribute('href', '/frame/#device=http%3A%2F%2Finky-soup.local%3A8000%2F');
  await expect(page.locator('#device-interface-link')).toHaveAttribute('href', 'http://inky-soup.local:8000/');
  await expect(page.locator('#password')).toHaveValue('');
});
