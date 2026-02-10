#!/usr/bin/env node
/**
 * YOLO remote update - content-based A/B partition update.
 *
 * Streams rootfs content directly to the inactive partition, no staging required.
 * Uses ab-boot-manager to switch boot slots after update.
 *
 * Usage:
 *   npm run yolo                    # Build + push + flash + reboot
 *   npm run yolo -- --fast          # Fast deploy (app-only, no reboot)
 *   npm run yolo -- --clean         # Force rebuild (image; in --fast mode: server)
 *   npm run yolo -- --clean-all     # Force full rebuild (server+image; in --fast mode: server)
 *   npm run yolo -- --skip-build    # Push existing image (skip kas build)
 *   npm run yolo -- --skip-arch-check # Skip remote architecture safety check
 *   npm run yolo -- --dry-run       # Show what would happen
 *   npm run yolo -- --help          # Show help
 */

import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawn } from 'child_process';
import { createConsola } from 'consola';

// Import shared utilities.
import {
  colors,
  log,
  formatBytes,
  setupConsolaLogging,
  banner,
  skull,
  run,
  checkRemoteReachable,
  getRemoteBootTime,
  waitForReboot,
  createCleanupManager,
  loadConfig,
} from '../pi-base/scripts/lib/index.mjs';

// ============================================================================
// Project Configuration
// ============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const YOCTO_DIR = dirname(__dirname);

// Project-specific settings.
const PROJECT_NAME = 'inky-soup';
const REMOTE_HOST = 'inky-soup.local';
const REMOTE_USER = 'inky';
const IMAGE_NAME = 'inky-soup-image';
const SERVER_NAME = 'inky-soup-server';
const REMOTE_TARGET = `${REMOTE_USER}@${REMOTE_HOST}`;
const REMOTE_BINARY_PATH = '/usr/bin/inky-soup-server';
const REMOTE_APP_DIR = '/usr/share/inky-soup';
const REMOTE_STATIC_DIR = `${REMOTE_APP_DIR}/static`;
const REMOTE_TEMPLATES_DIR = `${REMOTE_APP_DIR}/templates`;
const UPLOAD_SERVER_DIR = join(YOCTO_DIR, '..', 'upload-server');
const BUILD_DIR = join(YOCTO_DIR, 'build');
const WORK_DIR = join(BUILD_DIR, 'tmp', 'work');

// Machine definitions.
const MACHINES = {
  zero1: {
    id: 'zero1',
    name: 'Pi Zero W',
    machine: 'raspberrypi0-wifi',
    kasFile: 'kas-inky-soup-zero1.yml',
    imageDir: join(YOCTO_DIR, 'build/tmp/deploy/images/raspberrypi0-wifi'),
  },
  zero2: {
    id: 'zero2',
    name: 'Pi Zero 2 W',
    machine: 'raspberrypi0-2w',
    kasFile: 'kas-inky-soup-zero2.yml',
    imageDir: join(YOCTO_DIR, 'build/tmp/deploy/images/raspberrypi0-2w'),
  },
};
const CONFIG_FILE = join(YOCTO_DIR, '.flash-config.json');

// Mount point for inactive partition on remote.
const REMOTE_MOUNT = '/mnt/inactive';

// Set up consola with timestamps.
const consola = createConsola({
  reporters: [setupConsolaLogging()],
});

const info = (msg) => consola.info(msg);
const success = (msg) => consola.success(msg);
const warn = (msg) => consola.warn(msg);
const error = (msg) => consola.error(msg);

// Used for fast deploy stripping.
const DEFAULT_STRIP_TOOL = join(
  BUILD_DIR,
  'tmp',
  'sysroots-components',
  'x86_64',
  'binutils-cross-arm',
  'usr',
  'bin',
  'arm-poky-linux-gnueabi',
  'arm-poky-linux-gnueabi-strip',
);

// ============================================================================
// Machine Selection
// ============================================================================

/**
 * Get machine from config or args.
 */
function getMachine(args) {
  // Check for command-line override.
  if (args.includes('--zero1')) return MACHINES.zero1;
  if (args.includes('--zero2')) return MACHINES.zero2;

  // Check for saved preference.
  const config = loadConfig(CONFIG_FILE) || {};
  if (config.machine && MACHINES[config.machine]) {
    info(`Using saved machine: ${MACHINES[config.machine].name}`);
    return MACHINES[config.machine];
  }

  // Default to zero1 for yolo (no interactive prompt).
  warn('No machine configured. Use --zero1 or --zero2, or run "npm run flash" to set preference.');
  warn('Defaulting to Pi Zero W.');
  return MACHINES.zero1;
}

