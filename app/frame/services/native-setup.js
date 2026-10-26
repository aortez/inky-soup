import {decodeResponse, encodeRequest} from '../../setup/improv-client.js';

const errors = {
  1: 'The frame could not read the WiFi settings. Scan again and retry.',
  2: 'This frame does not support WiFi setup. Update its firmware.',
  3: 'Could not join WiFi. Check the network name and password, then scan again to retry.',
  4: 'Setup has closed. Open a new setup window on the frame, then scan again.',
};
const cancelled = () => new Error('Setup cancelled. Scan again when ready.');
const bytes = data => Uint8Array.from(atob(data), character => character.charCodeAt(0));
const dataView = data => new DataView(data.buffer, data.byteOffset, data.byteLength);

export function wifiPacket(ssid, password) {
  const encoder = new TextEncoder();
  if (!ssid || encoder.encode(ssid).length > 32) throw new Error('Enter a network name of 1–32 UTF-8 bytes.');
  if (encoder.encode(password).length > 64) throw new Error('Enter a WiFi password of at most 64 UTF-8 bytes.');
  return encodeRequest(1, [ssid, password]);
}

// Each attempt owns its native session, timers, callbacks, and API cancellation.
// The bridge is injected so the same controller can be exercised without Bluetooth hardware.
export class NativeSetup {
  constructor({bridge, normalize, connect, onStatus, timeout = 65000, pollInterval = 1000}) {
    Object.assign(this, {bridge, normalize, connect, onStatus, timeout, pollInterval});
    this.attempt = null;
    this.generation = 0;
  }

  async listen() {
    this.listener = await this.bridge.addListener('ble', event => this.receive(event));
  }

  active(attempt) { return this.attempt === attempt && !attempt.abort.signal.aborted; }
  check(attempt) { if (!this.active(attempt)) throw cancelled(); }
  show(attempt, phase, detail = {}) {
    if (!this.active(attempt)) return;
    attempt.phase = phase;
    this.onStatus({phase, name: attempt.name, ...detail});
  }

  async scan() {
    const generation = await this.cancel(false);
    if (generation !== this.generation) return;
    const attempt = {id: crypto.randomUUID(), abort: new AbortController(), devices: new Map()};
    this.attempt = attempt;
    this.show(attempt, 'scanning');
    try { await this.bridge.scan({session: attempt.id}); }
    catch (error) { await this.fail(attempt, error); }
  }

  async select(id) {
    const a = this.attempt;
    if (!a || !['scanning', 'select'].includes(a.phase) || !a.devices.has(id)) return;
    a.name = a.devices.get(id).name;
    this.show(a, 'connecting');
    try {
      await this.bridge.connect({session: a.id, device: id});
      this.check(a);
      const state = await this.read(a, 'state');
      this.requireReady(state);
      this.show(a, 'ready');
    } catch (error) { await this.fail(a, error); }
  }

  requireReady(state) {
    if (state[0] === 3) throw new Error('The frame is still trying the previous WiFi settings. Wait a minute, then scan again.');
    if (state[0] !== 2) throw new Error(errors[4]);
  }

  async read(a, kind) {
    this.check(a);
    const result = await this.bridge.read({session: a.id, kind});
    this.check(a);
    return bytes(result.data);
  }

  receive(event) {
    const a = this.attempt;
    if (!a || event.session !== a.id || !this.active(a)) return;
    // After the acknowledged write and validated handoff, BLE is finished. Queued
    // disconnect/status events must not cancel HTTP verification or its retry.
    if (a.url) return;
    if (event.type === 'error') { void this.fail(a, new Error(event.message)); return; }
    if (event.type === 'device' && ['scanning', 'select'].includes(a.phase)) {
      a.devices.set(event.id, {id: event.id, name: event.name, rssi: event.rssi});
      this.show(a, a.phase, {devices: [...a.devices.values()]});
    }
    if (event.type === 'scanDone' && a.phase === 'scanning') this.show(a, 'select', {devices: [...a.devices.values()]});
    if (event.type === 'value') {
      try { this.value(a, event.kind, bytes(event.data)); }
      catch (error) { void this.fail(a, error); }
    }
  }

