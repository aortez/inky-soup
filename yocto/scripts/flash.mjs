#!/usr/bin/env node
/**
 * Flash script for writing Inky Soup image to SD card.
 *
 * This script helps flash a Yocto-built image to an SD card,
 * with SSH key injection for secure access.
 *
 * Usage:
 *   npm run flash                    # Interactive mode
 *   npm run flash -- --device /dev/sdb  # Specify device
 *   npm run flash -- --list          # List available devices
 */

import { execSync } from 'child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync, mkdtempSync } from 'fs';
import { dirname, join, basename } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import { createRequire } from 'module';
import { tmpdir } from 'os';

const require = createRequire(import.meta.url);
const consola = require('consola');

const __dirname = dirname(fileURLToPath(import.meta.url));
const YOCTO_DIR = dirname(__dirname);
const IMAGE_DIR = join(YOCTO_DIR, 'build/tmp/deploy/images/raspberrypi-inky-soup');
const CONFIG_FILE = join(YOCTO_DIR, '.flash-config.json');

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

  // Prefer our custom image.
  const inkySoupImage = files.find((f) => f.name.includes('inky-soup-image'));
  if (inkySoupImage) {
    return inkySoupImage;
  }

  return files[0] || null;
}

function listBlockDevices() {
  try {
    const output = execSync('lsblk -d -o NAME,SIZE,MODEL -n', { encoding: 'utf-8' });
    return output
      .trim()
      .split('\n')
      .map((line) => {
        const parts = line.trim().split(/\s+/);
        return {
          name: parts[0],
          size: parts[1],
          model: parts.slice(2).join(' ') || 'Unknown',
        };
      })
      .filter((d) => d.name.startsWith('sd') || d.name.startsWith('mmcblk'));
  } catch {
    return [];
  }
}

function findSSHKeys() {
  const sshDir = join(process.env.HOME, '.ssh');
  if (!existsSync(sshDir)) {
    return [];
  }

  return readdirSync(sshDir)
    .filter((f) => f.endsWith('.pub'))
    .map((f) => join(sshDir, f));
}

