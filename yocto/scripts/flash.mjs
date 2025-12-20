#!/usr/bin/env node
/**
 * Flash script for Inky Soup Yocto images.
 *
 * Features:
 * - Flashes Yocto image to USB/SD card.
 * - Injects your SSH public key for passwordless login.
 * - Backs up and restores /data partition from the disk (WiFi credentials, logs, config).
 * - Remembers your key preference in .flash-config.json.
 *
 * Usage:
 *   npm run flash                       # Interactive device selection
 *   npm run flash -- --device /dev/sdb  # Direct flash (still confirms)
 *   npm run flash -- --list             # Just list devices
 *   npm run flash -- --dry-run          # Show what would happen without flashing
 *   npm run flash -- --reconfigure      # Re-select SSH key
 */

import { execSync, spawn } from 'child_process';
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import { homedir, tmpdir } from 'os';

// Colors for terminal output.
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

function log(msg) { console.log(msg); }
function info(msg) { console.log(`${colors.blue}ℹ${colors.reset} ${msg}`); }
function success(msg) { console.log(`${colors.green}✓${colors.reset} ${msg}`); }
function warn(msg) { console.log(`${colors.yellow}⚠${colors.reset} ${msg}`); }
function error(msg) { console.log(`${colors.red}✗${colors.reset} ${msg}`); }

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const YOCTO_DIR = dirname(__dirname);
const IMAGE_DIR = join(YOCTO_DIR, 'build/poky/tmp/deploy/images/raspberrypi0-2w');
const CONFIG_FILE = join(YOCTO_DIR, '.flash-config.json');

// ============================================================================
// Configuration Management
// ============================================================================

/**
 * Load flash configuration from .flash-config.json.
 * Returns null if file doesn't exist or is invalid.
 */
function loadConfig() {
  try {
    if (!existsSync(CONFIG_FILE)) {
      return null;
    }
    const content = readFileSync(CONFIG_FILE, 'utf-8');
    const config = JSON.parse(content);
    // Validate required fields.
    if (!config.ssh_key_path || typeof config.ssh_key_path !== 'string') {
      return null;
    }
    // Check that the key file still exists.
    if (!existsSync(config.ssh_key_path)) {
      warn(`Configured SSH key no longer exists: ${config.ssh_key_path}`);
      return null;
    }
    return config;
  } catch {
    return null;
  }
}

/**
 * Save flash configuration to .flash-config.json.
 */
function saveConfig(config) {
  try {
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n');
    return true;
  } catch (err) {
    warn(`Failed to save config: ${err.message}`);
    return false;
  }
}

/**
 * Find available SSH public keys in ~/.ssh/.
 */
function findSshKeys() {
  const sshDir = join(homedir(), '.ssh');
  if (!existsSync(sshDir)) {
    return [];
  }

  try {
    return readdirSync(sshDir)
      .filter(f => f.endsWith('.pub'))
      .map(f => ({
        name: f,
        path: join(sshDir, f),
      }))
      .filter(k => existsSync(k.path));
  } catch {
    return [];
  }
}

/**
 * Read the contents of an SSH public key file.
 */
function readSshKey(keyPath) {
  try {
    return readFileSync(keyPath, 'utf-8').trim();
  } catch (err) {
    error(`Failed to read SSH key: ${err.message}`);
    return null;
  }
}

// ============================================================================
// Image and Device Discovery
// ============================================================================

/**
 * Find the latest flashable image file (.wic.gz or .rpi-sdimg).
 */
function findLatestImage() {
  if (!existsSync(IMAGE_DIR)) {
    return null;
  }

  const files = readdirSync(IMAGE_DIR)
    .filter(f => (f.endsWith('.wic.gz') || f.endsWith('.rpi-sdimg')) && !f.includes('->'))
    .map(f => ({
      name: f,
      path: join(IMAGE_DIR, f),
      // Follow symlinks to get real file for mtime.
      stat: statSync(join(IMAGE_DIR, f)),
      isCompressed: f.endsWith('.wic.gz'),
    }))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

  // Look for inky-soup-image.
  const image = files.find(f =>
    f.name === 'inky-soup-image-raspberrypi0-2w.rootfs.wic.gz' ||
    f.name === 'inky-soup-image-raspberrypi0-2w.rootfs.rpi-sdimg'
  );

  return image || null;
}