/**
 * Determine target class from remote model/arch.
 */
function classifyRemoteMachine(model, uname) {
  const modelLower = (model || '').toLowerCase();
  const unameLower = (uname || '').toLowerCase();

  if (modelLower.includes('zero 2')) return MACHINES.zero2;

  if (
    modelLower.includes('zero w') ||
    modelLower.includes('raspberry pi zero rev') ||
    modelLower === 'raspberry pi zero'
  ) {
    return MACHINES.zero1;
  }

  if (unameLower.startsWith('armv6')) return MACHINES.zero1;
  if (unameLower.startsWith('armv7') || unameLower.startsWith('aarch64')) return MACHINES.zero2;

  return null;
}

/**
 * Verify selected machine matches remote hardware architecture.
 */
function verifyRemoteArchitecture(machine, skipArchCheck = false) {
  const model = ssh(`if [ -r /proc/device-tree/model ]; then tr -d '\\0' < /proc/device-tree/model; fi`, { throwOnError: false }) || '';
  const uname = ssh('uname -m', { throwOnError: false }) || 'unknown';

  if (model) {
    info(`Remote model: ${model}`);
  }
  info(`Remote arch: ${uname}`);

  if (skipArchCheck) {
    warn('Skipping architecture check (--skip-arch-check)');
    return;
  }

  const detectedMachine = classifyRemoteMachine(model, uname);
  if (!detectedMachine) {
    throw new Error(
      `Could not classify remote hardware from model="${model || 'unknown'}", arch="${uname}". Refusing to deploy. Re-run with --skip-arch-check to override.`,
    );
  }

  if (detectedMachine.id !== machine.id) {
    throw new Error(
      `Architecture mismatch: selected ${machine.name} (${machine.machine}) but remote looks like ${detectedMachine.name} (${detectedMachine.machine}). Refusing to deploy.`,
    );
  }

  success(`Architecture check passed (${detectedMachine.name})`);
}

// ============================================================================
// Build Functions (Project-Specific)
// ============================================================================

/**
 * Clean the image sstate to force a rebuild.
 */
async function cleanImage(machine) {
  info(`Cleaning ${IMAGE_NAME} sstate to force rebuild...`);
  await run('kas', ['shell', machine.kasFile, '-c', `bitbake -c cleansstate ${IMAGE_NAME}`], { cwd: YOCTO_DIR });
  success('Clean complete!');
}

/**
 * Clean both server and image sstate for a full rebuild.
 */
async function cleanAll(machine) {
  info(`Cleaning ${SERVER_NAME} and ${IMAGE_NAME} sstate...`);
  await run('kas', ['shell', machine.kasFile, '-c', `bitbake -c cleansstate ${SERVER_NAME} ${IMAGE_NAME}`], { cwd: YOCTO_DIR });
  success('Clean complete!');
}

/**
 * Run the Yocto build.
 */
async function build(machine, forceClean = false, forceCleanAll = false) {
  banner(`Building ${IMAGE_NAME} for ${machine.name}...`, consola);

  if (forceCleanAll) {
    await cleanAll(machine);
  } else if (forceClean) {
    await cleanImage(machine);
  }

  await run('kas', ['build', machine.kasFile], { cwd: YOCTO_DIR });
  success('Build complete!');
}

async function cleanServer(machine) {
  info(`Cleaning ${SERVER_NAME} sstate...`);
  await run('kas', ['shell', machine.kasFile, '-c', `bitbake -c cleansstate ${SERVER_NAME}`], { cwd: YOCTO_DIR });
  success('Clean complete!');
}

async function buildServer(machine, forceClean = false) {
  banner(`Building ${SERVER_NAME} for ${machine.name}...`, consola);

  if (forceClean) {
    await cleanServer(machine);
  }

  // Build only what we need for fast deploy; avoids copying runtime images into /usr/share during do_install.
  await run('kas', ['shell', machine.kasFile, '-c', `bitbake -c compile ${SERVER_NAME}`], { cwd: YOCTO_DIR });
  success('Server build complete!');
}

