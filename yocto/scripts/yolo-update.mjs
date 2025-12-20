#!/usr/bin/env node
/**
 * YOLO remote update - push image over network and dd directly to disk.
 *
 * This is the "hold my mead" approach: we scp the image to the Pi,
 * verify the checksum, then dd it to the boot disk while running.
 * If it works, great! If not, pull the disk and reflash.
 *
 * Usage:
 *   npm run yolo                    # Build + push + flash + reboot
 *   npm run yolo -- --clean         # Force rebuild (cleans image sstate)
 *   npm run yolo -- --clean-all     # Force full rebuild (cleans server + image)
 *   npm run yolo -- --skip-build    # Push existing image (skip kas build)
 *   npm run yolo -- --dry-run       # Show what would happen
 *   npm run yolo -- --help          # Show help
 */

import { execSync, spawn } from 'child_process';
import { existsSync, statSync, readFileSync, readdirSync, createReadStream, mkdtempSync, unlinkSync, rmSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import { createHash } from 'crypto';
import { tmpdir } from 'os';
import { createConsola } from 'consola';

// Custom reporter with detailed timestamps (HH:MM:SS.mmm).
const timestampReporter = {
  log(logObj) {
    const d = new Date(logObj.date);
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const seconds = String(d.getSeconds()).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    const timestamp = `${hours}:${minutes}:${seconds}.${ms}`;

    // Badge based on type.
    const badge = logObj.type === 'success' ? '✔' :
                  logObj.type === 'error' ? '✖' :
                  logObj.type === 'warn' ? '⚠' :
                  logObj.type === 'info' ? 'ℹ' :
                  logObj.type === 'start' ? '▶' : ' ';

    // Color based on type.
    const color = logObj.type === 'success' ? '\x1b[32m' :
                  logObj.type === 'error' ? '\x1b[31m' :
                  logObj.type === 'warn' ? '\x1b[33m' :
                  logObj.type === 'info' ? '\x1b[36m' : '';

    const reset = '\x1b[0m';
    const dim = '\x1b[2m';

    console.log(`${dim}[${timestamp}]${reset} ${color}${badge}${reset} ${logObj.args.join(' ')}`);
  },
};

const consola = createConsola({
  reporters: [timestampReporter],
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const YOCTO_DIR = dirname(__dirname);
const IMAGE_DIR = join(YOCTO_DIR, 'build/tmp/deploy/images/raspberrypi-inky-soup');
const CONFIG_FILE = join(YOCTO_DIR, '.flash-config.json');

// Remote target configuration.
const REMOTE_HOST = 'inky-soup.local';
const REMOTE_USER = 'inky';
const REMOTE_TARGET = `${REMOTE_USER}@${REMOTE_HOST}`;
const REMOTE_DEVICE = '/dev/sda';
const REMOTE_TMP = '/tmp';

// Colors for terminal output (still needed for some custom formatting).
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
};

// Wrap consola for our needs.
const log = (msg) => console.log(msg);
const info = (msg) => consola.info(msg);
const success = (msg) => consola.success(msg);
const warn = (msg) => consola.warn(msg);
const error = (msg) => consola.error(msg);

function banner(title) {
  consola.box(title);
}

function skull() {
  log('');
  log(`${colors.yellow}    ☠️  YOLO MODE - NO SAFETY NET  ☠️${colors.reset}`);
  log(`${colors.dim}    If this fails, pull the disk and reflash.${colors.reset}`);
  log('');
}

// ============================================================================
// Signal Handling and Cleanup
// ============================================================================

// Track resources for cleanup on Ctrl+C.
let activeLoopDevice = null;
let activeMountPoint = null;
let activeTempDir = null;
let inCriticalSection = false;

function emergencyCleanup() {
  // If we're in the critical section (dd running), refuse to exit.
  if (inCriticalSection) {
    log('');
    log(`${colors.bold}${colors.red}═══════════════════════════════════════════════════════════════${colors.reset}`);
    log(`${colors.bold}${colors.red}  ⚠️  CANNOT INTERRUPT - dd IS WRITING TO DISK!${colors.reset}`);
    log(`${colors.bold}${colors.red}  Ctrl+C disabled to prevent disk corruption.${colors.reset}`);
    log(`${colors.bold}${colors.red}  Wait for reboot to complete...${colors.reset}`);
    log(`${colors.bold}${colors.red}═══════════════════════════════════════════════════════════════${colors.reset}`);
    log('');
    return; // Don't exit!
  }

  log('');
  warn('Ctrl+C detected - cleaning up...');

  try {
    if (activeMountPoint) {
      info(`Unmounting ${activeMountPoint}...`);
      execSync(`sudo umount ${activeMountPoint} 2>/dev/null || true`, { stdio: 'pipe' });
    }
    if (activeLoopDevice) {
      info(`Detaching ${activeLoopDevice}...`);
      execSync(`sudo losetup -d ${activeLoopDevice} 2>/dev/null || true`, { stdio: 'pipe' });
    }
    if (activeTempDir) {
      info(`Removing temp directory...`);
      execSync(`rm -rf ${activeTempDir}`, { stdio: 'pipe' });
    }
    success('Cleanup complete.');
  } catch (err) {
    error(`Cleanup failed: ${err.message}`);
  }

  log('');
  process.exit(130); // Standard exit code for SIGINT.
}

// Handle Ctrl+C gracefully.
process.on('SIGINT', emergencyCleanup);

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
 * Run a command with inherited stdio.
 */
async function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: 'inherit', cwd: YOCTO_DIR, ...options });
    proc.on('close', code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${cmd} exited with code ${code}`));
      }
    });
    proc.on('error', reject);
  });
}

/**
 * Run a command and capture output.
 */
function runCapture(cmd, options = {}) {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: 'pipe', ...options }).trim();
  } catch (err) {
    return null;
  }
}

/**
 * Run a command on the remote host via SSH.
 */
function ssh(command, options = {}) {
  const sshCmd = `ssh -o ConnectTimeout=5 -o BatchMode=yes ${REMOTE_TARGET} "${command}"`;
  return runCapture(sshCmd, options);
}

/**
 * Run a command on the remote host via SSH, with inherited stdio for progress.
 */
async function sshRun(command) {
  return run('ssh', [
    '-o', 'ConnectTimeout=10',
    '-o', 'BatchMode=yes',
    REMOTE_TARGET,
    command,
  ]);
}

/**
 * Calculate SHA256 checksum of a file.
 */
async function calculateChecksum(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);

    stream.on('data', data => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// ============================================================================
// SSH Key Configuration
// ============================================================================

/**
 * Load flash configuration from .flash-config.json.
 */
function loadConfig() {
  try {
    if (!existsSync(CONFIG_FILE)) {
      return null;
    }
    const content = readFileSync(CONFIG_FILE, 'utf-8');
    const config = JSON.parse(content);
    if (!config.ssh_key_path || !existsSync(config.ssh_key_path)) {
      return null;
    }
    return config;
  } catch {
    return null;
  }
}

// ============================================================================
// Image Preparation (Local Customization)
// ============================================================================

/**
 * Extract rootfs partition from .wic image and inject SSH key.
 * For A/B updates, we only need the rootfs partition.
 * Returns path to the prepared rootfs image (ext4.gz).
 */
async function prepareRootfs(imagePath, config) {
  banner('Extracting and preparing rootfs...');

  const workDir = mkdtempSync(join(tmpdir(), 'yolo-rootfs-'));
  activeTempDir = workDir;
  const wicPath = join(workDir, 'image.wic');
  const rootfsRaw = join(workDir, 'rootfs.ext4');
  const mountPoint = join(workDir, 'mnt');
  const preparedRootfsPath = join(workDir, 'rootfs.ext4.gz');

  try {
    // Decompress image.
    info('Decompressing image...');
    execSync(`gunzip -c "${imagePath}" > "${wicPath}"`, { stdio: 'pipe' });

    // Set up loop device with partition scanning.
    info('Setting up loop device...');
    const loopDevice = execSync(`sudo losetup -fP --show "${wicPath}"`, {
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
    activeLoopDevice = loopDevice;

    try {
      // Extract partition 2 (rootfs_a) - this is what we'll flash to inactive slot.
      info('Extracting rootfs partition...');
      const rootfsPartition = `${loopDevice}p2`;

      // Use dd to extract just the rootfs partition to a file.
      execSync(`sudo dd if="${rootfsPartition}" of="${rootfsRaw}" bs=4M`, { stdio: 'pipe' });

      // Now mount the extracted rootfs to inject SSH key.
      const rootfsLoop = execSync(`sudo losetup -f --show "${rootfsRaw}"`, {
        encoding: 'utf-8',
        stdio: 'pipe',
      }).trim();

      try {
        execSync(`mkdir -p "${mountPoint}"`, { stdio: 'pipe' });
        info('Mounting extracted rootfs...');
        execSync(`sudo mount "${rootfsLoop}" "${mountPoint}"`, { stdio: 'pipe' });
        activeMountPoint = mountPoint;

        try {
          // Inject SSH key.
          if (config && config.ssh_key_path) {
            info(`Injecting SSH key: ${basename(config.ssh_key_path)}`);
            const sshKey = readFileSync(config.ssh_key_path, 'utf-8').trim();
            const authorizedKeysPath = join(mountPoint, 'home/inky/.ssh/authorized_keys');

            execSync(`echo '${sshKey}' | sudo tee "${authorizedKeysPath}" > /dev/null`, { stdio: 'pipe' });
            execSync(`sudo chmod 600 "${authorizedKeysPath}"`, { stdio: 'pipe' });
            execSync(`sudo chown 1000:1000 "${authorizedKeysPath}"`, { stdio: 'pipe' });
            success('SSH key injected!');
          }

        } finally {
          // Unmount.
          info('Unmounting...');
          execSync(`sudo umount "${mountPoint}"`, { stdio: 'pipe' });
          activeMountPoint = null;
        }

        // Sync and detach rootfs loop device.
        execSync('sync', { stdio: 'pipe' });
        execSync(`sudo losetup -d "${rootfsLoop}"`, { stdio: 'pipe' });

      } catch (err) {
        // Cleanup rootfs loop on error.
        execSync(`sudo losetup -d "${rootfsLoop}" 2>/dev/null || true`, { stdio: 'pipe' });
        throw err;
      }

    } finally {
      // Detach main loop device.
      info('Detaching loop device...');
      execSync(`sudo losetup -d "${loopDevice}"`, { stdio: 'pipe' });
      activeLoopDevice = null;
    }

    // Compress the rootfs.
    info('Compressing rootfs...');
    execSync(`gzip -c "${rootfsRaw}" > "${preparedRootfsPath}"`, { stdio: 'pipe' });

    // Clean up.
    unlinkSync(wicPath);
    unlinkSync(rootfsRaw);
    rmSync(mountPoint, { recursive: true, force: true });

    success('Rootfs prepared!');
    return { preparedRootfsPath, workDir };

  } catch (err) {
    // Clean up on error.
    try {
      execSync(`sudo umount "${mountPoint}" 2>/dev/null || true`, { stdio: 'pipe' });
      execSync(`sudo losetup -D 2>/dev/null || true`, { stdio: 'pipe' });
      if (existsSync(wicPath)) unlinkSync(wicPath);
      if (existsSync(rootfsRaw)) unlinkSync(rootfsRaw);
      if (existsSync(mountPoint)) rmSync(mountPoint, { recursive: true, force: true });
      if (existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors.
    }
    throw err;
  }
}

/**
 * Clean up prepared image temp files.
 */
function cleanupPreparedImage(workDir) {
  try {
    execSync(`rm -rf "${workDir}"`, { stdio: 'pipe' });
  } catch {
    warn(`Failed to clean up temp directory: ${workDir}`);
  }
}

// ============================================================================
// Image Discovery
// ============================================================================

/**
 * Find the latest .wic.gz image file.
 */
function findLatestImage() {
  if (!existsSync(IMAGE_DIR)) {
    return null;
  }

  const files = readdirSync(IMAGE_DIR)
    .filter(f => f.endsWith('.wic.gz') && !f.includes('->'))
    .map(f => ({
      name: f,
      path: join(IMAGE_DIR, f),
      stat: statSync(join(IMAGE_DIR, f)),
    }))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

  // Prefer our custom image.
  const inkySoupImage = files.find(f => f.name === 'inky-soup-image-raspberrypi-inky-soup.rootfs.wic.gz');
  if (inkySoupImage) {
    return inkySoupImage;
  }

  return files[0] || null;
}

// ============================================================================
// Pre-flight Checks
// ============================================================================

/**
 * Check if the remote host is reachable.
 */
function checkRemoteReachable() {
  info(`Checking if ${REMOTE_HOST} is reachable...`);

  const result = runCapture(`ping -c 1 -W 2 ${REMOTE_HOST}`);
  if (result === null) {
    return false;
  }

  // Also check SSH.
  const sshResult = ssh('echo ok');
  return sshResult === 'ok';
}

/**
 * Get available space in /tmp on remote (in bytes).
 * Uses -k flag for BusyBox compatibility (returns KB).
 */
function getRemoteTmpSpace() {
  // Use awk with escaped braces for SSH.
  const result = ssh("df -k " + REMOTE_TMP + " | tail -1 | awk '{ print \\$4 }'");
  if (result) {
    const kb = parseInt(result, 10);
    if (!isNaN(kb)) {
      // Result is in KB, convert to bytes.
      return kb * 1024;
    }
  }
  return 0;
}

/**
 * Get the boot device on the remote system.
 */
function getRemoteBootDevice() {
  // Find what device / is mounted from.
  const result = ssh(`mount | grep ' / ' | cut -d' ' -f1 | sed 's/[0-9]*$//'`);
  return result || REMOTE_DEVICE;
}

// ============================================================================
// Build Phase
// ============================================================================

/**
 * Clean the image sstate to force a rebuild.
 */
async function cleanImage() {
  info('Cleaning inky-soup-image sstate to force rebuild...');
  await run('kas', ['shell', 'kas-inky-soup.yml', '-c', 'bitbake -c cleansstate inky-soup-image']);
  success('Clean complete!');
}

/**
 * Clean both server and image sstate for a full rebuild.
 */
async function cleanAll() {
  info('Cleaning inky-soup-server and inky-soup-image sstate...');
  await run('kas', ['shell', 'kas-inky-soup.yml', '-c', 'bitbake -c cleansstate inky-soup-server inky-soup-image']);
  success('Clean complete!');
}

/**
 * Run the Yocto build.
 */
async function build(forceClean = false, forceCleanAll = false) {
  banner('Building inky-soup-image...');

  if (forceCleanAll) {
    await cleanAll();
  } else if (forceClean) {
    await cleanImage();
  }

  await run('kas', ['build', 'kas-inky-soup.yml']);
  success('Build complete!');
}

// ============================================================================
// Transfer Phase
// ============================================================================

/**
 * Transfer image to remote host.
 */
async function transferImage(imagePath, checksum, dryRun = false) {
  const imageName = basename(imagePath);
  const remoteImagePath = `${REMOTE_TMP}/${imageName}`;
  const remoteChecksumPath = `${REMOTE_TMP}/${imageName}.sha256`;

  banner('Transferring image to Pi...');

  info(`Source: ${imageName}`);
  info(`Target: ${REMOTE_TARGET}:${remoteImagePath}`);
  log('');

  if (dryRun) {
    log(`${colors.yellow}DRY RUN - would execute:${colors.reset}`);
    log(`  scp ${imagePath} ${REMOTE_TARGET}:${remoteImagePath}`);
    log('');
    return { remoteImagePath, remoteChecksumPath };
  }

  // Transfer the image with progress.
  await run('scp', [
    '-o', 'ConnectTimeout=10',
    '-o', 'BatchMode=yes',
    imagePath,
    `${REMOTE_TARGET}:${remoteImagePath}`,
  ]);

  success('Image transferred!');

  // Write checksum file on remote.
  info('Writing checksum file...');
  ssh(`echo '${checksum}  ${imageName}' > ${remoteChecksumPath}`);

  return { remoteImagePath, remoteChecksumPath };
}

/**
 * Verify checksum on remote host.
 */
function verifyRemoteChecksum(remoteImagePath, remoteChecksumPath) {
  info('Verifying checksum on Pi...');

  const result = ssh(`cd ${REMOTE_TMP} && sha256sum -c ${basename(remoteChecksumPath)}`);

  if (result && result.includes('OK')) {
    success('Checksum verified!');
    return true;
  }

  error('Checksum verification failed!');
  return false;
}

// ============================================================================
// Flash Phase (The YOLO Part)
// ============================================================================

/**
 * Flash the image on the remote host.
 * This is the point of no return.
 */
async function remoteFlash(remoteImagePath, device, dryRun = false, skipConfirm = false) {
  banner('Flashing image on Pi...');
  skull();

  if (dryRun) {
    log(`${colors.yellow}DRY RUN - would execute:${colors.reset}`);
    log('');
    log(`  # A/B Update using ab-update helper`);
    log(`  ab-update ${remoteImagePath}`);
    log('');
    log(`  # Reboot to activate new slot`);
    log(`  sudo systemctl reboot`);
    log('');
    return;
  }

  // Final confirmation.
  log(`${colors.bold}${colors.red}═══════════════════════════════════════════════════════════════${colors.reset}`);
  log(`${colors.bold}${colors.red}  THIS WILL OVERWRITE ${device} ON ${REMOTE_HOST}${colors.reset}`);
  log(`${colors.bold}${colors.red}  The system may become unresponsive during the write.${colors.reset}`);
  log(`${colors.bold}${colors.red}  If it fails, you'll need to pull the disk and reflash.${colors.reset}`);
  log(`${colors.bold}${colors.red}═══════════════════════════════════════════════════════════════${colors.reset}`);
  log('');

  if (!skipConfirm) {
    const confirm = await prompt(`Type "yolo" to proceed: `);
    if (confirm.toLowerCase() !== 'yolo') {
      error('Aborted.');
      process.exit(1);
    }
  } else {
    log(`${colors.yellow}🍺 Hold my mead... here we go!${colors.reset}`);
  }

  // ENTERING CRITICAL SECTION - Ctrl+C disabled from here.
  inCriticalSection = true;

  log('');
  info('Running A/B update on Pi...');
  log('');

  // Run ab-update which flashes to inactive partition and switches boot slot.
  // This is SAFE because we're writing to the inactive partition, not the running one.
  try {
    const updateCmd = `ab-update ${remoteImagePath}`;
    await sshRun(updateCmd);

    success('A/B update complete!');
    log('');
    info('Rebooting to activate new rootfs...');

    // Reboot to new slot.
    ssh('sudo systemctl reboot');

  } catch (err) {
    error(`A/B update failed: ${err.message}`);
    throw err;
  }

  // Give it a moment to start rebooting.
  await new Promise(resolve => setTimeout(resolve, 2000));
}

