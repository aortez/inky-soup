#!/usr/bin/env node
/**
 * YOLO remote update - push image over network and flash to inactive slot.
 *
 * Uses A/B partition scheme for safe updates:
 * 1. Flash to inactive partition (system keeps running).
 * 2. Switch boot slot.
 * 3. Reboot to new image.
 *
 * If it fails, you can still boot from the previous slot.
 *
 * Usage:
 *   npm run yolo                    # Build + push + flash + reboot
 *   npm run yolo -- --skip-build    # Push existing image (skip kas build)
 *   npm run yolo -- --dry-run       # Show what would happen
 */

import { execSync, spawn } from 'child_process';
import { existsSync, readdirSync, readFileSync, statSync, mkdtempSync, unlinkSync, rmdirSync } from 'fs';
import { dirname, join, basename } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { tmpdir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const consola = require('consola');

const __dirname = dirname(fileURLToPath(import.meta.url));
const YOCTO_DIR = dirname(__dirname);
const IMAGE_DIR = join(YOCTO_DIR, 'build/tmp/deploy/images/raspberrypi-inky-soup');

const REMOTE_HOST = 'inky-soup.local';
const REMOTE_USER = 'inky';
const REMOTE_TARGET = `${REMOTE_USER}@${REMOTE_HOST}`;
const REMOTE_TMP = '/tmp';

async function prompt(question) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(1)} ${units[i]}`;
}

function ssh(command) {
  try {
    return execSync(`ssh -o ConnectTimeout=5 -o BatchMode=yes ${REMOTE_TARGET} "${command}"`, {
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
  } catch {
    return null;
  }
}

function sshRun(command) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ssh', [
      '-o', 'ConnectTimeout=10',
      '-o', 'BatchMode=yes',
      REMOTE_TARGET,
      command,
    ], { stdio: 'inherit' });

    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`SSH command exited with code ${code}`));
    });
    proc.on('error', reject);
  });
}

function findLatestImage() {
  if (!existsSync(IMAGE_DIR)) {
    return null;
  }

  const files = readdirSync(IMAGE_DIR)
    .filter((f) => f.endsWith('.wic.gz') && !f.includes('->'))
    .map((f) => ({
      name: f,
      path: join(IMAGE_DIR, f),
      stat: statSync(join(IMAGE_DIR, f)),
    }))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

  const inkySoupImage = files.find((f) => f.name.includes('inky-soup-image'));
  return inkySoupImage || files[0] || null;
}

function checkRemoteReachable() {
  consola.info(`Checking if ${REMOTE_HOST} is reachable...`);
  try {
    execSync(`ping -c 1 -W 2 ${REMOTE_HOST}`, { stdio: 'pipe' });
  } catch {
    return false;
  }
  const result = ssh('echo ok');
  return result === 'ok';
}

async function calculateChecksum(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (data) => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

async function build() {
  consola.start('Building inky-soup-image...');
  const proc = spawn('kas', ['build', 'kas-inky-soup.yml'], {
    stdio: 'inherit',
    cwd: YOCTO_DIR,
  });

  return new Promise((resolve, reject) => {
    proc.on('close', (code) => {
      if (code === 0) {
        consola.success('Build complete!');
        resolve();
      } else {
        reject(new Error(`Build failed with code ${code}`));
      }
    });
    proc.on('error', reject);
  });
}

async function prepareRootfs(imagePath) {
  consola.start('Extracting rootfs from image...');

  const workDir = mkdtempSync(join(tmpdir(), 'yolo-rootfs-'));
  const wicPath = join(workDir, 'image.wic');
  const rootfsRaw = join(workDir, 'rootfs.ext4');
  const rootfsGz = join(workDir, 'rootfs.ext4.gz');

  try {
    // Decompress.
    consola.info('Decompressing image...');
    execSync(`gunzip -c "${imagePath}" > "${wicPath}"`, { stdio: 'pipe' });

    // Set up loop device.
    consola.info('Extracting rootfs partition...');
    const loopDevice = execSync(`sudo losetup -fP --show "${wicPath}"`, {
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();

    try {
      // Extract partition 2 (rootfs_a).
      execSync(`sudo dd if="${loopDevice}p2" of="${rootfsRaw}" bs=4M`, { stdio: 'pipe' });
    } finally {
      execSync(`sudo losetup -d "${loopDevice}"`, { stdio: 'pipe' });
    }

    // Compress.
    consola.info('Compressing rootfs...');
    execSync(`gzip -c "${rootfsRaw}" > "${rootfsGz}"`, { stdio: 'pipe' });

    // Cleanup intermediate files.
    unlinkSync(wicPath);
    unlinkSync(rootfsRaw);

    consola.success('Rootfs prepared!');
    return { rootfsPath: rootfsGz, workDir };
  } catch (err) {
    // Cleanup on error.
    try {
      execSync(`sudo losetup -D 2>/dev/null || true`, { stdio: 'pipe' });
      if (existsSync(workDir)) {
        execSync(`rm -rf "${workDir}"`, { stdio: 'pipe' });
      }
    } catch {}
    throw err;
  }
}

function cleanupWorkDir(workDir) {
  try {
    execSync(`rm -rf "${workDir}"`, { stdio: 'pipe' });
  } catch {}
}

async function transferImage(imagePath, checksum, dryRun) {
  const imageName = basename(imagePath);
  const remoteImagePath = `${REMOTE_TMP}/${imageName}`;

  consola.start('Transferring image to Pi...');
  consola.info(`Source: ${imageName}`);
  consola.info(`Size: ${formatBytes(statSync(imagePath).size)}`);

  if (dryRun) {
    consola.info('DRY RUN - would transfer image');
    return remoteImagePath;
  }

  execSync(`scp "${imagePath}" ${REMOTE_TARGET}:${remoteImagePath}`, { stdio: 'inherit' });
  consola.success('Transfer complete!');

  // Verify checksum.
  consola.info('Verifying checksum...');
  const remoteChecksum = ssh(`sha256sum ${remoteImagePath} | cut -d' ' -f1`);
  if (remoteChecksum !== checksum) {
    throw new Error('Checksum mismatch! Transfer may be corrupted.');
  }
  consola.success('Checksum verified!');

  return remoteImagePath;
}

async function remoteFlash(remoteImagePath, dryRun) {
  consola.start('Flashing to inactive partition...');
  consola.warn('THIS WILL UPDATE THE INACTIVE ROOT PARTITION');

  if (dryRun) {
    consola.info('DRY RUN - would run ab-update');
    return;
  }

  const confirm = await prompt('Type "yolo" to proceed: ');
  if (confirm.toLowerCase() !== 'yolo') {
    throw new Error('Aborted by user');
  }

  // Run A/B update.
  await sshRun(`ab-update ${remoteImagePath}`);

  consola.success('A/B update complete!');
  consola.info('Rebooting to activate new rootfs...');

  ssh('sudo systemctl reboot');
}

async function waitForReboot(timeoutSec = 120) {
  consola.start('Waiting for Pi to reboot...');

  const startTime = Date.now();
  const timeoutMs = timeoutSec * 1000;
  let sawOffline = false;

  while (Date.now() - startTime < timeoutMs) {
    process.stdout.write('.');

    const result = ssh('echo ok');
    if (result !== 'ok') {
      if (!sawOffline) {
        console.log(' offline');
        sawOffline = true;
      }
    } else if (sawOffline) {
      console.log(' online!');
      consola.success(`${REMOTE_HOST} is back online!`);
      return true;
    }

    await new Promise((r) => setTimeout(r, 2000));
  }

  console.log('');
  consola.warn('Timeout waiting for reboot');
  return false;
}

function showHelp() {
  console.log(`
