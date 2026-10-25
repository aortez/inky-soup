import {test} from 'node:test';
import assert from 'node:assert/strict';
import {savePhoto} from '../frame/services/frame-client.js';

// Regression: a rotated gallery photo must retain its angle/revision when sent
// by a client that isn't changing the angle, including after a lost API response.
test('photo rotation checkpoint survives an ambiguous response and retries the same operation', async () => {
  const originalFetch = globalThis.fetch;
  const base = 'http://192.168.1.2:8000';
  let draft = {blob:new Blob(['original'], {type:'image/png'}), sourceFrame:base, sourceFilename:'photo.png',
    photo_rotation_degrees:90, photo_rotation_revision:3};
  const prepared = {cache:new Blob(['cache']), thumb:new Blob(['thumb']), dithered:new Blob(['pixels']),
    rotation_revision:7, photo_rotation_degrees:90, photo_rotation_supported:true};
  const rotations = [], uploads = [];
  let fail = true;
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('/api/lock-image')) return Response.json({locked:true});
    if (url.endsWith('/api/unlock-image')) return Response.json({unlocked:true});
    if (url.endsWith('/api/settings/photo-rotation')) {
      const body = JSON.parse(options.body); rotations.push(body);
      if (fail) {fail = false; throw new TypeError('response lost');}
      return Response.json({photo_rotation_revision:4});
    }
    if (url.includes('/api/upload-')) {
      uploads.push(options.body);
      return Response.json({success:true});
    }
    throw new Error(`Unexpected request ${url}`);
  };
  const onStored = async ({base,filename,...saved}) => {draft={...draft,...saved,sourceFrame:base,sourceFilename:filename};};
  try {
    await assert.rejects(savePhoto({base,draft,prepared,session:'editor',onStored}), /Cannot reach/);
    assert.equal(draft.pending_photo_rotation.operation_id, rotations[0].operation_id);
    assert.equal(uploads.length, 0);
    await savePhoto({base,draft,prepared,session:'editor',onStored});
    assert.deepEqual(rotations[1], rotations[0]);
    assert.equal(draft.pending_photo_rotation, null);
    assert.equal(draft.photo_rotation_revision, 4);
    assert.equal(uploads.length, 3);
    for (const body of uploads) {
      assert.equal(body.get('photo_rotation_revision'), '4');
      assert.equal(body.get('rotation_revision'), '7');
      assert.equal(body.get('session_id'), 'editor');
    }
  } finally {globalThis.fetch=originalFetch;}
});
