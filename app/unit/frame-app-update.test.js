import test from 'node:test';
import assert from 'node:assert/strict';
import {updateBlockReason} from '../frame/core/app-update.js';

test('updates wait for edits, connections, image processing, and display jobs', () => {
  const idle = {imports: []};
  assert.equal(updateBlockReason(idle), '');
  for (const key of ['busy', 'connecting', 'importing', 'processing', 'job']) {
    assert.notEqual(updateBlockReason({...idle, [key]: true}), '', key);
  }
});

test('unsaved batch photos block reload, but completed imports and resumable rebuilds do not', () => {
  assert.notEqual(updateBlockReason({imports: [{status:'Failed', draft:{blob:{}}}]}), '');
  assert.equal(updateBlockReason({imports: [{status:'Saved'}]}), '');
  assert.equal(updateBlockReason({imports: [{status:'Failed', regenerate:true}]}), '');
});
