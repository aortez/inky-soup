import {test} from 'node:test';
import assert from 'node:assert/strict';
import {savedJobs} from '../frame/core/saved-jobs.js';

const first = {deviceId:'a'.repeat(32),instanceId:'c'.repeat(32),id:7,filename:'photo.jpg'};
const second = {...first,deviceId:'b'.repeat(32),id:8};
function storage() {
  const entries = new Map();
  return {getItem:key=>entries.get(key) ?? null, setItem:(key,value)=>entries.set(key,value), removeItem:key=>entries.delete(key)};
}

test('a new frame job preserves the migrated receipt for an unavailable frame',()=>{
  const disk = storage(); disk.setItem('sparkle-job',JSON.stringify(first));
  const jobs = savedJobs(disk);
  assert.equal(jobs.get(second.deviceId),null);
  jobs.put(second);
  const reopened = savedJobs(disk);
  assert.deepEqual(reopened.get(first.deviceId),first);
  assert.deepEqual(reopened.get(second.deviceId),second);
  reopened.remove(second.deviceId);
  assert.deepEqual(savedJobs(disk).get(first.deviceId),first);
  assert.equal(savedJobs(disk).get(second.deviceId),null);
  assert.equal(disk.getItem('sparkle-job'),null);
});
test('forgetting one frame preserves another receipt and does not resurrect the forgotten job',()=>{
  const disk = storage(), jobs = savedJobs(disk);
  jobs.put(first); jobs.put(second); jobs.remove(first.deviceId);
  assert.equal(savedJobs(disk).get(first.deviceId),null);
  assert.deepEqual(savedJobs(disk).get(second.deviceId),second);
  jobs.remove(second.deviceId);
  assert.equal(savedJobs(disk).get(second.deviceId),null);
});
test('updating a job receipt preserves its peer and the newest status across restart',()=>{
  const disk = storage(), jobs = savedJobs(disk);
  jobs.put(first); jobs.put(second);
  const moved = {...first,base:'http://192.168.1.9:8000',createdAt:123};
  jobs.put(moved);
  assert.deepEqual(savedJobs(disk).get(first.deviceId),moved);
  assert.deepEqual(savedJobs(disk).get(second.deviceId),second);
});
test('address-only legacy jobs remain available for explicit expiry',()=>{
  const disk = storage(), old = {id:1,base:'http://192.168.1.2:8000'};
  disk.setItem('sparkle-job',JSON.stringify(old));
  const jobs = savedJobs(disk);
  assert.deepEqual(jobs.get(first.deviceId),old);
  jobs.remove(first.deviceId);
  assert.equal(jobs.get(first.deviceId),null);
});