// ============================================================================
// Wait for Reboot
// ============================================================================

/**
 * Get the boot time of the remote system (seconds since epoch).
 */
function getRemoteBootTime() {
  // Use /proc/stat btime which is boot time in seconds since epoch.
  const result = ssh("awk '/btime/ {print \\$2}' /proc/stat");
  if (result) {
    const btime = parseInt(result, 10);
    if (!isNaN(btime)) {
      return btime;
    }
  }
  return 0;
}

/**
 * Wait for the device to come back online after a reboot.
 * Verifies that the system actually rebooted by checking boot time.
 */
async function waitForReboot(originalBootTime, timeoutSec = 120) {
  banner('Waiting for Pi to reboot...');

  const startTime = Date.now();
  const timeoutMs = timeoutSec * 1000;
  let dots = 0;
  let sawOffline = false;

  // Wait a bit for the system to go down.
  info('Waiting for shutdown...');

  while (Date.now() - startTime < timeoutMs) {
    process.stdout.write(`\r  Waiting${'.'.repeat(dots % 4).padEnd(4)} (${Math.floor((Date.now() - startTime) / 1000)}s)`);
    dots++;

    const sshResult = ssh('echo ok');

    if (sshResult !== 'ok') {
      // System is offline.
      if (!sawOffline) {
        process.stdout.write('\r' + ' '.repeat(50) + '\r');
        info('System went offline...');
        sawOffline = true;
      }
    } else if (sawOffline) {
      // System came back - verify it actually rebooted.
      const newBootTime = getRemoteBootTime();
      if (newBootTime > originalBootTime) {
        process.stdout.write('\r' + ' '.repeat(50) + '\r');
        success(`${REMOTE_HOST} is back online!`);
        info(`Boot time changed: ${originalBootTime} -> ${newBootTime}`);
        return true;
      } else {
        // Same boot time - didn't actually reboot!
        process.stdout.write('\r' + ' '.repeat(50) + '\r');
        warn('System responded but boot time unchanged - reboot may have failed!');
        return false;
      }
    }

    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  process.stdout.write('\r' + ' '.repeat(50) + '\r');

  // Final check - maybe it rebooted quickly before we noticed it went offline.
  const finalBootTime = getRemoteBootTime();
  if (finalBootTime > originalBootTime) {
    success(`${REMOTE_HOST} is back online!`);
    info(`Boot time changed: ${originalBootTime} -> ${finalBootTime}`);
    return true;
  }

  warn(`Timeout waiting for reboot after ${timeoutSec}s`);
  if (finalBootTime === originalBootTime) {
    error('Boot time unchanged - reboot did NOT happen!');
  }
  return false;
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main() {
  const args = process.argv.slice(2);

  const skipBuild = args.includes('--skip-build');
  const forceClean = args.includes('--clean');
  const forceCleanAll = args.includes('--clean-all');
  const dryRun = args.includes('--dry-run');
  const holdMyMead = args.includes('--hold-my-mead');

  if (args.includes('-h') || args.includes('--help')) {
    log('Usage: npm run yolo [options]');
    log('');
    log('Push a Yocto image to the Pi over the network and flash it live.');
    log('');
    log('Options:');
    log('  --skip-build     Skip kas build, use existing image');
    log('  --clean          Force rebuild by cleaning image sstate first');
    log('  --clean-all      Force full rebuild (cleans server + image sstate)');
    log('  --dry-run        Show what would happen without doing it');
    log('  --hold-my-mead   Skip confirmation prompt (for scripts)');
    log('  -h, --help       Show this help');
    log('');
    log('This is the YOLO approach - if it fails, pull the disk and reflash.');
    process.exit(0);
  }

  log('');
  log(`${colors.bold}${colors.cyan}Inky Soup YOLO Update${colors.reset}`);
  if (dryRun) {
    log(`${colors.yellow}(dry-run mode - no changes will be made)${colors.reset}`);
  }
  skull();

  // Pre-flight checks.
  if (!checkRemoteReachable()) {
    error(`Cannot reach ${REMOTE_HOST}`);
    error('Make sure the Pi is running and accessible via SSH.');
    process.exit(1);
  }
  success(`${REMOTE_HOST} is reachable`);

  // Heat up sudo access for the deploy later.
  execSync(`sudo echo "I'm sudo"`, { stdio: 'pipe' });

  // Detect boot device.
  const bootDevice = getRemoteBootDevice();
  info(`Boot device: ${bootDevice}`);

  // Build phase.
  if (!skipBuild) {
    await build(forceClean, forceCleanAll);
  }

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

  // Load SSH key config for image customization.
  const config = loadConfig();
  if (!config) {
    warn('No SSH key configured. Run "npm run flash -- --reconfigure" first.');
    warn('Image will be flashed without SSH key - you may be locked out!');
    const proceed = await prompt('Continue anyway? (y/N): ');
    if (proceed.toLowerCase() !== 'y') {
      error('Aborted.');
      process.exit(1);
    }
  } else {
    info(`SSH key: ${basename(config.ssh_key_path)}`);
  }

  // Extract rootfs and inject SSH key.
  let rootfsToTransfer = image.path;
  let workDir = null;

  if (!dryRun && config) {
    const prepared = await prepareRootfs(image.path, config);
    rootfsToTransfer = prepared.preparedRootfsPath;
    workDir = prepared.workDir;
  }

  try {
    // Get the size of the prepared rootfs.
    const rootfsSize = statSync(rootfsToTransfer).size;

    // Check remote has enough space.
    const remoteSpace = getRemoteTmpSpace();
    if (remoteSpace < rootfsSize) {
      error(`Not enough space in ${REMOTE_TMP} on ${REMOTE_HOST}`);
      error(`Need: ${formatBytes(rootfsSize)}, Have: ${formatBytes(remoteSpace)}`);
      process.exit(1);
    }
    success(`Remote has enough space (${formatBytes(remoteSpace)} available)`);

    // Calculate checksum of prepared rootfs.
    info('Calculating checksum...');
    const checksum = await calculateChecksum(rootfsToTransfer);
    success(`Checksum: ${checksum.substring(0, 16)}...`);

    // Transfer.
    const { remoteImagePath, remoteChecksumPath } = await transferImage(rootfsToTransfer, checksum, dryRun);

    // Verify (skip in dry-run since we didn't actually transfer).
    if (!dryRun) {
      if (!verifyRemoteChecksum(remoteImagePath, remoteChecksumPath)) {
        error('Transfer corrupted! Aborting.');
        process.exit(1);
      }
    }

    // Flash!
    await remoteFlash(remoteImagePath, bootDevice, dryRun, holdMyMead);

    if (!dryRun) {
      // Wait for reboot.
      const online = await waitForReboot(120);

      // EXITING CRITICAL SECTION - Ctrl+C re-enabled.
      inCriticalSection = false;

      log('');
      if (online) {
        log(`${colors.bold}${colors.green}════════════════════════════════════════════════════════════════${colors.reset}`);
        success('YOLO update complete!');
        info(`Connect with: ssh ${REMOTE_TARGET}`);
        log(`${colors.bold}${colors.green}════════════════════════════════════════════════════════════════${colors.reset}`);
      } else {
        log(`${colors.bold}${colors.yellow}════════════════════════════════════════════════════════════════${colors.reset}`);
        warn('Pi did not come back online within timeout.');
        warn('It may still be booting, or you may need to reflash.');
        log(`${colors.bold}${colors.yellow}════════════════════════════════════════════════════════════════${colors.reset}`);
      }
    } else {
      log('');
      log(`${colors.bold}${colors.green}════════════════════════════════════════════════════════════════${colors.reset}`);
      success('Dry run complete!');
      info('Run without --dry-run to actually flash.');
      log(`${colors.bold}${colors.green}════════════════════════════════════════════════════════════════${colors.reset}`);
    }

    log('');

  } finally {
    // Clean up prepared image temp files.
    if (workDir) {
      cleanupPreparedImage(workDir);
      activeTempDir = null;
    }
  }
}

main().catch(err => {
  error(err.message);
  process.exit(1);
});
