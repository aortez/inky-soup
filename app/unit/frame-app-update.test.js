import test from 'node:test';
import assert from 'node:assert/strict';
import {updateBlockReason, updateDecision, validateRelease, validateInstalled, describeUpdate, updateCheckDue, rememberUpdateCheck, rememberedRelease, resolveUpdate, updateCheckInterval, updateCheckKey} from '../frame/core/app-update.js';

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

test('block reasons name the pending action for native installs', () => {
  assert.equal(updateBlockReason({imports: [], job: {id: 1}}, 'Install', 'installing'), 'Install will be available when your frame finishes refreshing.');
  assert.equal(updateBlockReason({imports: [], busy: true}, 'Install', 'installing'), 'Finish the current task before installing.');
  assert.equal(updateBlockReason({imports: [{status: 'Failed', draft: {}}]}, 'Install', 'installing'), 'Finish adding your photos before installing.');
  assert.equal(updateBlockReason({imports: [], busy: true}), 'Finish the current task before reloading.');
});

test('release decisions compare application, signing key, Android version, and version code', () => {
  const installed = {applicationId: 'pizza.allan.frame', versionName: '0.1.0', versionCode: 1000, sdk: 36, signingSha256: 'a'.repeat(64)};
  const release = {application_id: 'pizza.allan.frame', version_name: '0.2.0', version_code: 2000, min_sdk: 24, signing_sha256: 'a'.repeat(64)};
  assert.deepEqual(updateDecision(installed, release), {status: 'available', reason: ''});
  assert.equal(updateDecision(installed, {...release, version_code: 1000}).status, 'current');
  assert.equal(updateDecision(installed, {...release, version_code: 2}).status, 'current');
  assert.match(updateDecision(installed, {...release, signing_sha256: 'b'.repeat(64)}).reason, /different signing key/);
  assert.match(updateDecision(installed, {...release, min_sdk: 37}).reason, /newer Android/);
  assert.match(updateDecision(installed, {...release, application_id: 'pizza.allan.other'}).reason, /different app/);
});

test('release manifests are validated and normalized', () => {
  const release = {application_id: 'pizza.allan.frame', version_name: '0.2.0', version_code: 2000, min_sdk: 24, apk_url: 'https://example.test/frame.apk',
    apk_sha256: 'c'.repeat(64), apk_size: 8_000_000, signing_sha256: 'a'.repeat(64), notes: ` ${'n'.repeat(1200)} `, release_url: null, extra: true};
  const normalized = validateRelease(release);
  assert.equal(normalized.notes.length, 1000);
  assert.equal(normalized.release_url, '');
  assert.equal('extra' in normalized, false);
  assert.equal(validateRelease({...release, notes: undefined}).notes, '');
  // A remembered release is the normalized form, so validation must accept its own output.
  assert.deepEqual(validateRelease(normalized), normalized);
  assert.deepEqual(validateRelease(validateRelease({...release, release_url: 'https://example.test/notes'})).release_url, 'https://example.test/notes');
  for (const patch of [{apk_url: 'http://example.test/frame.apk'}, {apk_url: 'https://example.test/' + 'x'.repeat(2048)}, {release_url: 'ftp://example.test'},
    {min_sdk: 0}, {version_code: 2 ** 31}, {apk_sha256: 'c'.repeat(63)}, {signing_sha256: null}, null, 'text']) {
    assert.throws(() => validateRelease(patch && typeof patch === 'object' ? {...release, ...patch} : patch), /update information/, JSON.stringify(patch));
  }
  assert.throws(() => validateInstalled({applicationId: 'pizza.allan.frame', versionName: '0.1.0', versionCode: 0, sdk: 36, signingSha256: 'a'.repeat(64), canInstall: true, downloadedSha256: null}), /installed app version/);
});

