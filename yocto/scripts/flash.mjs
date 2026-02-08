#!/usr/bin/env node
/**
 * Flash script for Inky Soup Yocto images.
 *
 * Uses shared utilities from sparkle-duck-shared (pi-base submodule).
 *
 * Features:
 * - Flashes Yocto image to USB/SD card.
 * - Injects your SSH public key for passwordless login.
 * - Prompts for WiFi credentials and injects them for first-boot connectivity.
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

import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

// Import shared utilities from pi-base.
import {
  colors,
  log,
  info,
  success,
  warn,
  error,
  prompt,
  formatBytes,
  loadConfig,
  saveConfig,
  configureSSHKey,
  injectSSHKey,
  hasDataPartition,
  backupDataPartition,
  restoreDataPartition,
  cleanupBackup,
  setHostname,
  getBlockDevices,
  findLatestImage,
  flashImage,
  getWifiCredentials,
  injectWifiCredentials,
} from '../pi-base/scripts/lib/index.mjs';

// Project-specific configuration.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const YOCTO_DIR = dirname(__dirname);
const CONFIG_FILE = join(YOCTO_DIR, '.flash-config.json');
const WIFI_CREDS_FILE = join(YOCTO_DIR, 'wifi-creds.local');
const DEFAULT_HOSTNAME = 'inky-soup';
const IMAGE_SUFFIX = '.wic.gz';

// Machine definitions.
const MACHINES = {
  zero1: {
    id: 'zero1',
    name: 'Pi Zero W',
    machine: 'raspberrypi0-wifi',
    imageDir: join(YOCTO_DIR, 'build/tmp/deploy/images/raspberrypi0-wifi'),
    preferredImages: [
      'inky-soup-image-raspberrypi0-wifi.rootfs.wic.gz',
      'inky-soup-image-raspberrypi0-wifi.wic.gz',
    ],
  },
  zero2: {
    id: 'zero2',
    name: 'Pi Zero 2 W',
    machine: 'raspberrypi0-2w',
    imageDir: join(YOCTO_DIR, 'build/tmp/deploy/images/raspberrypi0-2w'),
    preferredImages: [
      'inky-soup-image-raspberrypi0-2w.rootfs.wic.gz',
      'inky-soup-image-raspberrypi0-2w.wic.gz',
    ],
  },
};

// User configuration - matches what's created in inky-soup-image.bb.
const SSH_USERNAME = 'inky';
const SSH_UID = 1000;

/**
 * Prompt user to select a machine.
 */
async function selectMachine() {
  log('');
  log(`${colors.bold}Select target machine:${colors.reset}`);
  log('');
  log(`  ${colors.cyan}1)${colors.reset} ${MACHINES.zero1.name}`);
  log(`  ${colors.cyan}2)${colors.reset} ${MACHINES.zero2.name}`);
  log('');

  const choice = await prompt('Choice (1-2): ');

  if (choice === '1') return 'zero1';
  if (choice === '2') return 'zero2';

  error('Invalid selection.');
  process.exit(1);
}

/**
 * Get machine from config or args.
 */
async function getMachine(args, config) {
  // Check for command-line override.
  if (args.includes('--zero1')) return MACHINES.zero1;
  if (args.includes('--zero2')) return MACHINES.zero2;

  // Check for saved preference.
  if (config && config.machine && MACHINES[config.machine]) {
    info(`Using saved machine: ${MACHINES[config.machine].name}`);
    return MACHINES[config.machine];
  }

  // Prompt user.
  const selected = await selectMachine();

  // Ask to save preference.
  const saveChoice = await prompt('Save as default? (Y/n): ');
  if (saveChoice.toLowerCase() !== 'n') {
    config.machine = selected;
    saveConfig(CONFIG_FILE, config);
    success(`Saved ${MACHINES[selected].name} as default.`);
  }

  return MACHINES[selected];
}

/**
 * Get or create SSH key configuration.
 */
