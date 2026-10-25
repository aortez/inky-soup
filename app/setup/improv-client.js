// Improv BLE transport. Credentials stay in memory and are sent only to the selected device.
export const SERVICE_UUID = '00467768-6228-2272-4663-277478268000';
const characteristic = (suffix) => `00467768-6228-2272-4663-27747826800${suffix}`;
const messages = {
  1: 'The device could not read the setup request. Reconnect and try again.',
  2: 'This device does not support that setup command.',
  3: 'Could not join WiFi. Check the network name and password, then try again.',
  4: 'Setup has closed. Open a new setup window on the device, then reconnect.',
};

export function encodeRequest(command, strings) {
  const encoder = new TextEncoder();
  const data = strings.flatMap((value) => {
    const bytes = [...encoder.encode(value)];
    if (bytes.length > 255) throw new Error('Setup value is too long.');
    return [bytes.length, ...bytes];
  });
  if (data.length > 255) throw new Error('Setup request is too long.');
  const bytes = [command, data.length, ...data];
  return new Uint8Array([...bytes, bytes.reduce((sum, byte) => (sum + byte) & 255, 0)]);
}

export function decodeResponse(value) {
  const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (bytes.length < 3 || bytes.length !== bytes[1] + 3
      || bytes.slice(0, -1).reduce((sum, byte) => (sum + byte) & 255, 0) !== bytes.at(-1)) {
    throw new Error('The device returned an invalid setup response. Reconnect and try again.');
  }
  const values = [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let offset = 2; offset < bytes.length - 1;) {
    const length = bytes[offset++];
    if (offset + length > bytes.length - 1) throw new Error('Incomplete setup response.');
    values.push(decoder.decode(bytes.slice(offset, offset + length)));
    offset += length;
  }
  return { command: bytes[0], values };
}

export function deviceUrl(value) {
  if (!value) return null;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('The device returned an unsafe link.');
  }
  return url.href;
}

function bounded(promise, milliseconds) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Setup timed out. Reconnect and try again.')), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

export class ImprovClient {
  constructor({ bluetooth = navigator.bluetooth, onStatus = () => {}, requestTimeout = 65000 } = {}) {
    this.bluetooth = bluetooth;
    this.onStatus = onStatus;
    this.requestTimeout = requestTimeout;
    this.epoch = 0;
    this.pending = null;
    this.device = null;
  }

  async connect() {
    this.disconnect();
    const epoch = this.epoch;
    this.onStatus({ state: 'connecting' });
    try {
      const device = await this.bluetooth.requestDevice({ filters: [{ services: [SERVICE_UUID] }] });
      if (epoch !== this.epoch) return;
      this.device = device;
      device.addEventListener('gattserverdisconnected', () => {
        if (epoch !== this.epoch) return;
        this.disconnect();
        this.onStatus({ state: 'disconnected', message: 'Bluetooth disconnected. Reconnect to continue.' });
      });
      const connection = device.gatt.connect();
      // A cancelled connect may finish after a retry has reused this BluetoothDevice.
      // Clean up an abandoned device without closing the newer session on that device.
      connection.then(() => {
        if (epoch !== this.epoch && this.device !== device) device.gatt.disconnect();
      }, () => {});
      await bounded(connection, 15000);
      if (epoch !== this.epoch) return;
      const service = await bounded(device.gatt.getPrimaryService(SERVICE_UUID), 10000);
      if (epoch !== this.epoch) return;
      const chars = {};
      for (const [name, suffix] of [['state', 1], ['error', 2], ['command', 3], ['result', 4]]) {
        chars[name] = await bounded(service.getCharacteristic(characteristic(suffix)), 10000);
        if (epoch !== this.epoch) return;
      }
      this.chars = chars;
      for (const name of ['state', 'error', 'result']) {
        chars[name].addEventListener('characteristicvaluechanged', (event) => {
          if (epoch === this.epoch) this.receive(name, event.target.value);
        });
        await bounded(chars[name].startNotifications(), 10000);
        if (epoch !== this.epoch) return;
      }
      const state = await bounded(chars.state.readValue(), 10000);
      if (epoch !== this.epoch) return;
      if (state.getUint8(0) !== 2) throw new Error('Open a setup window on the device, then reconnect.');
      this.onStatus({ state: 'ready', name: device.name || 'Device' });
    } catch (error) {
      if (epoch !== this.epoch) return;
      this.disconnect();
      if (error.name === 'NotFoundError') this.onStatus({ state: 'idle', message: 'No device selected. Tap Connect when ready.' });
      else this.onStatus({ state: 'error', message: error.message });
    }
  }

