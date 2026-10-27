import test from 'node:test';
import assert from 'node:assert/strict';
import {allowed, begin, end} from '../frame/core/operations.js';

const idle = {imports: []};
const tasks = ['choose', 'delete', 'forget', 'import', 'lock', 'open', 'orientation', 'store', 'test-card', 'update'];
const connections = ['connect', 'discover', 'reconnect', 'select-frame'];
const names = [...tasks, ...connections, 'adjust', 'preview-profile', 'refresh', 'setup'].sort();
const permitted = held => names.filter(name => allowed({...idle, ...held}, name));

test('tasks and connections keep separate slots, and a running task holds back everything', () => {
  for (const [list, slot, running] of [[tasks, 'operation', 'busy'], [connections, 'connection', 'connecting']]) {
    for (const name of list) {
      const state = {}; begin(state, name);
      assert.deepEqual(state, {[slot]: name}, name);
      end(state, name);
      assert.deepEqual(state, {[slot]: null}, name);
      assert.equal(allowed({...idle, [running]: true}, name), false, name);
    }
  }
  assert.deepEqual(permitted({busy: true}), []);
});

test('editing and work that needs a connected frame go on while a frame connects', () => {
  assert.deepEqual(permitted({connecting: true}), ['adjust', 'choose', 'delete', 'import', 'lock', 'refresh', 'setup']);
});

test('a display job holds back everything except connecting again to follow it', () => {
  assert.deepEqual(permitted({job: {id: 7}}), ['reconnect']);
});

test('saving waits for the preview, and updates also wait for photos not yet added', () => {
  assert.deepEqual(names.filter(name => !permitted({processing: true}).includes(name)), ['store', 'update']);
  assert.deepEqual(names.filter(name => !permitted({imports: [{status: 'Failed', draft: {}}]}).includes(name)), ['update']);
  assert.deepEqual(names.filter(name => !permitted({imports: [{status: 'Failed', regenerate: true}]}).includes(name)), []);
});
