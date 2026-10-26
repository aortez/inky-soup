import {test} from 'node:test';
import assert from 'node:assert/strict';
import {frameRegistry, validateIdentity, draftForFrame, jobForFrame} from '../frame/core/frame-registry.js';
import {identifyFrame, locateFrame, discoverFrames} from '../frame/services/frame-discovery.js';

const a = {id:'a'.repeat(32),instance_id:'c'.repeat(32),name:'Small',base:'http://192.168.1.2:8000',api_version:1,capabilities:['device-identity-v1']};
const b = {...a,id:'b'.repeat(32),name:'Large'};
function storage() {const map = new Map(); return {getItem:key => map.get(key) ?? null,setItem:(key,value) => map.set(key,value)};}

test('registry persists multiple identities, selection and forget independently of photos', () => {
  const disk = storage(), first = frameRegistry(disk);
  first.remember(a); first.remember(b);
  const reopened = frameRegistry(disk);
  assert.equal(reopened.selected().id,b.id); assert.equal(reopened.list().length,2);
  reopened.select(a.id); assert.equal(first.selected().id,a.id);
  reopened.remember({...a,base:'http://192.168.1.3:8000'});
  assert.equal(first.list().length,2); assert.match(first.selected().base,/1.3/);
  reopened.forget(a.id); assert.equal(first.selected(),null); assert.deepEqual(first.list(),[b]);
});
test('identity and registry reject malformed values instead of trusting an IP', () => {
  assert.deepEqual(validateIdentity(a),a);
  for (const identity of [{...a,id:''},{...a,instance_id:undefined},{...a,capabilities:[]},null]) assert.throws(()=>validateIdentity(identity));
  assert.throws(()=>frameRegistry(storage()).remember({...a,id:''}));
});
test('IP reuse triggers discovery and only the remembered identity is accepted', async () => {
  const moved = {...a,base:'http://192.168.1.3:8000'};
  const bridge = {discover:async()=>({services:[{base:a.base},{base:moved.base}]})};
  const identify = async base => base === a.base ? b : moved;
  assert.deepEqual(await locateFrame(a,bridge,undefined,identify),moved);
  await assert.rejects(locateFrame(a,{discover:async()=>({services:[{base:a.base}]})},undefined,identify),/saved frame is unavailable/);
});
test('discovery tolerates stale services and deduplicates a multihomed frame', async () => {
  const result = await discoverFrames({discover:async()=>({services:[{base:'old'},{base:'wifi'},{base:'usb'}]})},undefined, async base=>{if(base==='old')throw Error('gone');return a;});
  assert.deepEqual(result,[a]);
});
test('cancellation cannot install a late discovery result', async () => {
  const controller = new AbortController();
  await assert.rejects(locateFrame(a,{discover:async()=>{controller.abort();return{services:[{base:'new'}]};}},controller.signal,async()=>b),{name:'AbortError'});
});
test('draft ownership and pending rotation follow identity, never a reused IP', () => {
  const draft = {sourceDeviceId:a.id,sourceFrame:a.base,sourceFilename:'photo.jpg',pending_photo_rotation:{base:a.base,operation_id:'receipt'}};
  const moved = {...a,base:'http://192.168.1.5:8000'};
  const rebound = draftForFrame(draft,moved);
  assert.equal(rebound.sourceFrame,moved.base); assert.equal(rebound.pending_photo_rotation.base,moved.base);
  const away = draftForFrame(draft,b); assert.equal(away.sourceFrame,null);
  assert.equal(draftForFrame(away,a).sourceFrame,a.base);
  assert.equal(draftForFrame({...draft,sourceDeviceId:undefined},b).sourceFilename,null);
});
test('job reconciliation changes address only for the same device and server lifetime', () => {
  const job = {id:1,deviceId:a.id,instanceId:a.instance_id,base:a.base};
  assert.equal(jobForFrame(job,{...a,base:'new'}).base,'new');
  assert.throws(()=>jobForFrame(job,b),/another frame/);
  assert.throws(()=>jobForFrame(job,{...a,instance_id:'d'.repeat(32)}),/restarted/);
  assert.throws(()=>jobForFrame({id:1,base:a.base},a),/predates/);
});


test('unreadable registries recover through a verified connection without touching other saved state', () => {
  for (const raw of ['{', 'null', '{"version":2,"frames":[]}', JSON.stringify({version:1,frames:[null]}), JSON.stringify({version:1,frames:[a,a]})]) {
    const disk = storage(); disk.setItem('sparkle-frames-v1', raw); disk.setItem('sparkle-job', 'keep job');
    const registry = frameRegistry(disk);
    assert.deepEqual(registry.list(), []); assert.equal(registry.selected(), null);
    assert.match(registry.notice, /Saved frame settings could not be read/);
    assert.equal(disk.getItem('sparkle-frames-v1'), raw);
    registry.remember(a);
    assert.deepEqual(registry.selected(), a); assert.equal(registry.notice, '');
    assert.equal(disk.getItem('sparkle-job'), 'keep job');
  }
});

test('identity probes support cancellation without AbortSignal.any', async t => {
  const any = AbortSignal.any; AbortSignal.any = undefined;
  try {
    const controller = new AbortController(); let requestSignal;
    t.mock.method(globalThis, 'fetch', async (url, {signal}) => {
      requestSignal = signal;
      return new Response(JSON.stringify(a));
    });
    assert.deepEqual(await identifyFrame(a.base, controller.signal), a);
    controller.abort();
    assert.equal(requestSignal.aborted, false, 'completed probes remove their abort listener');
    await assert.rejects(identifyFrame(a.base, controller.signal), {name:'AbortError'});
    const pending = new AbortController();
    t.mock.method(globalThis, 'fetch', async (url, {signal}) => {
      pending.abort();
      assert.equal(signal.aborted, true, 'caller cancellation reaches the request');
      return new Response(JSON.stringify(a));
    });
    await assert.rejects(identifyFrame(a.base, pending.signal), {name:'AbortError'});
  } finally {AbortSignal.any = any;}
});

test('identity probes abort a stalled request after four seconds', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let requestSignal;
  t.mock.method(globalThis, 'fetch', (url, {signal}) => {
    requestSignal = signal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), {once:true}));
  });
  const result = identifyFrame(a.base);
  const rejected = assert.rejects(result, /Cannot reach the frame/);
  t.mock.timers.tick(4000);
  await rejected; assert.equal(requestSignal.aborted, true);
});