function loadConfig() {
  try {
    if (!existsSync(CONFIG_FILE)) {
      return null;
    }
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function saveConfig(config) {
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// ============================================================================
// Data Partition Backup/Restore
// ============================================================================

/**
 * Check if the device has a data partition (partition 4) with content.
 */
function hasDataPartition(device) {
  const dataPartition = `${device}4`;
  try {
    execSync(`test -b ${dataPartition}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Backup /data from the local disk's partition 4 before flashing.
 * Returns the backup directory path, or null on failure.
 */
function backupDataPartition(device) {
  const dataPartition = `${device}4`;
  const backupDir = mkdtempSync(join(tmpdir(), 'inky-soup-data-backup-'));
  const mountPoint = mkdtempSync(join(tmpdir(), 'inky-soup-data-mount-'));

  try {
    consola.info(`Backing up data partition from ${dataPartition}...`);

    // Mount the data partition.
    execSync(`sudo mount ${dataPartition} ${mountPoint}`, { stdio: 'pipe' });

    // Copy contents to backup dir, preserving ownership info in extended attributes.
    execSync(`sudo rsync -a --fake-super ${mountPoint}/ ${backupDir}/`, { stdio: 'pipe' });

    // Fix ownership of backup dir itself so we can list it.
    execSync(`sudo chown $(id -u):$(id -g) ${backupDir}`, { stdio: 'pipe' });

    // Verify we got something useful (more than just lost+found).
    const files = readdirSync(backupDir).filter((f) => f !== 'lost+found');
    if (files.length === 0) {
      consola.info('Data partition is empty (nothing to backup)');
      execSync(`rm -rf ${backupDir}`, { stdio: 'pipe' });
      return null;
    }

    consola.success(`Backed up ${files.length} items from data partition`);
    return backupDir;

  } catch (err) {
    consola.warn(`Backup failed: ${err.message}`);
    try {
      execSync(`rm -rf ${backupDir}`, { stdio: 'pipe' });
    } catch {
      // Ignore cleanup errors.
    }
    return null;

  } finally {
    // Always unmount.
    try {
      execSync(`sudo umount ${mountPoint} 2>/dev/null || true`, { stdio: 'pipe' });
      execSync(`rm -rf ${mountPoint}`, { stdio: 'pipe' });
    } catch {
      // Ignore cleanup errors.
    }
  }
}

/**
 * Restore backed up data to the data partition on the flashed device.
 */
function restoreDataPartition(device, backupDir) {
  const dataPartition = `${device}4`;
  const mountPoint = mkdtempSync(join(tmpdir(), 'inky-soup-data-restore-'));

  try {
    consola.info('Restoring data to new image...');

    // Mount the data partition.
    consola.info(`Mounting ${dataPartition}...`);
    execSync(`sudo mount ${dataPartition} ${mountPoint}`, { stdio: 'pipe' });

    // Restore the backup, using --fake-super to restore ownership from xattrs.
    consola.info('Copying backed up data...');
    execSync(`sudo rsync -a --fake-super ${backupDir}/ ${mountPoint}/`, { stdio: 'pipe' });

    consola.success('Data restored!');
    return true;

  } catch (err) {
    consola.error(`Restore failed: ${err.message}`);
    return false;

  } finally {
    // Always try to unmount and clean up.
    try {
      consola.info('Unmounting data partition...');
      execSync(`sudo umount ${mountPoint}`, { stdio: 'pipe' });
      execSync(`rm -rf ${mountPoint}`, { stdio: 'pipe' });
    } catch (err) {
      consola.warn(`Cleanup warning: ${err.message}`);
    }
  }
}

/**
 * Clean up backup directory.
 */
function cleanupBackup(backupDir) {
  if (backupDir) {
    try {
      execSync(`rm -rf ${backupDir}`, { stdio: 'pipe' });
    } catch {
      // Ignore cleanup errors.
    }
  }
}

// ============================================================================
// SSH Key Injection
// ============================================================================

/**
 * Inject SSH key into the flashed device's rootfs.
 * Mounts partition 2 (rootfs), writes authorized_keys, unmounts.
 */
function injectSSHKey(device, sshKeyPath) {
  const rootfsPartition = `${device}2`;

  // Read the SSH public key.
  const sshKey = readFileSync(sshKeyPath, 'utf-8').trim();
  if (!sshKey) {
    throw new Error('Failed to read SSH key');
  }

  consola.start('Injecting SSH key into image...');

  // Create temporary mount point.
  const mountPoint = mkdtempSync(join(tmpdir(), 'inky-soup-rootfs-'));

  try {
    // Mount the rootfs partition.
    consola.info(`Mounting ${rootfsPartition}...`);
    execSync(`sudo mount ${rootfsPartition} ${mountPoint}`, { stdio: 'pipe' });

    // Write the SSH key.
    const authorizedKeysPath = join(mountPoint, 'home/inky/.ssh/authorized_keys');
    consola.info('Writing SSH key to authorized_keys...');
    execSync(`echo '${sshKey}' | sudo tee ${authorizedKeysPath} > /dev/null`, { stdio: 'pipe' });
    execSync(`sudo chmod 600 ${authorizedKeysPath}`, { stdio: 'pipe' });
    execSync(`sudo chown 1000:1000 ${authorizedKeysPath}`, { stdio: 'pipe' });

    consola.success('SSH key injected!');

  } finally {
    // Always try to unmount and clean up.
    try {
      consola.info('Unmounting...');
      execSync(`sudo umount ${mountPoint}`, { stdio: 'pipe' });
      execSync(`rm -rf ${mountPoint}`, { stdio: 'pipe' });
    } catch (err) {
      consola.warn(`Cleanup warning: ${err.message}`);
    }
  }
}

function showHelp() {
  console.log(`
Inky Soup Flash Tool

Usage:
  npm run flash [options]

Options:
  --device <dev>    Target device (e.g., /dev/sdb)
  --list            List available block devices
  --reconfigure     Re-select SSH key
  -h, --help        Show this help

Examples:
  npm run flash                       # Interactive mode
  npm run flash -- --list             # List devices
  npm run flash -- --device /dev/sdb  # Flash to specific device
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('-h') || args.includes('--help')) {
    showHelp();
    process.exit(0);
  }

  if (args.includes('--list')) {
    const devices = listBlockDevices();
    console.log('Available block devices:');
    devices.forEach((d) => {
      console.log(`  /dev/${d.name}  ${d.size}  ${d.model}`);
    });
    process.exit(0);
  }

  consola.box('Inky Soup Flash Tool');

  // Find image.
  const image = findLatestImage();
  if (!image) {
    consola.error('No image found. Run "kas build kas-inky-soup.yml" first.');
    process.exit(1);
  }

  consola.info(`Image: ${image.name}`);
  consola.info(`Size: ${(image.stat.size / 1024 / 1024).toFixed(1)} MB`);
  consola.info(`Built: ${image.stat.mtime.toLocaleString()}`);

  // Load or select SSH key.
  let config = loadConfig();
  if (!config || args.includes('--reconfigure')) {
    const sshKeys = findSSHKeys();
    if (sshKeys.length === 0) {
      consola.error('No SSH public keys found in ~/.ssh/');
      process.exit(1);
    }

    console.log('\nAvailable SSH keys:');
    sshKeys.forEach((k, i) => {
      console.log(`  ${i + 1}. ${basename(k)}`);
    });

    const choice = await prompt('Select key (1): ');
    const keyIndex = parseInt(choice || '1', 10) - 1;
    if (keyIndex < 0 || keyIndex >= sshKeys.length) {
      consola.error('Invalid selection');
      process.exit(1);
    }

    config = { ssh_key_path: sshKeys[keyIndex] };
    saveConfig(config);
    consola.success(`SSH key saved: ${basename(config.ssh_key_path)}`);
  } else {
    consola.info(`Using SSH key: ${basename(config.ssh_key_path)}`);
  }

  // Get target device.
  let device = null;
  const deviceIndex = args.indexOf('--device');
  if (deviceIndex !== -1 && deviceIndex + 1 < args.length) {
    device = args[deviceIndex + 1];
  } else {
    const devices = listBlockDevices();
    console.log('\nAvailable devices:');
    devices.forEach((d, i) => {
      console.log(`  ${i + 1}. /dev/${d.name}  ${d.size}  ${d.model}`);
    });

    const choice = await prompt('Select device number: ');
    const devIndex = parseInt(choice, 10) - 1;
    if (devIndex < 0 || devIndex >= devices.length) {
      consola.error('Invalid selection');
      process.exit(1);
    }
    device = `/dev/${devices[devIndex].name}`;
  }

  // Check if we can backup /data from the disk before flashing.
  let backupDir = null;
  if (hasDataPartition(device)) {
    console.log('');
    consola.info(`Found existing data partition on ${device}4`);
    const doBackup = await prompt('Backup /data before flashing? (Y/n): ');
    if (doBackup.toLowerCase() !== 'n') {
      backupDir = backupDataPartition(device);
      if (!backupDir) {
        const continueAnyway = await prompt('Continue without backup? (y/N): ');
        if (continueAnyway.toLowerCase() !== 'y') {
          consola.info('Aborted.');
          process.exit(0);
        }
      }
    }
  }

  // Confirm.
  console.log('');
  consola.warn(`THIS WILL ERASE ALL DATA ON ${device}`);
  const confirm = await prompt('Type "yes" to continue: ');
  if (confirm.toLowerCase() !== 'yes') {
    cleanupBackup(backupDir);
    consola.info('Aborted.');
    process.exit(0);
  }

  // Unmount any partitions on the device.
  try {
    consola.info('Unmounting any mounted partitions...');
    execSync(`sudo umount ${device}* 2>/dev/null || true`, { stdio: 'inherit' });
  } catch {
    // Ignore unmount errors.
  }

  // Flash with bmaptool.
  consola.start('Flashing image...');
  execSync(`sudo bmaptool copy ${image.path} ${device}`, { stdio: 'inherit' });
  consola.success('Flash complete!');

  // Wait for kernel to settle after flash.
  consola.info('Waiting for kernel to recognize partitions...');
  execSync('sleep 2');
  execSync(`sudo partprobe ${device} 2>/dev/null || true`);
  execSync('sleep 1');

  // Inject SSH key after flashing.
  try {
    injectSSHKey(device, config.ssh_key_path);
  } catch (err) {
    consola.error(`SSH key injection failed: ${err.message}`);
    consola.info('You may need to manually add your SSH key after first boot.');
  }

  // Restore /data if we have a backup.
  if (backupDir) {
    restoreDataPartition(device, backupDir);
    cleanupBackup(backupDir);
    consola.success('/data restored - WiFi credentials preserved!');
  }

  consola.box('Done! Insert the SD card and boot your Pi.\nSSH: ssh inky@inky-soup.local');
}

main().catch((err) => {
  consola.error(err);
  process.exit(1);
});