/**
 * Find the rootfs tarball.
 */
function findRootfsTarball(machine) {
  if (!existsSync(machine.imageDir)) {
    return null;
  }

  const expectedName = `${IMAGE_NAME}-${machine.machine}.rootfs.tar.gz`;
  const tarballPath = join(machine.imageDir, expectedName);

  if (existsSync(tarballPath)) {
    const stat = statSync(tarballPath);
    return {
      name: expectedName,
      path: tarballPath,
      stat,
    };
  }

  // Fallback: find any tar.gz.
  const files = readdirSync(machine.imageDir)
    .filter(f => f.endsWith('.tar.gz') && f.includes('rootfs'))
    .map(f => ({
      name: f,
      path: join(machine.imageDir, f),
      stat: statSync(join(machine.imageDir, f)),
    }))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

  return files[0] || null;
}

function getStripTool() {
  if (existsSync(DEFAULT_STRIP_TOOL)) {
    return DEFAULT_STRIP_TOOL;
  }
  return 'strip';
}

function findServerWorkDir(machine) {
  const candidates = [];
  if (machine.id === 'zero1') {
    candidates.push('arm1176jzfshf-vfp-poky-linux-gnueabi');
  } else if (machine.id === 'zero2') {
    candidates.push('cortexa7t2hf-neon-vfpv4-poky-linux-gnueabi');
  }

  for (const candidate of candidates) {
    const recipeDir = join(WORK_DIR, candidate, SERVER_NAME, 'git');
    if (existsSync(recipeDir)) {
      return recipeDir;
    }
  }

  // Fallback: scan the work dir for any matching recipe output.
  if (existsSync(WORK_DIR)) {
    for (const entry of readdirSync(WORK_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const recipeDir = join(WORK_DIR, entry.name, SERVER_NAME, 'git');
      if (existsSync(recipeDir)) {
        return recipeDir;
      }
    }
  }

  return null;
}

function findBuiltServerBinary(machine) {
  const recipeDir = findServerWorkDir(machine);
  if (!recipeDir) {
    return null;
  }

  // Prefer cargo build output (do_compile) to avoid relying on do_install.
  const cargoOutDir = join(recipeDir, `${SERVER_NAME}-git`);
  if (existsSync(cargoOutDir)) {
    for (const entry of readdirSync(cargoOutDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(cargoOutDir, entry.name, 'release', 'upload-server');
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  // Fallback: use the installed path from do_install (already stripped), if available.
  const installed = join(recipeDir, 'image', 'usr', 'bin', 'inky-soup-server');
  if (existsSync(installed)) {
    return installed;
  }

  return null;
}

async function createStrippedBinary(inputBinaryPath) {
  const workDir = mkdtempSync(join(tmpdir(), 'inky-soup-fast-'));
  const outputBinaryPath = join(workDir, 'inky-soup-server');

  copyFileSync(inputBinaryPath, outputBinaryPath);

  const stripTool = getStripTool();
  await run(stripTool, ['--strip-unneeded', outputBinaryPath], { cwd: YOCTO_DIR });

  return {
    path: outputBinaryPath,
    cleanup: () => rmSync(workDir, { recursive: true, force: true }),
  };
}

async function scpToRemote(localPath, remotePath, dryRun = false) {
  if (dryRun) {
    info(`Would scp ${localPath} -> ${REMOTE_TARGET}:${remotePath}`);
    return;
  }
  await run('scp', ['-o', 'ConnectTimeout=30', localPath, `${REMOTE_TARGET}:${remotePath}`], { cwd: YOCTO_DIR });
}

function streamLocalTar(baseDir, relPaths, remoteDir, dryRun = false) {
  return new Promise((resolve, reject) => {
    const safePaths = relPaths.filter(p => existsSync(join(baseDir, p)));

    if (safePaths.length === 0) {
      warn('No local paths found to deploy (skipping static/templates sync).');
      resolve();
      return;
    }

    if (dryRun) {
      info(`Would stream ${safePaths.join(', ')} -> ${REMOTE_TARGET}:${remoteDir}`);
      resolve();
      return;
    }

    const sshProcess = spawn('ssh', [
      '-o', 'ConnectTimeout=30',
      REMOTE_TARGET,
      `sudo tar -xzf - -C ${remoteDir}`,
    ], {
      stdio: ['pipe', 'inherit', 'inherit'],
    });

    const tarProcess = spawn('tar', ['-C', baseDir, '-czf', '-', ...safePaths], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });

    tarProcess.stdout.pipe(sshProcess.stdin);

    sshProcess.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`tar extract failed with code ${code}`));
      }
    });

    sshProcess.on('error', reject);
    tarProcess.on('error', reject);
  });
}

