import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeAddress,validateConfig,savePhoto} from '../frame/services/frame-client.js';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

test('frame address accepts local hosts and rejects public URLs and embedded credentials',()=>{
  assert.equal(normalizeAddress('inky-soup.local'),'http://inky-soup.local:8000');
  assert.equal(normalizeAddress('192.168.1.109:8000'),'http://192.168.1.109:8000');
  assert.equal(normalizeAddress('http://frame.local:80'),'http://frame.local');
  assert.equal(normalizeAddress('https://frame.local:443'),'https://frame.local');
  for(const address of ['https://example.com','http://user:secret@frame.local','http://frame.local/page','http://frame.local/?q=1','javascript:alert(1)','http://172.32.0.1']) assert.throws(()=>normalizeAddress(address));
});
test('unknown model or mismatched dimensions cannot reach the image processor',()=>{
  assert.throws(()=>validateConfig({model:'unknown',width:1600,height:1200}));
  assert.throws(()=>validateConfig({model:'impression-13.3-2025',width:1200,height:1600}));
});
test('both panels accept four mount orientations with logical dimensions and a durable revision', () => {
  for (const [model, width, height] of [['impression-13.3-2025',1600,1200],['impression-5.7',600,448]]) {
    for (const rotation of [0,90,180,270]) {
      const portrait = rotation === 90 || rotation === 270;
      const config = {model, physical_width:width, physical_height:height,
        width:portrait ? height : width, height:portrait ? width : height,
        rotation_degrees:rotation, rotation_revision:12};
      assert.equal(validateConfig(config).orientation_supported, true);
      for (const invalid of [{rotation_degrees:45},{rotation_revision:-1},{rotation_revision:1.5}, {width:42}]) {
        assert.throws(() => validateConfig({...config,...invalid}));
      }
    }
    assert.equal(validateConfig({model,width,height}).orientation_supported, false);
  }
});
test('shared image processing files retain their pinned source hashes',()=>{
  const source=JSON.parse(readFileSync(new URL('../public/frame/vendor/source.json',import.meta.url)));
  for(const file of source.files){const name=file.path.split('/').pop();assert.equal(createHash('sha256').update(readFileSync(new URL(`../public/frame/vendor/${name}`,import.meta.url))).digest('hex'),file.sha256);}
});

function olderFrame(t) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const path = new URL(url).pathname;
    requests.push({path, body:options.body});
    if (path === '/api/lock-image') return Response.json({locked:true});
    if (path === '/upload') return Response.json({success:true,filename:options.body.get('submission.file').name});
    if (['/api/upload-cache','/api/upload-thumb','/api/upload-dithered','/api/unlock-image'].includes(path)) {
      return Response.json({success:true});
    }
    return Response.json({message:'Unsupported route'}, {status:404});
  });
  const blob = new Blob(['original photo bytes'], {type:'image/png'});
  return {requests, blob, prepared:{cache:blob,thumb:blob,dithered:blob,rotation_revision:0,photo_rotation_degrees:0}};
}

for (const capability of [undefined, false]) {
  test(`copying a 0° photo to older firmware succeeds on its first save (capability ${capability})`, async t => {
    const {requests,blob,prepared} = olderFrame(t);
    if (capability !== undefined) prepared.photo_rotation_supported = capability;
    const base = 'http://older-frame.local:8000';
    let draft = {blob, sourceFrame:'http://source-frame.local:8000', sourceFilename:'photo.png',
      photo_rotation_degrees:0, photo_rotation_revision:4, brightness:25,
      pending_photo_rotation:{operation_id:'source-operation'}};
    const saved = await savePhoto({base,draft,prepared,session:'test',
      onStored:({base,filename,...checkpoint}) => {
        draft = {...draft,sourceFrame:base,sourceFilename:filename,...checkpoint};
      }});
    assert.deepEqual(requests.map(r=>r.path), ['/api/lock-image','/upload',
      '/api/upload-cache','/api/upload-thumb','/api/upload-dithered','/api/unlock-image']);
    assert.notEqual(saved.filename, 'photo.png');
    assert.equal(saved.base, base);
    assert.equal(await requests[1].body.get('submission.file').text(), 'original photo bytes');
    for (const upload of requests.slice(2,5)) {
      assert.equal(upload.body.get('filename'), saved.filename);
      assert.equal(upload.body.get('brightness'), '25');
      assert.ok([null,'0'].includes(upload.body.get('photo_rotation_revision')));
    }
    assert.equal(draft.sourceFilename, saved.filename);
    assert.equal(draft.photo_rotation_revision, 0);
    assert.equal(draft.pending_photo_rotation, null);
  });
}

for (const existing of [false, true]) {
  test(`older firmware still rejects ${existing ? 'an existing photo with a rotation revision' : 'a rotated photo copy'}`, async t => {
    const {requests,blob,prepared} = olderFrame(t);
    const base = 'http://older-frame.local:8000';
    const angle = existing ? 0 : 90;
    prepared.photo_rotation_degrees = angle;
    prepared.photo_rotation_supported = false;
    const draft = {blob,sourceFrame:existing ? base : 'http://source-frame.local:8000',
      sourceFilename:'photo.png',photo_rotation_degrees:angle,photo_rotation_revision:4};
    await assert.rejects(savePhoto({base,draft,prepared,session:'test'}), /Update the frame software/);
    assert.equal(requests.filter(r=>r.path.startsWith('/api/upload-')).length, 0);
    assert.equal(requests.at(-1).path, '/api/unlock-image');
  });
}