/**
 * Get list of block devices suitable for flashing.
 * Returns removable devices and excludes the system disk.
 */
function getBlockDevices() {
  try {
    const output = execSync('lsblk -d -o NAME,SIZE,TYPE,RM,TRAN,MODEL -J', {
      encoding: 'utf-8',
    });
    const data = JSON.parse(output);

    return data.blockdevices
      .filter(dev => {
        // Only disk types.
        if (dev.type !== 'disk') return false;
        // Skip loop devices.
        if (dev.name.startsWith('loop')) return false;
        // Skip nvme (usually system disk).
        if (dev.name.startsWith('nvme')) return false;
        // Prefer removable (RM=1) or USB transport.
        return dev.rm === true || dev.rm === '1' || dev.tran === 'usb';
      })
      .map(dev => ({
        device: `/dev/${dev.name}`,
        size: dev.size,
        model: dev.model || 'Unknown',
        transport: dev.tran || 'unknown',
        removable: dev.rm === true || dev.rm === '1',
      }));
  } catch (err) {
    error(`Failed to list block devices: ${err.message}`);
    return [];
  }
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Format bytes to human readable string.
 */
function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) {
    bytes /= 1024;
    i++;
  }
  return `${bytes.toFixed(1)} ${units[i]}`;
}

/**
 * Prompt user for input.
 */
async function prompt(question) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Check if bmaptool is available.
 */