async function fastDeploy(machine, skipBuild, forceClean, dryRun) {
  banner('Fast deploy (app-only, no reboot)...', consola);

  if (!skipBuild && !dryRun) {
    await buildServer(machine, forceClean);
  }

  const builtBinary = findBuiltServerBinary(machine);
  if (!builtBinary) {
    error('No Yocto-built server binary found for fast deploy.');
    error('Run a build first, e.g.:');
    error(`  cd yocto && npm run build -- --${machine.id}`);
    error('Or run fast deploy without --skip-build.');
    process.exit(1);
  }

  if (dryRun) {
    log('');
    banner('Dry run - would perform these steps:', consola);
    info(`1. Copy server binary to ${REMOTE_BINARY_PATH}`);
    info(`2. Sync templates/static to ${REMOTE_APP_DIR} (excluding static/images)`);
    info('3. Restart inky-soup-server.service');
    log('');
    success('Dry run complete!');
    return;
  }

  let staged = null;
  try {
    // Strip to keep transfer small (cargo output contains debug info).
    staged = await createStrippedBinary(builtBinary);
    const remoteTmpBinary = '/tmp/inky-soup-server.fast';

    const relPaths = [
      'Rocket.toml',
      'templates',
      'static/js',
      'static/chota.min.css',
      'static/favicon.ico',
    ];

    info('Stopping service...');
    ssh('sudo systemctl stop inky-soup-server.service', { throwOnError: false });

    banner('Deploying server binary...', consola);
    await scpToRemote(staged.path, remoteTmpBinary, dryRun);
    ssh(`sudo mv ${remoteTmpBinary} ${REMOTE_BINARY_PATH}`);
    ssh(`sudo chown root:root ${REMOTE_BINARY_PATH}`, { throwOnError: false });
    ssh(`sudo chmod 0755 ${REMOTE_BINARY_PATH}`);

    banner('Syncing UI assets...', consola);
    ssh(`sudo mkdir -p ${REMOTE_STATIC_DIR} ${REMOTE_TEMPLATES_DIR}`);
    await streamLocalTar(UPLOAD_SERVER_DIR, relPaths, REMOTE_APP_DIR, dryRun);
    ssh(`sudo chown -R root:root ${REMOTE_STATIC_DIR} ${REMOTE_TEMPLATES_DIR} ${REMOTE_APP_DIR}/Rocket.toml`, { throwOnError: false });
    ssh(`sudo chmod -R a+rX ${REMOTE_STATIC_DIR} ${REMOTE_TEMPLATES_DIR}`, { throwOnError: false });
    ssh(`sudo chmod 0644 ${REMOTE_APP_DIR}/Rocket.toml`, { throwOnError: false });

    info('Restarting service...');
    ssh('sudo systemctl restart inky-soup-server.service');

    const status = ssh('systemctl is-active inky-soup-server.service', { throwOnError: false }) || 'unknown';
    if (status.trim() === 'active') {
      success('Fast deploy complete! Service is active.');
    } else {
      warn(`Service status: ${status}`);
      ssh('systemctl status --no-pager --lines=20 inky-soup-server.service', { throwOnError: false });
    }
  } finally {
    if (staged) {
      staged.cleanup();
    }
  }
}

// ============================================================================
// Remote Commands
// ============================================================================

/**
 * Run a command on the remote Pi via SSH.
 */
function ssh(cmd, options = {}) {
  const sshCmd = `ssh -o ConnectTimeout=10 ${REMOTE_TARGET} "${cmd}"`;
  try {
    return execSync(sshCmd, { encoding: 'utf8', ...options }).trim();
  } catch (err) {
    if (options.throwOnError !== false) {
      throw err;
    }
    return null;
  }
}

/**
 * Get the inactive partition device from ab-boot-manager.
 */
function getInactiveDevice() {
  return ssh('ab-boot-manager inactive-device');
}