YOLO Update - A/B partition update over network

Usage:
  npm run yolo [options]

Options:
  --skip-build     Skip kas build, use existing image
  --dry-run        Show what would happen without doing it
  -h, --help       Show this help

This updates the inactive partition while the system runs.
If it fails, you can still boot from the previous partition.
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('-h') || args.includes('--help')) {
    showHelp();
    process.exit(0);
  }

  const skipBuild = args.includes('--skip-build');
  const dryRun = args.includes('--dry-run');

  consola.box('Inky Soup YOLO Update');
  if (dryRun) {
    consola.warn('DRY RUN MODE');
  }

  // Check remote.
  if (!checkRemoteReachable()) {
    consola.error(`Cannot reach ${REMOTE_HOST}`);
    process.exit(1);
  }
  consola.success(`${REMOTE_HOST} is reachable`);

  // Build.
  if (!skipBuild) {
    await build();
  }

  // Find image.
  const image = findLatestImage();
  if (!image) {
    consola.error('No image found. Run "kas build kas-inky-soup.yml" first.');
    process.exit(1);
  }

  consola.info(`Image: ${image.name}`);
  consola.info(`Size: ${formatBytes(image.stat.size)}`);

  // Prepare rootfs.
  let workDir = null;
  let rootfsPath = null;

  if (!dryRun) {
    const prepared = await prepareRootfs(image.path);
    rootfsPath = prepared.rootfsPath;
    workDir = prepared.workDir;
  } else {
    rootfsPath = image.path;
  }

  try {
    // Calculate checksum.
    consola.info('Calculating checksum...');
    const checksum = dryRun ? 'dry-run' : await calculateChecksum(rootfsPath);

    // Transfer.
    const remoteImagePath = await transferImage(rootfsPath, checksum, dryRun);

    // Flash.
    await remoteFlash(remoteImagePath, dryRun);

    if (!dryRun) {
      // Wait for reboot.
      const online = await waitForReboot();

      if (online) {
        consola.success('YOLO update complete!');
        consola.info(`Connect with: ssh ${REMOTE_TARGET}`);
      } else {
        consola.warn('Pi did not come back online. Check manually.');
      }
    } else {
      consola.success('Dry run complete!');
    }
  } finally {
    if (workDir) {
      cleanupWorkDir(workDir);
    }
  }
}

main().catch((err) => {
  consola.error(err.message);
  process.exit(1);
});
