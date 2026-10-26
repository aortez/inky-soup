import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nativeTransport} from '../frame/services/native-transport.js';

function fakeBridge({status = 200, response = Buffer.from('{"ok":true}'), error, onAppend, onRequest} = {}) {
  const files = new Map();
  const history = [];
  let sequence = 0;
  const bridge = {
    async select(options) {history.push(['select', options]);},
    async create() {const id = String(++sequence); files.set(id, Buffer.alloc(0)); return {id};},
    async append({id, data}) {
      const bytes = Buffer.from(data, 'base64');
      assert.ok(bytes.length <= 65536);
      files.set(id, Buffer.concat([files.get(id), bytes]));
      onAppend?.();
    },
    async request(options) {
      history.push(['request', options, files.get(options.bodyId)]);
      if (error) throw error;
      await onRequest?.();
      files.set('response', response);
      return {id: 'response', size: response.length, status, contentType: 'application/octet-stream'};
    },
    async read({id, offset}) {return {data: files.get(id).subarray(offset, offset + 65536).toString('base64')};},
    async release({id}) {files.delete(id);},
    async cancel({id}) {history.push(['cancel', id]);},
  };
  return {bridge, files, history, adapter: nativeTransport(bridge)};
}

test('native multipart keeps file bytes, Unicode filename, and revision/session fields across chunks', async () => {
  const fake = fakeBridge();
  const bytes = new Uint8Array(3 * 65536 + 23).map((_, i) => i % 251);
  const form = new FormData();
  form.append('file', new Blob([bytes], {type: 'image/png'}), 'Frølich.png');
  form.append('session_id', 'session'); form.append('rotation_revision', '17');
  await fake.adapter.select('http://192.168.1.149:8000');
  await fake.adapter.fetch('http://192.168.1.149:8000', '/api/upload-cache', {method: 'POST', body: form});
  const [, options, body] = fake.history.find(item => item[0] === 'request');
  const parsed = await new Response(body, {headers: {'Content-Type': options.contentType}}).formData();
  assert.equal(parsed.get('file').name, 'Frølich.png');
  assert.deepEqual(new Uint8Array(await parsed.get('file').arrayBuffer()), bytes);
  assert.equal(parsed.get('rotation_revision'), '17');
  assert.equal(parsed.get('session_id'), 'session');
  assert.equal(fake.files.size, 0);
});

test('JSON and error status are preserved without retrying a rejected submission', async () => {
  const fake = fakeBridge({status:409, response:Buffer.from('{"message":"stale rotation"}')});
  const result = await fake.adapter.fetch('http://192.168.1.149:8000', '/flash', {
    method:'POST', headers:{'Content-Type':'application/json'}, body:'{"revision":7}',
  });
  assert.equal(result.status, 409);
  assert.equal((await result.json()).message, 'stale rotation');
  const requests = fake.history.filter(item => item[0] === 'request');
  assert.equal(requests.length, 1); assert.equal(requests[0][2].toString(), '{"revision":7}');
  assert.equal(fake.files.size, 0);
});

test('large binary response is reconstructed with bounded bridge reads', async () => {
  const bytes = Buffer.alloc(8 * 1024 * 1024 + 13, 201);
  const fake = fakeBridge({response: bytes});
  const response = await fake.adapter.fetch('http://192.168.1.149:8000', '/images/photo.jpg', {binary:true});
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  assert.equal(fake.files.size, 0);
});

test('abort during staging cleans up and does not start the request', async () => {
  const controller = new AbortController();
  const fake = fakeBridge({onAppend: () => controller.abort()});
  await assert.rejects(fake.adapter.fetch('http://192.168.1.149:8000', '/upload', {
    method:'POST', body:new Blob([new Uint8Array(200000)]), signal:controller.signal,
  }), {name:'AbortError'});
  assert.equal(fake.history.filter(item => item[0] === 'request').length, 0);
  assert.equal(fake.files.size, 0);
});

test('timeout or denied network releases staging and never retries an ambiguous flash', async () => {
  for (const message of ['Frame request timed out', 'Allow local-network access']) {
    const fake = fakeBridge({error: new Error(message)});
    await assert.rejects(fake.adapter.fetch('http://192.168.1.149:8000', '/flash', {method:'POST', body:'x'}), new RegExp(message));
    assert.equal(fake.history.filter(item => item[0] === 'request').length, 1);
    assert.equal(fake.files.size, 0);
  }
});

test('abort in flight calls native cancellation and releases a racing response', async () => {
  const controller = new AbortController();
  const fake = fakeBridge({onRequest: () => controller.abort()});
  await assert.rejects(fake.adapter.fetch('http://192.168.1.149:8000', '/api/images', {signal:controller.signal}), {name:'AbortError'});
  assert.equal(fake.history.filter(item => item[0] === 'cancel').length, 1);
  assert.equal(fake.files.size, 0);
});
