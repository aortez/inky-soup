import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {packWebBundle, requiredFiles} from '../tools/web-bundle.mjs';

function build(t, paths) {
  const dist = mkdtempSync(join(tmpdir(), 'frame-web-'));
  t.after(() => rmSync(dist, {recursive: true, force: true}));
  for (const path of paths) {
    mkdirSync(dirname(join(dist, path)), {recursive: true});
    writeFileSync(join(dist, path), `contents of ${path}`);
  }
  return dist;
}

test('the web archive depends only on the build output and its commit time', t => {
  const paths = [...requiredFiles, 'assets/frame-Cx1.js'];
  const first = build(t, paths), second = build(t, paths);
  chmodSync(join(second, 'frame/index.html'), 0o666);
  utimesSync(join(second, 'setup/index.html'), 1, 1);
  const packed = packWebBundle(first, 1_790_000_000);
  assert.deepEqual(packWebBundle(second, 1_790_000_000), packed);
  assert.notEqual(packWebBundle(first, 1_790_000_001).sha256, packed.sha256);
  const list = args => execFileSync('tar', [...args, '--gzip', '--file', '-'], {input: packed.archive, encoding: 'utf8'});
  assert.deepEqual(list(['--list']).trim().split('\n'), ['assets/', 'assets/frame-Cx1.js', 'frame/', 'frame/index.html',
    'frame/sw.js', 'setup/', 'setup/index.html', 'wifi/', 'wifi/index.html']);
  assert.equal(list(['--extract', '--to-stdout', 'frame/index.html']), 'contents of frame/index.html');
});

test('an incomplete build or an invalid time is refused', t => {
  const dist = build(t, requiredFiles.filter(path => path !== 'frame/sw.js'));
  assert.throws(() => packWebBundle(dist, 1_790_000_000), /missing frame\/sw\.js/);
  assert.throws(() => packWebBundle(build(t, requiredFiles), '2026-10-26'), /whole seconds/);
});