  value(a, kind, value) {
    if (!value.length) return;
    if (kind === 'state' && value[0] === 1 && ['ready', 'provisioning'].includes(a.phase)) {
      if (a.feedback) a.feedback.reject(new Error(errors[4]));
      else void this.fail(a, new Error(errors[4]));
    }
    if (!a.feedback || a.phase !== 'provisioning') return;
    if (kind === 'error' && value[0]) a.feedback.reject(new Error(errors[value[0]] || 'WiFi setup failed. Scan again to retry.'));
    if (kind === 'result') {
      const result = decodeResponse(dataView(value));
      if (result.command !== 1) return;
      if (!result.values[0]) throw new Error('The frame joined WiFi but did not return an address. Try its address from your router.');
      // Use exactly the selected provisioner's handoff, subject to the direct-Pi address policy.
      a.feedback.resolve(this.normalize(result.values[0]));
    }
  }

  async provision(ssid, password) {
    const a = this.attempt;
    if (!a || a.phase !== 'ready') return;
    let packet;
    try { packet = wifiPacket(ssid, password); }
    catch (error) { this.show(a, 'ready', {message: error.message}); return; }
    this.show(a, 'provisioning');
    let timer, pollTimer, finished = false;
    const result = new Promise((resolve, reject) => {
      a.feedback = {
        resolve: value => { if (!finished) { finished = true; resolve(value); } },
        reject: error => { if (!finished) { finished = true; reject(error); } },
      };
    });
    // Notifications can arrive before the acknowledged write completes.
    result.catch(() => {});
    const poll = async () => {
      try {
        if (!this.active(a) || finished) return;
        this.value(a, 'error', await this.read(a, 'error'));
        if (finished) return;
        const state = await this.read(a, 'state');
        this.value(a, 'state', state);
        if (!finished && state[0] === 4) this.value(a, 'result', await this.read(a, 'result'));
      } catch (error) { a.feedback?.reject(error); }
      finally { if (this.active(a) && !finished) pollTimer = setTimeout(poll, this.pollInterval); }
    };
    try {
      timer = setTimeout(() => a.feedback?.reject(new Error('WiFi setup timed out. Check the network, open setup on the frame, then scan again.')), this.timeout);
      this.requireReady(await this.read(a, 'state'));
      // No credential persistence, console output, URL parameters, or analytics.
      const writing = this.bridge.write({session: a.id, data: btoa(String.fromCharCode(...packet))});
      packet.fill(0); packet = null; ssid = ''; password = '';
      await writing;
      this.check(a);
      if (!finished) pollTimer = setTimeout(poll, this.pollInterval);
      a.url = await result;
      this.check(a);
      a.feedback = null;
      await this.bridge.cancel({session: a.id});
      this.check(a);
      await this.confirm(a);
    } catch (error) { await this.fail(a, error); }
    finally {
      packet?.fill(0); clearTimeout(timer); clearTimeout(pollTimer);
      a.feedback = null;
    }
  }

  async confirm(a = this.attempt) {
    if (!a?.url || !this.active(a) || !['provisioning', 'unreachable'].includes(a.phase)) return;
    this.show(a, 'checking');
    try {
      await this.connect(a.url, a.abort.signal);
      this.check(a);
      this.show(a, 'success', {url: a.url});
    } catch (error) {
      if (this.active(a)) this.show(a, 'unreachable', {message: `WiFi setup finished, but the app could not reach the frame. Keep your phone on the same WiFi and retry. ${error.message}`});
    }
  }

  async fail(a, error) {
    if (!this.active(a) || a.phase === 'error') return;
    a.feedback?.reject(error);
    this.show(a, 'error', {message: error.message});
    a.abort.abort();
    await this.bridge.cancel({session: a.id}).catch(() => {});
  }

  async cancel(show = true) {
    const generation = ++this.generation;
    const a = this.attempt;
    this.attempt = null;
    if (a) {
      a.abort.abort(); a.feedback?.reject(cancelled());
      await this.bridge.cancel({session: a.id}).catch(() => {});
    }
    if (show && generation === this.generation) this.onStatus({phase: 'idle', message: 'Setup cancelled. You can scan again when ready.'});
    return generation;
  }

  async destroy() { await this.cancel(false); await this.listener?.remove(); }
}
