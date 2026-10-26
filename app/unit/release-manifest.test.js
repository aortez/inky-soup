import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {validateRelease} from '../frame/core/app-update.js';
import {versionCode, releaseTag, signingDigest, minimumSdk, releaseManifest} from '../tools/release-manifest.mjs';

test('version codes grow with the semantic version and reject other formats', () => {
  assert.equal(versionCode('0.1.0'), 1000);
  assert.equal(versionCode('1.2.3'), 1_002_003);
  assert.equal(versionCode('999.999.999'), 999_999_999);
  assert.ok(versionCode('0.2.0') > versionCode('0.1.999'));
  for (const bad of ['0.2', '1.2.3.4', '1.1000.0', 'v1.2.3', '1.2.3-beta', '']) assert.throws(() => versionCode(bad), /MAJOR\.MINOR\.PATCH/, bad);
  assert.equal(releaseTag('0.2.0'), 'app-v0.2.0');
});

test('apksigner certificates and the Gradle minimum SDK are parsed', () => {
  const certificates = `Signer #1 certificate DN: CN=Frame\nSigner #1 certificate SHA-256 digest: ${'AB'.repeat(32)}\nSigner #1 certificate SHA-1 digest: ${'c'.repeat(40)}\n`;
  assert.equal(signingDigest(certificates), 'ab'.repeat(32));
  assert.throws(() => signingDigest('Verifies\n'), /SHA-256/);
  assert.equal(minimumSdk('ext {\n    minSdkVersion = 24\n    compileSdkVersion = 36\n}'), 24);
  assert.throws(() => minimumSdk('ext {}'), /minSdkVersion/);
});

test('release metadata satisfies the app updater contract and ties the tag to the version', () => {
  const apk = Buffer.from('not an apk, but hashed like one');
  const input = {applicationId: 'pizza.allan.frame', version: '0.2.0', tag: 'app-v0.2.0', repository: 'aortez/inky-soup', apk,
    signingSha256: 'a'.repeat(64), minSdk: 24, notes: ` ${'Faster gallery. '.repeat(100)} `, publishedAt: '2026-10-25T00:00:00.000Z'};
  const manifest = releaseManifest(input);
  assert.deepEqual(validateRelease(manifest), {
    application_id: 'pizza.allan.frame', version_name: '0.2.0', version_code: 2000, min_sdk: 24,
    apk_url: 'https://github.com/aortez/inky-soup/releases/download/app-v0.2.0/frame.apk',
    apk_sha256: createHash('sha256').update(apk).digest('hex'), apk_size: apk.length, signing_sha256: 'a'.repeat(64),
    notes: manifest.notes, release_url: 'https://github.com/aortez/inky-soup/releases/tag/app-v0.2.0',
  });
  assert.equal(manifest.notes.length, 1000);
  assert.equal(manifest.published_at, '2026-10-25T00:00:00.000Z');
  assert.throws(() => releaseManifest({...input, tag: 'app-v0.3.0'}), /does not match/);
  assert.throws(() => releaseManifest({...input, repository: 'bad repo'}), /repository/);
});