/**
 * Get the inactive slot name (a or b).
 */
function getInactiveSlot() {
  return ssh('ab-boot-manager inactive');
}

/**
 * Get boot partition device (typically p1).
 *
 * Prefer locating the partition by label ("boot") since /proc/cmdline root=
 * may be PARTUUID-based depending on the image.
 */
function getBootDevice() {
  const fromLabelBlkid = ssh('blkid -L boot 2>/dev/null', { throwOnError: false });
  if (fromLabelBlkid) {
    return fromLabelBlkid.trim();
  }

  const fromLabelLsblk = ssh(
    "lsblk -pnro NAME,LABEL 2>/dev/null | awk '$2==\"boot\" {print $1; exit}'",
    { throwOnError: false },
  );
  if (fromLabelLsblk) {
    return fromLabelLsblk.trim();
  }

  // Fallback: infer from root=/dev/... in /proc/cmdline (common for our Yocto images).
  const root = ssh("cat /proc/cmdline | sed -n 's/.*\\<root=\\([^ ]*\\).*/\\1/p'", { throwOnError: false });
  if (!root || !root.startsWith('/dev/')) {
    return null;
  }

  return root.replace(/\d+$/, '1');
}

/**
 * Ensure /boot/cmdline.txt is accessible for slot switching.
 *
 * Returns true if this function mounted /boot and caller should unmount later.
 */
function prepareBootForSlotSwitch() {
  const hasCmdline = ssh('[ -f /boot/cmdline.txt ] && echo yes || echo no', { throwOnError: false }) === 'yes';
  if (hasCmdline) {
    return false;
  }

  const bootAlreadyMounted = ssh('mountpoint -q /boot && echo yes || echo no', { throwOnError: false }) === 'yes';
  if (bootAlreadyMounted) {
    throw new Error('/boot is mounted but /boot/cmdline.txt is missing. Refusing to switch slot.');
  }

  const bootDevice = getBootDevice();
  if (!bootDevice) {
    throw new Error('Could not determine boot partition device for slot switch.');
  }

  info(`Mounting boot partition ${bootDevice} at /boot...`);
  ssh(`sudo mount ${bootDevice} /boot`);

  const hasCmdlineAfterMount = ssh('[ -f /boot/cmdline.txt ] && echo yes || echo no', { throwOnError: false }) === 'yes';
  if (!hasCmdlineAfterMount) {
    ssh('sudo umount /boot', { throwOnError: false });
    throw new Error('Mounted /boot, but /boot/cmdline.txt is still missing.');
  }

  return true;
}

/**
 * Unmount /boot after temporary mount for slot switching.
 */
function unmountBootAfterSlotSwitch() {
  ssh('sudo umount /boot', { throwOnError: false });
}

/**
 * Mount the inactive partition.
 */
function mountInactive(device) {
  ssh(`sudo mkdir -p ${REMOTE_MOUNT}`);
  ssh(`sudo mount ${device} ${REMOTE_MOUNT}`);
}

/**
 * Unmount the inactive partition.
 */
function unmountInactive() {
  ssh(`sudo umount ${REMOTE_MOUNT}`, { throwOnError: false });
}

/**
 * Clear the inactive partition content.
 */
function clearInactive() {
  // Use find + xargs for efficiency, skip lost+found.
  ssh(`sudo find ${REMOTE_MOUNT} -mindepth 1 -maxdepth 1 ! -name 'lost+found' -exec rm -rf {} +`);
}

/**
 * Stream tarball to remote and extract.
 */
function streamTarball(tarballPath, dryRun = false) {
  return new Promise((resolve, reject) => {
    if (dryRun) {
      info(`Would stream ${tarballPath} to ${REMOTE_TARGET}:${REMOTE_MOUNT}`);
      resolve();
      return;
    }

    const sshProcess = spawn('ssh', [
      '-o', 'ConnectTimeout=30',
      REMOTE_TARGET,
      `sudo tar -xzf - -C ${REMOTE_MOUNT}`,
    ], {
      stdio: ['pipe', 'inherit', 'inherit'],
    });

    const catProcess = spawn('cat', [tarballPath], {
      stdio: ['inherit', 'pipe', 'inherit'],
    });

    catProcess.stdout.pipe(sshProcess.stdin);

    sshProcess.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`tar extract failed with code ${code}`));
      }
    });

    sshProcess.on('error', reject);
    catProcess.on('error', reject);
  });
}