test('status text covers every update stage and prefers the blocking reason while installing is deferred', () => {
  const release = {version_name: '0.2.0', apk_size: 8_200_000, notes: 'Faster gallery.'};
  assert.match(describeUpdate(null), /automatically/);
  assert.equal(describeUpdate({status: 'checking'}), 'Checking for updates…');
  assert.equal(describeUpdate({status: 'current'}), 'You have the latest version.');
  assert.equal(describeUpdate({status: 'available', release}), 'Version 0.2.0 is available (8.2 MB). Faster gallery.');
  assert.equal(describeUpdate({status: 'available', release, error: 'Download interrupted.'}), 'Download interrupted. Version 0.2.0 is available (8.2 MB). Faster gallery.');
  assert.equal(describeUpdate({status: 'downloading', release, received: 1_000_000, total: 8_200_000}), 'Downloading version 0.2.0… 1.0 MB of 8.2 MB.');
  assert.equal(describeUpdate({status: 'downloaded', release}), 'Version 0.2.0 is ready to install. Your draft and remembered frames are kept.');
  assert.equal(describeUpdate({status: 'downloaded', release}, 'Install will be available when your frame finishes refreshing.'), 'Install will be available when your frame finishes refreshing.');
  assert.equal(describeUpdate({status: 'downloaded', release, notice: 'Allow installs.'}), 'Allow installs.');
  assert.equal(describeUpdate({status: 'installing'}), 'Opening the Android installer…');
  assert.equal(describeUpdate({status: 'incompatible', reason: 'Nope.'}), 'Nope.');
  assert.equal(describeUpdate({status: 'error', error: 'Offline.'}), 'Offline.');
});

test('automatic checks run at most once per interval and recover from clock changes or missing storage', () => {
  const entries = new Map();
  const storage = {getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value)};
  const release = {application_id: 'pizza.allan.frame', version_name: '0.2.0', version_code: 2000, min_sdk: 24, apk_url: 'https://example.test/frame.apk',
    apk_sha256: 'c'.repeat(64), apk_size: 8_000_000, signing_sha256: 'a'.repeat(64)};
  assert.equal(updateCheckDue(storage, 1000), true);
  assert.equal(rememberedRelease(storage), null);
  rememberUpdateCheck(storage, release, 1000);
  assert.equal(updateCheckDue(storage, 1000 + updateCheckInterval - 1), false);
  assert.equal(updateCheckDue(storage, 1000 + updateCheckInterval), true);
  assert.equal(updateCheckDue(storage, 500), true);
  assert.deepEqual(rememberedRelease(storage), validateRelease(release));
  rememberUpdateCheck(storage, null, 2000);
  assert.equal(rememberedRelease(storage), null);
  entries.set(updateCheckKey, 'soon');
  assert.equal(updateCheckDue(storage, 5000), true);
  assert.equal(rememberedRelease(storage), null);
  const broken = {getItem() {throw new Error('disabled');}, setItem() {throw new Error('disabled');}};
  assert.equal(updateCheckDue(broken), true);
  assert.equal(rememberedRelease(broken), null);
  rememberUpdateCheck(broken);
});

test('a remembered release resolves against the installed app, including an earlier verified download', () => {
  const installed = {applicationId: 'pizza.allan.frame', versionName: '0.1.0', versionCode: 1000, sdk: 36, signingSha256: 'a'.repeat(64), canInstall: true, downloadedSha256: null};
  const release = {application_id: 'pizza.allan.frame', version_name: '0.2.0', version_code: 2000, min_sdk: 24, apk_url: 'https://example.test/frame.apk',
    apk_sha256: 'c'.repeat(64), apk_size: 8_000_000, signing_sha256: 'a'.repeat(64)};
  assert.equal(resolveUpdate(installed, release).status, 'available');
  assert.equal(resolveUpdate({...installed, downloadedSha256: 'c'.repeat(64)}, release).status, 'downloaded');
  assert.equal(resolveUpdate({...installed, downloadedSha256: 'd'.repeat(64)}, release).status, 'available');
  assert.equal(resolveUpdate({...installed, downloadedSha256: 'c'.repeat(64)}, {...release, version_code: 1000}).status, 'current');
});
