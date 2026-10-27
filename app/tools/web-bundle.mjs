#!/usr/bin/env node
// Packs the web build that each release attaches for allan.pizza; see README.md.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readdirSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {gzipSync} from 'node:zlib';

const appDirectory = fileURLToPath(new URL('..', import.meta.url));

// Printed labels, the setup handoff, and installed apps' service worker depend on these paths.
export const requiredFiles = ['frame/index.html', 'frame/sw.js', 'setup/index.html', 'wifi/index.html'];

// GNU tar with fixed order, owners, modes, and times makes the archive a function of the
// build output and commit time, so re-running a release reproduces its published checksum.
export function packWebBundle(dist, mtime) {
  const missing = requiredFiles.filter(file => !existsSync(join(dist, file)));
  if (missing.length) throw new Error(`${dist} is not a complete web build; missing ${missing.join(', ')}. Run npm run build first.`);
  if (!/^\d+$/.test(String(mtime))) throw new Error(`The archive time must be whole seconds since 1970: ${mtime}`);
  const tar = execFileSync('tar', ['--create', '--format=ustar', '--sort=name', `--mtime=@${mtime}`, '--owner=0', '--group=0',
    '--numeric-owner', '--mode=u=rwX,go=rX', '--directory', dist, '--file', '-', ...readdirSync(dist).sort()], {maxBuffer: 256 * 1024 * 1024});
  const archive = gzipSync(tar, {level: 9});
  return {archive, sha256: createHash('sha256').update(archive).digest('hex')};
}

function main() {
  const {values} = parseArgs({options: {dist: {type: 'string'}, output: {type: 'string'}}});
  if (!values.output) throw new Error('--output is required.');
  const mtime = process.env.SOURCE_DATE_EPOCH || execFileSync('git', ['log', '-1', '--format=%ct'], {cwd: appDirectory, encoding: 'utf8'}).trim();
  const {archive, sha256} = packWebBundle(resolve(values.dist || join(appDirectory, 'dist')), mtime);
  mkdirSync(values.output, {recursive: true});
  writeFileSync(join(values.output, 'frame-web.tar.gz'), archive);
  writeFileSync(join(values.output, 'frame-web.tar.gz.sha256'), `${sha256}  frame-web.tar.gz\n`);
  console.log(`Wrote frame-web.tar.gz (${archive.length} bytes, SHA-256 ${sha256}) to ${resolve(values.output)}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
