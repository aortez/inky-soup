import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeAddress,validateConfig} from '../frame/services/frame-client.js';
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