  receive(kind, value) {
    if (!this.pending || value.byteLength === 0) return;
    if (kind === 'error') {
      const code = value.getUint8(0);
      if (code) this.pending.reject(new Error(messages[code] || `Device setup failed (${code}).`));
    } else if (kind === 'result') {
      try {
        const result = decodeResponse(value);
        if (result.command === 1) this.pending.resolve(deviceUrl(result.values[0]));
      } catch (error) {
        this.pending.reject(error);
      }
    }
  }

  async provision(ssid, password) {
    if (this.pending) throw new Error('A connection attempt is already in progress.');
    if (!this.device?.gatt.connected || !this.chars) throw new Error('Connect to a device first.');
    const encoder = new TextEncoder();
    if (!ssid || encoder.encode(ssid).length > 32) throw new Error('Enter a network name of 1–32 UTF-8 bytes.');
    if (encoder.encode(password).length > 64) throw new Error('WiFi password is too long.');
    const epoch = this.epoch;
    const chars = this.chars;
    let pollTimer;
    let timeoutTimer;
    let settled = false;
    const feedback = new Promise((resolve, reject) => {
      this.pending = {
        resolve: (url) => { settled = true; resolve(url); },
        reject: (error) => { settled = true; reject(error); },
      };
    });
    // Consume early failures while the GATT write is still completing.
    feedback.catch(() => {});
    const pending = this.pending;
    this.onStatus({ state: 'provisioning', name: this.device.name });
    const poll = async () => {
      try {
        if (epoch !== this.epoch || settled) return;
        const errorValue = await bounded(chars.error.readValue(), 5000);
        if (epoch !== this.epoch || this.pending !== pending) return;
        this.receive('error', errorValue);
        if (settled) return;
        const state = await bounded(chars.state.readValue(), 5000);
        if (epoch !== this.epoch || this.pending !== pending || settled) return;
        if (state.getUint8(0) === 1) this.pending?.reject(new Error(messages[4]));
        if (state.getUint8(0) === 4) {
          const result = await bounded(chars.result.readValue(), 5000);
          if (epoch === this.epoch && this.pending === pending) this.receive('result', result);
        }
      } catch (error) {
        if (epoch === this.epoch && this.pending === pending) pending.reject(error);
      } finally {
        if (epoch === this.epoch && this.pending === pending && !settled) pollTimer = setTimeout(poll, 1000);
      }
    };
    try {
      timeoutTimer = setTimeout(() => {
        if (epoch === this.epoch) {
          pending.reject(new Error('Setup timed out. Reconnect and try again.'));
          this.disconnect();
          this.onStatus({ state: 'error', message: 'Setup timed out. Reconnect and try again.' });
        }
      }, this.requestTimeout);
      const packet = encodeRequest(1, [ssid, password]);
      // Use one acknowledged write; BlueZ/ATT handles the negotiated MTU.
      const write = chars.command.writeValueWithResponse
        ? chars.command.writeValueWithResponse(packet) : chars.command.writeValue(packet);
      write.catch((error) => pending.reject(error));
      // Older provisioners lack state/error notifications. Poll only after the write completes,
      // avoiding concurrent GATT commands on Android and reads of the preceding attempt's error.
      write.then(() => { if (!settled && epoch === this.epoch) pollTimer = setTimeout(poll, 1000); }, () => {});
      const url = await feedback;
      if (epoch !== this.epoch) return;
      const name = this.device.name || 'Device';
      this.pending = null;
      this.disconnect();
      this.onStatus({ state: 'success', name, url });
      return url;
    } catch (error) {
      if (epoch === this.epoch) {
        this.onStatus({ state: 'retry', name: this.device?.name, message: error.message });
      }
      throw error;
    } finally {
      clearTimeout(pollTimer);
      clearTimeout(timeoutTimer);
      if (epoch === this.epoch) this.pending = null;
    }
  }

  disconnect() {
    this.epoch += 1;
    const pending = this.pending;
    this.pending = null;
    pending?.reject(new Error('Setup cancelled. Reconnect to continue.'));
    this.device?.gatt.disconnect();
    this.device = null;
    this.chars = null;
  }
}