function hasBmaptool() {
  try {
    execSync('which bmaptool', { encoding: 'utf-8', stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Local Data Partition Backup/Restore
// ============================================================================

/**
 * Check if the device has a data partition (partition 4) with content.
 * Returns true if data partition exists and has files.
 */
function hasDataPartition(device) {
  const dataPartition = `${device}4`;
  try {
    // Check if partition exists.
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
    info(`Backing up data partition from ${dataPartition}...`);

    // Mount the data partition.
    execSync(`sudo mount ${dataPartition} ${mountPoint}`, { stdio: 'pipe' });

    // Copy contents to backup dir, preserving ownership info in extended attributes.
    // We use --fake-super to store ownership as xattrs since we're not root.
    execSync(`sudo rsync -a --fake-super ${mountPoint}/ ${backupDir}/`, { stdio: 'pipe' });

    // Fix ownership of backup dir itself so we can list it.
    execSync(`sudo chown $(id -u):$(id -g) ${backupDir}`, { stdio: 'pipe' });

    // Verify we got something useful (more than just lost+found).
    const files = readdirSync(backupDir).filter(f => f !== 'lost+found');
    if (files.length === 0) {
      info('Data partition is empty (nothing to backup)');
      execSync(`sudo rm -rf ${backupDir}`, { stdio: 'pipe' });
      return null;
    }

    success(`Backed up ${files.length} items from data partition`);
    return backupDir;

  } catch (err) {
    warn(`Backup failed: ${err.message}`);
    try {
      execSync(`sudo rm -rf ${backupDir}`, { stdio: 'pipe' });
    } catch {
      // Ignore cleanup errors.
    }
    return null;

  } finally {
    // Always unmount.
    try {
      execSync(`sudo umount ${mountPoint} 2>/dev/null || true`, { stdio: 'pipe' });
      rmSync(mountPoint, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors.
    }
  }
}

/**
 * Restore backed up data to the data partition on the flashed device.
 */
function restoreDataPartition(device, backupDir, dryRun = false) {
  const dataPartition = `${device}4`;

  log('');
  info('Restoring data to new image...');

  if (dryRun) {
    log(`  Would mount ${dataPartition}`);
    log(`  Would restore data from ${backupDir}`);
    log(`  Would unmount`);
    return true;
  }

  const mountPoint = mkdtempSync(join(tmpdir(), 'inky-soup-data-restore-'));

  try {
    // Mount the data partition.
    info(`Mounting ${dataPartition}...`);
    execSync(`sudo mount ${dataPartition} ${mountPoint}`, { stdio: 'pipe' });

    // Restore the backup, using --fake-super to restore ownership from xattrs.
    info('Copying backed up data...');
    execSync(`sudo rsync -a --fake-super ${backupDir}/ ${mountPoint}/`, { stdio: 'pipe' });

    success('Data restored!');
    return true;

  } catch (err) {
    error(`Restore failed: ${err.message}`);
    return false;

  } finally {
    // Always try to unmount and clean up.
    try {
      info('Unmounting data partition...');
      execSync(`sudo umount ${mountPoint}`, { stdio: 'pipe' });
      rmSync(mountPoint, { recursive: true, force: true });
    } catch (err) {
      warn(`Cleanup warning: ${err.message}`);
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
// SSH Key Configuration
// ============================================================================

/**
 * Interactively select an SSH key and save to config.
 */
async function configureSSHKey() {
  log('');
  log(`${colors.bold}${colors.cyan}SSH Key Configuration${colors.reset}`);
  log('');
  info('The image uses SSH key authentication (no passwords).');
  info('Select which public key to install on the device.');
  log('');

  const keys = findSshKeys();

  if (keys.length === 0) {
    error('No SSH public keys found in ~/.ssh/');
    error('Generate one with: ssh-keygen -t ed25519');
    process.exit(1);
  }

  log(`${colors.bold}Available SSH keys:${colors.reset}`);
  log('');
  keys.forEach((key, i) => {
    log(`  ${colors.cyan}${i + 1})${colors.reset} ${key.name}`);
  });
  log('');

  const choice = await prompt(`Select key (1-${keys.length}): `);
  const index = parseInt(choice, 10) - 1;

  if (isNaN(index) || index < 0 || index >= keys.length) {
    error('Invalid selection.');
    process.exit(1);
  }

  const selectedKey = keys[index];
  const config = { ssh_key_path: selectedKey.path };

  if (saveConfig(config)) {
    success(`SSH key configured: ${selectedKey.name}`);
    info(`Config saved to: ${basename(CONFIG_FILE)}`);
  }

  return config;
}

/**
 * Get or create SSH key configuration.
 */
async function ensureSSHKeyConfig(forceReconfigure = false) {
  if (forceReconfigure) {
    return await configureSSHKey();
  }

  const config = loadConfig();
  if (config) {
    info(`Using SSH key: ${basename(config.ssh_key_path)}`);
    return config;
  }

  info('No SSH key configured yet.');
  return await configureSSHKey();
}

// ============================================================================
// SSH Key Injection
// ============================================================================

/**
 * Inject SSH key into the flashed device's rootfs.
 * Mounts partition 2 (rootfs), writes authorized_keys for root, unmounts.
 */
async function injectSSHKey(device, sshKeyPath, dryRun = false) {
  const rootfsPartition = `${device}2`;
  const sshKey = readSshKey(sshKeyPath);

  if (!sshKey) {
    throw new Error('Failed to read SSH key');
  }

  log('');
  info('Injecting SSH key into image...');

  if (dryRun) {
    log(`  Would mount ${rootfsPartition}`);
    log(`  Would write key to /root/.ssh/authorized_keys`);
    log(`  Would unmount`);
    return;
  }

  // Create temporary mount point.
  const mountPoint = mkdtempSync(join(tmpdir(), 'inky-soup-rootfs-'));

  try {
    // Mount the rootfs partition.
    info(`Mounting ${rootfsPartition}...`);
    execSync(`sudo mount ${rootfsPartition} ${mountPoint}`, { stdio: 'pipe' });

    // Create .ssh directory if needed.
    const sshDir = join(mountPoint, 'root/.ssh');
    execSync(`sudo mkdir -p ${sshDir}`, { stdio: 'pipe' });
    execSync(`sudo chmod 700 ${sshDir}`, { stdio: 'pipe' });

    // Write the SSH key.
    const authorizedKeysPath = join(sshDir, 'authorized_keys');
    info('Writing SSH key to authorized_keys...');
    execSync(`echo '${sshKey}' | sudo tee ${authorizedKeysPath} > /dev/null`, { stdio: 'pipe' });
    execSync(`sudo chmod 600 ${authorizedKeysPath}`, { stdio: 'pipe' });

    success('SSH key injected!');

  } finally {
    // Always try to unmount and clean up.
    try {
      info('Unmounting...');
      execSync(`sudo umount ${mountPoint}`, { stdio: 'pipe' });
      rmSync(mountPoint, { recursive: true, force: true });
    } catch (err) {
      warn(`Cleanup warning: ${err.message}`);
    }
  }
}

/**
 * Set hostname for the device by writing to boot partition.
 * Mounts partition 1 (boot), writes hostname.txt, unmounts.
 */
async function setHostname(device, hostname, dryRun = false) {
  const bootPartition = `${device}1`;

  log('');
  info('Setting device hostname...');

  if (dryRun) {
    log(`  Would mount ${bootPartition}`);
    log(`  Would write hostname "${hostname}" to /boot/hostname.txt`);
    log(`  Would unmount`);
    return;
  }

  // Create temporary mount point.
  const mountPoint = mkdtempSync(join(tmpdir(), 'inky-soup-boot-'));

  try {
    // Mount the boot partition.
    info(`Mounting ${bootPartition}...`);
    execSync(`sudo mount ${bootPartition} ${mountPoint}`, { stdio: 'pipe' });

    // Write the hostname.
    const hostnameFilePath = join(mountPoint, 'hostname.txt');
    info(`Writing hostname "${hostname}" to hostname.txt...`);
    execSync(`echo '${hostname}' | sudo tee ${hostnameFilePath} > /dev/null`, { stdio: 'pipe' });
    execSync(`sudo chmod 644 ${hostnameFilePath}`, { stdio: 'pipe' });

    success(`Hostname set to: ${hostname}`);

  } finally {
    // Always try to unmount and clean up.
    try {
      info('Unmounting...');
      execSync(`sudo umount ${mountPoint}`, { stdio: 'pipe' });
      rmSync(mountPoint, { recursive: true, force: true });
    } catch (err) {
      warn(`Cleanup warning: ${err.message}`);
    }
  }
}

// ============================================================================
// Flash Operation
// ============================================================================

/**
 * Flash the image to the device.
 */
async function flashImage(imagePath, bmapPath, device, isCompressed = true, dryRun = false) {
  const useBmap = hasBmaptool() && existsSync(bmapPath);

  log('');
  if (dryRun) {
    log(`${colors.bold}${colors.yellow}═══════════════════════════════════════════════════${colors.reset}`);
    log(`${colors.bold}${colors.yellow}  DRY RUN - No changes will be made${colors.reset}`);
    log(`${colors.bold}${colors.yellow}═══════════════════════════════════════════════════${colors.reset}`);
  } else {
    log(`${colors.bold}${colors.red}═══════════════════════════════════════════════════${colors.reset}`);
    log(`${colors.bold}${colors.red}  WARNING: This will ERASE ALL DATA on ${device}${colors.reset}`);
    log(`${colors.bold}${colors.red}═══════════════════════════════════════════════════${colors.reset}`);
  }
  log('');

  info(`Image: ${imagePath}`);
  info(`Target: ${device}`);
  info(`Method: ${useBmap ? 'bmaptool (fast)' : 'dd (slower)'}`);
  log('');

  if (dryRun) {
    info('Dry run complete. Would execute:');
    log('');
    log(`  sudo umount ${device}* 2>/dev/null || true`);
    if (useBmap) {
      log(`  sudo bmaptool copy --bmap "${bmapPath}" "${imagePath}" "${device}"`);
    } else if (isCompressed) {
      log(`  gunzip -c "${imagePath}" | sudo dd of="${device}" bs=4M status=progress conv=fsync`);
    } else {
      log(`  sudo dd if="${imagePath}" of="${device}" bs=4M status=progress conv=fsync`);
    }
    log(`  sync`);
    log('');
    return;
  }

  const confirm = await prompt(`Type "${device}" to confirm: `);
  if (confirm !== device) {
    error('Confirmation failed. Aborting.');
    process.exit(1);
  }

  log('');

  // Unmount any partitions on the device.
  try {
    info('Unmounting any mounted partitions...');
    execSync(`sudo umount ${device}* 2>/dev/null || true`, { stdio: 'inherit' });
  } catch {
    // Ignore unmount errors.
  }

  if (useBmap) {
    // Use bmaptool for faster flashing.
    const cmd = `sudo bmaptool copy --bmap "${bmapPath}" "${imagePath}" "${device}"`;
    info(`Running: ${cmd}`);
    log('');

    const proc = spawn('sudo', [
      'bmaptool', 'copy',
      '--bmap', bmapPath,
      imagePath,
      device,
    ], { stdio: 'inherit' });

    await new Promise((resolve, reject) => {
      proc.on('close', code => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`bmaptool exited with code ${code}`));
        }
      });
    });
  } else {
    // Fall back to dd.
    const cmd = isCompressed
      ? `gunzip -c "${imagePath}" | sudo dd of="${device}" bs=4M status=progress conv=fsync`
      : `sudo dd if="${imagePath}" of="${device}" bs=4M status=progress conv=fsync`;
    info(`Running: ${cmd}`);
    log('');

    const proc = spawn('sh', ['-c', cmd], { stdio: 'inherit' });

    await new Promise((resolve, reject) => {
      proc.on('close', code => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`dd exited with code ${code}`));
        }
      });
    });
  }

  // Final sync to ensure all writes are flushed.
  info('Syncing...');
  execSync('sync', { stdio: 'inherit' });
}

