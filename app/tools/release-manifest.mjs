#!/usr/bin/env node
// Writes the metadata the Android app's updater reads beside each signed APK; see docs/android-release.md.
import {createHash} from 'node:crypto';
import {copyFileSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';

const appDirectory = fileURLToPath(new URL('..', import.meta.url));

// Mirrors android/app/build.gradle so the manifest and the APK always agree.
export function versionCode(version) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(version);
  if (!match) throw new Error(`The app version must be MAJOR.MINOR.PATCH with parts up to 999: ${version}`);
  const [major, minor, patch] = match.slice(1).map(Number);
  return major * 1_000_000 + minor * 1000 + patch;
}

export const releaseTag = version => `app-v${version}`;

// apksigner prints the current signer certificate; the installed app compares it with its own.
export function signingDigest(certificates) {
  const match = /Signer #1 certificate SHA-256 digest: ([0-9a-f]{64})/i.exec(certificates);
  if (!match) throw new Error('Could not find the signer certificate SHA-256 digest in the apksigner output.');
  return match[1].toLowerCase();
}

export function minimumSdk(variablesGradle) {
  const match = /minSdkVersion\s*=\s*(\d+)/.exec(variablesGradle);
  if (!match) throw new Error('Could not read minSdkVersion from android/variables.gradle.');
  return Number(match[1]);
}

export function releaseManifest({applicationId, version, tag, repository, apk, signingSha256, minSdk, notes = '', publishedAt = new Date().toISOString()}) {
  if (tag !== releaseTag(version)) throw new Error(`Tag ${tag} does not match app version ${version}; use ${releaseTag(version)}.`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error(`Invalid GitHub repository: ${repository}`);
  return {
    application_id: applicationId, version_name: version, version_code: versionCode(version), min_sdk: minSdk,
    apk_url: `https://github.com/${repository}/releases/download/${tag}/frame.apk`,
    apk_sha256: createHash('sha256').update(apk).digest('hex'), apk_size: apk.length,
    signing_sha256: signingSha256, notes: notes.trim().slice(0, 1000),
    release_url: `https://github.com/${repository}/releases/tag/${tag}`, published_at: publishedAt,
  };
}

function main() {
  const {values} = parseArgs({options: {
    apk: {type: 'string'}, certs: {type: 'string'}, 'check-tag': {type: 'string'}, notes: {type: 'string'},
    output: {type: 'string'}, repository: {type: 'string'}, tag: {type: 'string'},
  }});
  const {version} = JSON.parse(readFileSync(join(appDirectory, 'package.json'), 'utf8'));
  if (values['check-tag'] !== undefined) {
    if (values['check-tag'] !== releaseTag(version)) throw new Error(`Tag ${values['check-tag']} does not match app/package.json version ${version}.`);
    console.log(`Tag ${values['check-tag']} matches app version ${version}.`);
    return;
  }
  for (const name of ['apk', 'certs', 'output', 'repository']) if (!values[name]) throw new Error(`--${name} is required.`);
  const apk = readFileSync(values.apk);
  const manifest = releaseManifest({
    applicationId: JSON.parse(readFileSync(join(appDirectory, 'capacitor.config.json'), 'utf8')).appId,
    version, tag: values.tag || releaseTag(version), repository: values.repository, apk,
    signingSha256: signingDigest(readFileSync(values.certs, 'utf8')),
    minSdk: minimumSdk(readFileSync(join(appDirectory, 'android', 'variables.gradle'), 'utf8')),
    notes: values.notes ? readFileSync(values.notes, 'utf8') : '',
  });
  mkdirSync(values.output, {recursive: true});
  copyFileSync(values.apk, join(values.output, 'frame.apk'));
  writeFileSync(join(values.output, 'frame.apk.sha256'), `${manifest.apk_sha256}  frame.apk\n`);
  writeFileSync(join(values.output, 'frame-release.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote version ${manifest.version_name} (code ${manifest.version_code}) release files to ${resolve(values.output)}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