/**
 * Inject SSH key into the inactive rootfs.
 */
function injectSSHKey(config) {
  if (!config || !config.ssh_key_path) {
    warn('No SSH key configured, skipping injection');
    return;
  }

  const keyContent = readFileSync(config.ssh_key_path, 'utf8').trim();
  const sshDir = `${REMOTE_MOUNT}/home/${REMOTE_USER}/.ssh`;

  // Create .ssh directory with correct permissions.
  ssh(`sudo mkdir -p ${sshDir}`);
  ssh(`sudo chmod 700 ${sshDir}`);

  // Write authorized_keys.
  ssh(`echo '${keyContent}' | sudo tee ${sshDir}/authorized_keys > /dev/null`);
  ssh(`sudo chmod 600 ${sshDir}/authorized_keys`);

  // Set ownership (UID 1000 is typically the first user).
  ssh(`sudo chown -R 1000:1000 ${sshDir}`);

  success('SSH key injected!');
}

/**
 * Switch boot to the inactive slot.
 */
function switchBootSlot(slot) {
  ssh(`sudo ab-boot-manager switch ${slot}`);
}

/**
 * Reboot the Pi.
 */
function rebootPi() {
  ssh('sudo reboot', { throwOnError: false });
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main() {
  const args = process.argv.slice(2);

  const skipBuild = args.includes('--skip-build');
  const fast = args.includes('--fast');
  const skipArchCheck = args.includes('--skip-arch-check');
  const forceClean = args.includes('--clean');
  const forceCleanAll = args.includes('--clean-all');
  const dryRun = args.includes('--dry-run');

  if (args.includes('-h') || args.includes('--help')) {
    log(`Usage: npm run yolo [options]`);
    log('');
    log('Content-based A/B update: streams rootfs to inactive partition.');
    log('');
    log('Options:');
    log('  --zero1          Target Pi Zero W (ARMv6)');
    log('  --zero2          Target Pi Zero 2 W (ARMv7)');
    log('  --fast           Fast deploy (app-only, no reboot)');
    log('  --skip-build     Skip local build, use existing artifacts');
    log('  --skip-arch-check Skip remote architecture safety check');
    log('  --clean          Force rebuild (image; in --fast mode: server)');
    log('  --clean-all      Force full rebuild (server+image; in --fast mode: server)');
    log('  --dry-run        Show what would happen without doing it');
    log('  -h, --help       Show this help');
    log('');
    log('This is the YOLO approach - if it fails, pull the disk and reflash.');
    process.exit(0);
  }

  // Get target machine.
  const machine = getMachine(args);

  // Set up cleanup manager for Ctrl+C handling.
  const cleanupManager = createCleanupManager();
  cleanupManager.installSignalHandlers();

  log('');
  log(`${colors.bold}${colors.cyan}${PROJECT_NAME} YOLO Update${colors.reset}`);
  info(`Target: ${machine.name}`);
  if (dryRun) {
    log(`${colors.yellow}(dry-run mode - no changes will be made)${colors.reset}`);
  }
  skull();

  // Pre-flight checks.
  info(`Checking if ${REMOTE_HOST} is reachable...`);
  if (!checkRemoteReachable(REMOTE_HOST, REMOTE_TARGET)) {
    error(`Cannot reach ${REMOTE_HOST}`);
    error('Make sure the Pi is running and accessible via SSH.');
    process.exit(1);
  }
  success(`${REMOTE_HOST} is reachable`);

  info('Checking remote architecture...');
  verifyRemoteArchitecture(machine, skipArchCheck);

  if (fast) {
    await fastDeploy(machine, skipBuild, forceClean || forceCleanAll, dryRun);
    cleanupManager.uninstallSignalHandlers();
    return;
  }

  // Get A/B partition info.
  const inactiveSlot = getInactiveSlot();
  const inactiveDevice = getInactiveDevice();
  info(`Current slot: ${inactiveSlot === 'b' ? 'a' : 'b'}`);
  info(`Inactive slot: ${inactiveSlot} (${inactiveDevice})`);

  const originalBootTime = getRemoteBootTime(REMOTE_TARGET);

  // Build phase.
  if (!skipBuild) {
    await build(machine, forceClean, forceCleanAll);
  }

  // Find tarball.
  const tarball = findRootfsTarball(machine);
  if (!tarball) {
    error('No rootfs tarball found. Make sure IMAGE_FSTYPES includes "tar.gz".');
    error('Run: npm run clean:image && npm run build');
    process.exit(1);
  }

  log('');
  info(`Tarball: ${tarball.name}`);
  info(`Size: ${formatBytes(tarball.stat.size)}`);
  info(`Built: ${tarball.stat.mtime.toLocaleString()}`);

  // Load SSH key config.
  const config = loadConfig(CONFIG_FILE);
  if (config) {
    info(`SSH key: ${basename(config.ssh_key_path)}`);
  } else {
    warn('No SSH key configured. Run "npm run flash -- --reconfigure" first.');
  }

  if (dryRun) {
    log('');
    banner('Dry run - would perform these steps:', consola);
    info(`1. Mount ${inactiveDevice} to ${REMOTE_MOUNT}`);
    info(`2. Clear ${REMOTE_MOUNT}/*`);
    info(`3. Stream ${tarball.name} to ${REMOTE_MOUNT}`);
    info(`4. Inject SSH key`);
    info(`5. Switch boot to slot ${inactiveSlot}`);
    info(`6. Reboot`);
    log('');
    success('Dry run complete!');
    process.exit(0);
  }

  let bootMountedForSwitch = false;

  try {

    // Mount inactive partition.
    banner('Preparing inactive partition...', consola);
    unmountInactive(); // Ensure clean state.
    mountInactive(inactiveDevice);
    success(`Mounted ${inactiveDevice} to ${REMOTE_MOUNT}`);

    // Clear old content.
    info('Clearing old content...');
    clearInactive();
    success('Partition cleared');

    // Stream tarball.
    banner('Streaming rootfs to Pi...', consola);
    info(`Streaming ${formatBytes(tarball.stat.size)}...`);
    await streamTarball(tarball.path, dryRun);
    success('Rootfs extracted!');

    // Inject SSH key.
    if (config) {
      info('Injecting SSH key...');
      injectSSHKey(config);
    }

    // Unmount.
    info('Syncing and unmounting...');
    ssh('sync');
    unmountInactive();
    success('Partition ready');

    // Switch boot slot.
    banner('Switching boot slot...', consola);
    cleanupManager.enterCriticalSection();
    bootMountedForSwitch = prepareBootForSlotSwitch();
    switchBootSlot(inactiveSlot);
    if (bootMountedForSwitch) {
      ssh('sync');
      unmountBootAfterSlotSwitch();
      bootMountedForSwitch = false;
    }
    success(`Boot switched to slot ${inactiveSlot}`);

    // Reboot.
    banner('Rebooting Pi...', consola);
    rebootPi();

    // Wait for reboot.
    info('Waiting for Pi to come back online...');
    const online = await waitForReboot(REMOTE_TARGET, REMOTE_HOST, originalBootTime, 120);

    cleanupManager.exitCriticalSection();

    log('');
    if (online) {
      log(`${colors.bold}${colors.green}════════════════════════════════════════════════════════════════${colors.reset}`);
      success('YOLO update complete!');
      info(`Connect with: ssh ${REMOTE_TARGET}`);

      // Show which slot we're now on.
      try {
        const newSlot = ssh('ab-boot-manager current');
        info(`Now running on slot: ${newSlot}`);
      } catch {
        // Ignore if we can't get the slot.
      }

      log(`${colors.bold}${colors.green}════════════════════════════════════════════════════════════════${colors.reset}`);
    } else {
      log(`${colors.bold}${colors.yellow}════════════════════════════════════════════════════════════════${colors.reset}`);
      warn('Pi did not come back online within timeout.');
      warn('It may still be booting, or you may need to reflash.');
      log(`${colors.bold}${colors.yellow}════════════════════════════════════════════════════════════════${colors.reset}`);
    }

    log('');

  } catch (err) {
    // Try to clean up on error.
    if (bootMountedForSwitch) {
      unmountBootAfterSlotSwitch();
    }
    unmountInactive();
    throw err;
  } finally {
    cleanupManager.uninstallSignalHandlers();
  }
}

main().catch(err => {
  error(err.message);
  process.exit(1);
});