// ============================================================================
// Main Entry Point
// ============================================================================

function showHelp() {
  console.log(`
Inky Soup Yocto Flash Tool

Flash Yocto images to USB/SD cards with SSH key injection.

Usage:
  npm run flash [options]

Options:
  --device <dev>   Flash directly to device (still confirms)
  --list           List available devices and exit
  --dry-run        Show what would happen without flashing
  --reconfigure    Re-select SSH key
  -h, --help       Show this help

Examples:
  npm run flash                       # Interactive device selection
  npm run flash -- --device /dev/sdb  # Direct flash (still confirms)
  npm run flash -- --list             # Just list devices
  npm run flash -- --dry-run          # Preview without flashing

Features:
  - Injects your SSH public key for passwordless login
  - Backs up and restores /data partition (WiFi credentials, logs)
  - Remembers your key preference in .flash-config.json
`);
}

async function main() {
  const args = process.argv.slice(2);

  // Handle help.
  if (args.includes('-h') || args.includes('--help')) {
    showHelp();
    process.exit(0);
  }

  // Parse simple args.
  const listOnly = args.includes('--list');
  const dryRun = args.includes('--dry-run');
  const reconfigure = args.includes('--reconfigure');
  const deviceIndex = args.indexOf('--device');
  const specifiedDevice = deviceIndex !== -1 ? args[deviceIndex + 1] : null;

  log('');
  log(`${colors.bold}${colors.cyan}Inky Soup Yocto Flash Tool${colors.reset}`);
  if (dryRun) {
    log(`${colors.yellow}(dry-run mode - no changes will be made)${colors.reset}`);
  }
  log('');

  // Ensure we have an SSH key configured.
  const config = await ensureSSHKeyConfig(reconfigure);

  // Find image.
  const image = findLatestImage();
  if (!image) {
    error('No image found. Run "kas build kas-inky-soup.yml" first.');
    process.exit(1);
  }

  log('');
  info(`Image: ${image.name}`);
  info(`Size: ${formatBytes(image.stat.size)}`);
  info(`Built: ${image.stat.mtime.toLocaleString()}`);

  // Check for bmap file (only exists for wic images).
  const bmapPath = image.isCompressed
    ? image.path.replace('.wic.gz', '.wic.bmap')
    : image.path.replace('.rpi-sdimg', '.bmap');
  if (existsSync(bmapPath)) {
    info(`Bmap: available (faster flashing)`);
  }

  log('');

  // List devices.
  const devices = getBlockDevices();

  if (devices.length === 0) {
    warn('No suitable devices found.');
    warn('Insert an SD card or USB drive and try again.');
    process.exit(1);
  }

  log(`${colors.bold}Available devices:${colors.reset}`);
  log('');
  devices.forEach((dev, i) => {
    const rmBadge = dev.removable ? `${colors.green}[removable]${colors.reset}` : '';
    log(`  ${colors.cyan}${i + 1})${colors.reset} ${dev.device}  ${dev.size}  ${dev.model}  ${rmBadge}`);
  });
  log('');

  if (listOnly) {
    process.exit(0);
  }

  // Select device.
  let targetDevice;

  if (specifiedDevice) {
    // Verify specified device is in our list.
    const found = devices.find(d => d.device === specifiedDevice);
    if (!found) {
      error(`Device ${specifiedDevice} not found or not suitable for flashing.`);
      process.exit(1);
    }
    targetDevice = specifiedDevice;
  } else {
    // Interactive selection.
    const choice = await prompt(`Select device (1-${devices.length}) or 'q' to quit: `);

    if (choice.toLowerCase() === 'q') {
      info('Aborted.');
      process.exit(0);
    }

    const index = parseInt(choice, 10) - 1;
    if (isNaN(index) || index < 0 || index >= devices.length) {
      error('Invalid selection.');
      process.exit(1);
    }

    targetDevice = devices[index].device;
  }

  // Prompt for hostname (interactive mode only).
  let hostname = 'inky-soup';
  if (!specifiedDevice && !dryRun) {
    log('');
    const hostnameInput = await prompt(`Device hostname (default: ${hostname}): `);
    if (hostnameInput && hostnameInput.trim()) {
      // Validate hostname.
      const cleaned = hostnameInput.trim();
      if (/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(cleaned)) {
        hostname = cleaned;
      } else {
        warn(`Invalid hostname "${cleaned}", using default: ${hostname}`);
      }
    }

    // Save hostname to config for use by update.mjs verification.
    config.hostname = hostname;
    saveConfig(config);
  }

  // Check if we can backup /data from the disk before flashing.
  let backupDir = null;
  if (!dryRun && hasDataPartition(targetDevice)) {
    log('');
    info(`Found existing data partition on ${targetDevice}4`);
    const doBackup = await prompt('Backup /data before flashing? (Y/n): ');
    if (doBackup.toLowerCase() !== 'n') {
      backupDir = backupDataPartition(targetDevice);
      if (!backupDir) {
        const continueAnyway = await prompt('Continue without backup? (y/N): ');
        if (continueAnyway.toLowerCase() !== 'y') {
          info('Aborted.');
          process.exit(0);
        }
      }
    }
  }

  // Flash!
  try {
    await flashImage(image.path, bmapPath, targetDevice, image.isCompressed, dryRun);

    // Inject SSH key after flashing.
    await injectSSHKey(targetDevice, config.ssh_key_path, dryRun);

    // Set hostname.
    await setHostname(targetDevice, hostname, dryRun);

    // Restore /data if we have a backup.
    if (backupDir) {
      restoreDataPartition(targetDevice, backupDir, dryRun);
      cleanupBackup(backupDir);
    }

    log('');
    if (dryRun) {
      success('Dry run complete!');
      info('Run without --dry-run to actually flash.');
    } else {
      log(`${colors.bold}${colors.green}═══════════════════════════════════════════════════${colors.reset}`);
      success('Flash complete!');
      if (backupDir) {
        success('/data restored - WiFi credentials preserved!');
      }
      log(`${colors.bold}${colors.green}═══════════════════════════════════════════════════${colors.reset}`);
      log('');
      info('You can now eject the drive and boot your Raspberry Pi.');
      info(`Login: ssh inky@${hostname}.local`);
      info(`SSH key: ${basename(config.ssh_key_path)}`);
    }
  } catch (err) {
    // Clean up backup on failure.
    cleanupBackup(backupDir);
    log('');
    error(`Flash failed: ${err.message}`);
    process.exit(1);
  }
}

main().catch(err => {
  error(err.message);
  process.exit(1);
});
