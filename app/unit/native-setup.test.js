import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NativeSetup, wifiPacket} from '../frame/services/native-setup.js';
import {encodeRequest, decodeResponse} from '../setup/improv-client.js';

const data = bytes => Buffer.from(bytes).toString('base64');
const pause = () => new Promise(resolve => setTimeout(resolve, 5));
const later = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
function fixture(options = {}) {
  const events = [], calls = [], connections = [];
  let listener, nativeSession, phase = 2, error = 0;
  const bridge = {
    async addListener(_, callback) { listener = callback; return {remove: async () => {listener = null;}}; },
    async scan({session}) {nativeSession = session; calls.push(['scan', session]);},
    async connect(args) {calls.push(['connect', args]);},
    async cancel(args) {calls.push(['cancel', args]);},
    async read({kind}) {calls.push(['read', kind]); return {data: data(kind === 'state' ? [phase] : kind === 'error' ? [error] : encodeRequest(1, ['http://192.168.1.149:8000']))};},
    async write(args) {calls.push(['write', args]); phase = 3;},
  };
  const client = new NativeSetup({bridge, onStatus: event => events.push(event), pollInterval: 2, timeout: 1000,
    normalize: value => {if (!value.startsWith('http://192.168.')) throw new Error('Unsafe address'); return value;},
    connect: async (url, signal) => {connections.push(url); signal.throwIfAborted();}, ...options});
  const emit = (type, rest = {}, session = nativeSession) => listener?.({session, type, ...rest});
  const value = (kind, bytes, session) => emit('value', {kind, data: data(bytes)}, session);
  const ready = async () => {await client.listen(); await client.scan(); emit('device', {id: 'one', name: 'Small frame'}); await client.select('one');};
  return {client, bridge, events, calls, connections, emit, value, ready, set: (state, code = 0) => {phase = state; error = code;}};
}

test('Improv credentials use UTF-8 byte limits, one packet, and the existing checksum', () => {
  for (const [ssid, password] of [['家'.repeat(10) + 'ab', 'é'.repeat(32)], ['a'.repeat(32), 'b'.repeat(64)], ['Open', '']]) {
    const packet = wifiPacket(ssid, password);
    assert.deepEqual(decodeResponse(new DataView(packet.buffer)), {command: 1, values: [ssid, password]});
    assert.ok(packet.length <= 101);
  }
  for (const [ssid, password] of [['家'.repeat(11), ''], ['', ''], ['Test', 'é'.repeat(33)]]) assert.throws(() => wifiPacket(ssid, password));
  assert.throws(() => decodeResponse(new DataView(new Uint8Array([1, 2, 9, 0, 12]).buffer)));
});

test('discovery requires explicit selection and preserves distinct duplicate names', async () => {
  const f = fixture(); await f.client.listen(); await f.client.scan();
  f.emit('device', {id: 'one', name: 'Inky'}); f.emit('device', {id: 'two', name: 'Inky'});
  assert.equal(f.events.at(-1).devices.length, 2);
  assert.equal(f.calls.filter(([method]) => method === 'connect').length, 0);
  await f.client.select('unknown'); await f.client.select('two');
  assert.equal(f.calls.find(([method]) => method === 'connect')[1].device, 'two');
  assert.equal(f.events.at(-1).phase, 'ready'); await f.client.destroy();
});

test('early success waits for acknowledged write and a real API connection', async () => {
  const connected = later(); const f = fixture({connect: () => connected.promise}); await f.ready();
  const written = later();
  f.bridge.write = async () => {f.value('result', encodeRequest(1, ['http://192.168.1.149:8000'])); await written.promise;};
  const provision = f.client.provision('Wifi', 'secret'); await pause();
  assert.equal(f.events.at(-1).phase, 'provisioning');
  written.resolve(); await pause(); assert.equal(f.events.at(-1).phase, 'checking');
  connected.resolve(); await provision; assert.equal(f.events.at(-1).phase, 'success'); await f.client.destroy();
});

test('older firmware can finish through serialized state/result polling', async () => {
  const f = fixture(); await f.ready(); f.bridge.write = async () => {f.set(4);};
  await f.client.provision('Wifi', 'secret');
  assert.equal(f.events.at(-1).phase, 'success'); assert.equal(f.connections.length, 1); await f.client.destroy();
});

test('wrong password ends the GATT session, and an old notification cannot affect retry', async () => {
  const f = fixture(); await f.ready(); const old = f.client.attempt.id;
  f.bridge.write = async () => {f.value('error', [3]);};
  await f.client.provision('Wifi', 'wrong');
  assert.equal(f.events.at(-1).phase, 'error'); assert.match(f.events.at(-1).message, /password/);
  await f.client.scan(); f.emit('device', {id: 'one', name: 'Small frame'}); await f.client.select('one');
  f.value('error', [4], old); f.value('result', encodeRequest(1, ['http://192.168.1.99:8000']), old);
  f.bridge.write = async () => {f.value('result', encodeRequest(1, ['http://192.168.1.149:8000']));};
  await f.client.provision('Wifi', 'right'); assert.deepEqual(f.connections, ['http://192.168.1.149:8000']); await f.client.destroy();
});

test('cancel during connect ignores its late completion, even for the same peripheral', async () => {
  const f = fixture(); await f.client.listen(); await f.client.scan(); f.emit('device', {id: 'one', name: 'Small'});
  const old = later(); f.bridge.connect = () => old.promise;
  const connecting = f.client.select('one'); await f.client.cancel();
  f.bridge.connect = async () => {};
  await f.client.scan(); f.emit('device', {id: 'one', name: 'Small'}); await f.client.select('one');
  old.resolve(); await connecting; assert.equal(f.events.at(-1).phase, 'ready'); await f.client.destroy();
});