async function ensureSSHKeyConfig(forceReconfigure = false) {
  if (forceReconfigure) {
    return await configureSSHKey(CONFIG_FILE);
  }

  const config = loadConfig(CONFIG_FILE);
  if (config) {
    info(`Using SSH key: ${basename(config.ssh_key_path)}`);
    return config;
  }

  info('No SSH key configured yet.');
  return await configureSSHKey(CONFIG_FILE);
}

function showHelp() {
  console.log(`
Inky Soup Yocto Flash Tool

Flash Yocto images to USB/SD cards with SSH key injection.

Usage:
  npm run flash [options]

Options:
  --zero1          Flash Pi Zero W image
  --zero2          Flash Pi Zero 2 W image
  --device <dev>   Flash directly to device (still confirms)
  --list           List available devices and exit
  --dry-run        Show what would happen without flashing
  --reconfigure    Re-select SSH key
  -h, --help       Show this help

Examples:
  npm run flash                       # Interactive device selection
  npm run flash -- --zero1            # Flash Pi Zero W image
  npm run flash -- --device /dev/sdb  # Direct flash (still confirms)
  npm run flash -- --list             # Just list devices
  npm run flash -- --dry-run          # Preview without flashing

Features:
  - Supports Pi Zero W and Pi Zero 2 W (saves preference)
  - Injects your SSH public key for passwordless login
  - Prompts for WiFi credentials for first-boot connectivity
  - Backs up and restores /data partition (WiFi credentials, logs)
  - Remembers preferences in .flash-config.json
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

  // Get target machine.
  const machine = await getMachine(args, config);
  info(`Target: ${machine.name}`);

  // Find image.
  const image = findLatestImage(machine.imageDir, IMAGE_SUFFIX, machine.preferredImages);
  if (!image) {
    error(`No image found for ${machine.name}. Run "npm run build" first.`);
    process.exit(1);
  }

  log('');
  info(`Image: ${image.name}`);
  info(`Size: ${formatBytes(image.stat.size)}`);
  info(`Built: ${image.stat.mtime.toLocaleString()}`);

  // Check for bmap file.
  const bmapPath = image.path.replace('.wic.gz', '.wic.bmap');
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

  // Prompt for hostname.
  let hostname = DEFAULT_HOSTNAME;
  if (!specifiedDevice && !dryRun) {
    log('');
    const hostnameInput = await prompt(`Device hostname (default: ${hostname}): `);
    if (hostnameInput && hostnameInput.trim()) {
      const cleaned = hostnameInput.trim();
      if (/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(cleaned)) {
        hostname = cleaned;
      } else {
        warn(`Invalid hostname "${cleaned}", using default: ${hostname}`);
      }
    }

    // Save hostname to config.
    config.hostname = hostname;
    saveConfig(CONFIG_FILE, config);
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

  // Get WiFi credentials (from file or prompt) unless restoring from backup.
  let wifiCredentials = null;
  if (!dryRun && !backupDir) {
    wifiCredentials = await getWifiCredentials(WIFI_CREDS_FILE);
  }

  // Flash!
  try {
    await flashImage(image.path, targetDevice, {
      dryRun,
      bmapPath: existsSync(bmapPath) ? bmapPath : null,
    });

    // Inject SSH key after flashing.
    await injectSSHKey(targetDevice, config.ssh_key_path, SSH_USERNAME, SSH_UID, dryRun);

    // Set hostname.
    await setHostname(targetDevice, hostname, dryRun);

    // Inject WiFi credentials if provided (and not restoring a backup).
    if (wifiCredentials && !backupDir) {
      await injectWifiCredentials(
        targetDevice,
        wifiCredentials.ssid,
        wifiCredentials.password,
        dryRun
      );
    }

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
      } else if (wifiCredentials) {
        success(`WiFi "${wifiCredentials.ssid}" configured!`);
      }
      log(`${colors.bold}${colors.green}═══════════════════════════════════════════════════${colors.reset}`);
      log('');
      info('You can now eject the drive and boot your Raspberry Pi.');
      info(`Login: ssh ${SSH_USERNAME}@${hostname}.local`);
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
