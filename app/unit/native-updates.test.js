import {test} from 'node:test';
import assert from 'node:assert/strict';
import {releaseManifestUrl} from '../frame/core/app-update.js';
import {checkForUpdate, downloadUpdate, installUpdate, installedApp, cancelDownload} from '../frame/services/native-updates.js';

const key = 'a'.repeat(64), digest = 'b'.repeat(64);
const installed = {applicationId:'pizza.allan.frame', versionName:'0.1.0', versionCode:1000, sdk:36, signingSha256:key, canInstall:true, downloadedSha256:null};
const release = {application_id:'pizza.allan.frame', version_name:'0.2.0', version_code:2000, min_sdk:24, apk_url:'https://github.com/aortez/inky-soup/releases/download/app-v0.2.0/frame.apk', apk_sha256:digest, apk_size:8_000_000, signing_sha256:key, notes:' Faster gallery. '};

function bridge(overrides = {}) {
  const calls = [];
  const listeners = {};
  const api = {
    calls, listeners,
    async installed() {calls.push(['installed']); return installed;},
    async check(options) {calls.push(['check', options]); return release;},
    async download(options) {calls.push(['download', options]); listeners.updateProgress?.({received:4_000_000, total:8_000_000}); return {};},
    async install(options) {calls.push(['install', options]); return {status:'launched'};},
    async cancel() {calls.push(['cancel']); return {};},
    async addListener(name, callback) {listeners[name] = callback; return {remove: async () => {delete listeners[name]; calls.push(['remove', name]);}};},
    ...overrides,
  };
  return api;
}

test('a newer compatible release is available, and a verified download is ready to install', async () => {
  const api = bridge();
  const result = await checkForUpdate(api);
  assert.equal(result.status, 'available');
  assert.equal(result.release.notes, 'Faster gallery.');
  assert.deepEqual(api.calls[1], ['check', {url: releaseManifestUrl}]);
  const ready = await checkForUpdate(bridge({async installed() {return {...installed, downloadedSha256: digest};}}), 'https://example.test/frame-release.json');
  assert.equal(ready.status, 'downloaded');
  assert.deepEqual((await installedApp(api)), installed);
});

test('same or older releases, other keys, other apps, and newer Android requirements are not offered', async () => {
  for (const [patch, status] of [[{version_code:1000}, 'current'], [{version_code:999}, 'current'], [{signing_sha256:'c'.repeat(64)}, 'incompatible'],
    [{application_id:'pizza.allan.other'}, 'incompatible'], [{min_sdk:37}, 'incompatible']]) {
    const result = await checkForUpdate(bridge({async check() {return {...release, ...patch};}}));
    assert.equal(result.status, status, JSON.stringify(patch));
    if (status === 'incompatible') assert.notEqual(result.reason, '');
  }
  // A verified file for an incompatible or current release is never reported as ready.
  const stale = await checkForUpdate(bridge({async installed() {return {...installed, downloadedSha256: digest};}, async check() {return {...release, version_code:1000};}}));
  assert.equal(stale.status, 'current');
});

test('malformed installed descriptions and release manifests are rejected without an update', async () => {
  await assert.rejects(checkForUpdate(bridge({async installed() {return {...installed, signingSha256:'nope'};}})), /installed app version/);
  for (const patch of [{apk_url:'http://example.test/frame.apk'}, {apk_sha256:'B'.repeat(64)}, {apk_size:0}, {apk_size:65 * 1024 * 1024},
    {version_name:'0.2'}, {version_code:'2000'}, {application_id:'frame'}, {notes:5}, {apk_url:'https://user:pw@example.test/frame.apk'}]) {
    await assert.rejects(checkForUpdate(bridge({async check() {return {...release, ...patch};}})), /update information/, JSON.stringify(patch));
  }
  await assert.rejects(checkForUpdate(bridge({async check() {throw new Error('offline');}})), /offline/);
});

test('downloads pass the verified release fields, relay progress, and always release the listener', async () => {
  const api = bridge();
  const progress = [];
  await downloadUpdate(api, release, (received, total) => progress.push([received, total]));
  assert.deepEqual(progress, [[4_000_000, 8_000_000]]);
  assert.deepEqual(api.calls.find(call => call[0] === 'download')[1], {url: release.apk_url, size: 8_000_000, sha256: digest});
  assert.deepEqual(api.calls.at(-1), ['remove', 'updateProgress']);
  const failing = bridge({async download() {throw new Error('Download interrupted.');}});
  await assert.rejects(downloadUpdate(failing, release), /interrupted/);
  assert.deepEqual(failing.calls.at(-1), ['remove', 'updateProgress']);
  // A handle without remove, or a failing remove, must not hide the download result.
  await downloadUpdate(bridge({async addListener() {return 'callback-id';}}), release);
  await downloadUpdate(bridge({async addListener() {return {remove: async () => {throw new Error('gone');}};}}), release);
  await cancelDownload(bridge({async cancel() {throw new Error('nothing running');}}));
});

test('installation reports the installer launch or a missing permission and rejects anything else', async () => {
  const api = bridge();
  assert.equal(await installUpdate(api, release), 'launched');
  assert.deepEqual(api.calls.at(-1), ['install', {sha256: digest}]);
  assert.equal(await installUpdate(bridge({async install() {return {status:'permission'};}}), release), 'permission');
  await assert.rejects(installUpdate(bridge({async install() {return {};}}), release), /installer could not be opened/);
  await assert.rejects(installUpdate(bridge({async install() {throw new Error('Download the update again.');}}), release), /Download the update again/);
});