test('cancelled provisioning and late read failure leave the next attempt alone', async () => {
  const f = fixture(); await f.ready(); const pendingRead = later(); const read = f.bridge.read;
  f.bridge.read = args => args.kind === 'error' ? pendingRead.promise : read(args);
  const provisioning = f.client.provision('Wifi', 'secret'); await pause();
  await f.client.cancel(); await provisioning;
  f.bridge.read = read; f.set(2); await f.client.scan(); f.emit('device', {id: 'one', name: 'Small'}); await f.client.select('one');
  pendingRead.reject(new Error('Abandoned read')); await pause();
  assert.equal(f.events.at(-1).phase, 'ready'); await f.client.destroy();
});

for (const [name, run] of [
  ['permission denied', f => {f.bridge.scan = async () => {throw new Error('Allow Nearby devices');};}],
  ['Bluetooth off', f => {f.bridge.scan = async () => {throw new Error('Bluetooth is off');};}],
]) test(`${name} allows a fresh scan`, async () => {
  const f = fixture(); await f.client.listen(); const scan = f.bridge.scan; run(f);
  await f.client.scan(); assert.equal(f.events.at(-1).phase, 'error');
  f.bridge.scan = scan; await f.client.scan(); assert.equal(f.events.at(-1).phase, 'scanning'); await f.client.destroy();
});

for (const mode of ['expiry', 'disconnect', 'timeout', 'unsafe']) test(`${mode} closes setup without reporting success`, async () => {
  const f = fixture({timeout: 20}); await f.ready();
  f.bridge.write = async () => {
    if (mode === 'expiry') f.value('state', [1]);
    if (mode === 'disconnect') f.emit('error', {message: 'Bluetooth disconnected'});
    if (mode === 'unsafe') f.value('result', encodeRequest(1, ['https://evil.example/']));
  };
  await f.client.provision('Wifi', 'secret');
  assert.equal(f.events.at(-1).phase, 'error'); assert.deepEqual(f.connections, []);
  assert.ok(f.calls.some(([method]) => method === 'cancel')); await f.client.destroy();
});

test('failed API handoff retries the address without writing credentials again', async () => {
  let attempts = 0;
  const f = fixture({connect: async () => {if (++attempts === 1) throw new Error('No local WiFi');}}); await f.ready();
  f.bridge.write = async () => {f.value('result', encodeRequest(1, ['http://192.168.1.149:8000']));};
  await f.client.provision('Wifi', 'secret'); assert.equal(f.events.at(-1).phase, 'unreachable');
  f.emit('error', {message: 'Late Bluetooth disconnect'});
  assert.equal(f.events.at(-1).phase, 'unreachable');
  await f.client.confirm(); assert.equal(f.events.at(-1).phase, 'success'); assert.equal(attempts, 2); await f.client.destroy();
});

test('cancel during API verification aborts it and suppresses late success', async () => {
  const api = later(); let signal;
  const f = fixture({connect: (_, abort) => {signal = abort; return api.promise;}}); await f.ready();
  f.bridge.write = async () => {f.value('result', encodeRequest(1, ['http://192.168.1.149:8000']));};
  const pending = f.client.provision('Wifi', 'secret'); await pause(); await f.client.cancel();
  assert.equal(signal.aborted, true); api.resolve(); await pending;
  assert.equal(f.events.at(-1).phase, 'idle'); await f.client.destroy();
});

test('late native cancellation completion does not reset a newer scan', async () => {
  const f = fixture(); await f.ready();
  const old = later(); let count = 0;
  f.bridge.cancel = () => ++count === 1 ? old.promise : Promise.resolve();
  const cancelling = f.client.cancel();
  await f.client.scan(); old.resolve(); await cancelling;
  assert.equal(f.events.at(-1).phase, 'scanning'); await f.client.destroy();
});

test('native failure while connect is pending cannot reopen the credential form', async () => {
  const f = fixture(); await f.client.listen(); await f.client.scan(); f.emit('device',{id:'one',name:'Small'});
  const old = later(); f.bridge.connect = () => old.promise;
  const connecting = f.client.select('one'); f.emit('error',{message:'Bluetooth disconnected'});
  old.resolve(); await connecting; assert.equal(f.events.at(-1).phase,'error'); await f.client.destroy();
});

test('closing setup while a rescan is waiting for native cleanup cannot restart discovery', async () => {
  const f = fixture(); await f.ready();
  const old = later(); f.bridge.cancel = () => old.promise;
  const scanning = f.client.scan(); await f.client.cancel();
  old.resolve(); await scanning;
  assert.equal(f.client.attempt,null);
  assert.equal(f.calls.filter(([method]) => method === 'scan').length,1);
  assert.equal(f.events.at(-1).phase,'idle'); await f.client.destroy();
});

test('late BLE events cannot abort API verification after an accepted handoff', async () => {
  const api = later(); let signal;
  const f = fixture({connect: (_, abort) => {signal = abort; return api.promise;}}); await f.ready();
  f.bridge.write = async () => {f.value('result', encodeRequest(1, ['http://192.168.1.149:8000']));};
  const provisioning = f.client.provision('Wifi', 'secret'); await pause();
  assert.equal(f.events.at(-1).phase, 'checking');
  f.emit('error', {message: 'Bluetooth disconnected'});
  f.value('state', [1]);
  api.resolve(); await provisioning;
  assert.equal(signal.aborted, false);
  assert.equal(f.events.at(-1).phase, 'success'); await f.client.destroy();
});
