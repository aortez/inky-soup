#!/usr/bin/env node
/**
 * Quick deploy script for Inky Soup application files.
 *
 * Builds the Rust server using cross and SCPs it to the Pi.
 * Much faster than a full YOLO update for app-only changes.
 *
 * Usage:
 *   npm run deploy                              # Deploy to inky-soup.local
 *   npm run deploy -- --host my-pi.local        # Deploy to specific host
 */

import { execSync, spawn } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const consola = require('consola');

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');
const UPLOAD_SERVER_DIR = join(PROJECT_ROOT, 'upload-server');

const DEFAULT_HOST = 'inky-soup.local';
const DEFAULT_USER = 'inky';
const TARGET = 'arm-unknown-linux-gnueabihf';

let piHost = DEFAULT_HOST;
let piUser = DEFAULT_USER;

function run(cmd, options = {}) {
  consola.info(`Running: ${cmd}`);
  return execSync(cmd, { stdio: 'inherit', ...options });
}

function showHelp() {
  console.log(`
Quick Deploy - Deploy Inky Soup app to a Raspberry Pi

Usage:
  npm run deploy [options]

Options:
  --host <host>  Target hostname (default: ${DEFAULT_HOST})
  --user <user>  SSH user (default: ${DEFAULT_USER})
  -h, --help     Show this help

Examples:
  npm run deploy                                # Deploy to inky-soup.local
  npm run deploy -- --host my-pi.local          # Deploy to different host
`);
}

async function checkPiReachable() {
  try {
    execSync(`ping -c 1 -W 2 ${piHost}`, { stdio: 'pipe' });
    consola.success(`${piHost} is reachable`);
    return true;
  } catch {
    consola.error(`Cannot reach ${piHost}`);
    return false;
  }
}

async function buildServer() {
  consola.start('Building Rust server with cross...');

  // Find cross command.
  let crossCmd = 'cross';
  if (!existsSync('/usr/bin/cross')) {
    const homeCross = join(process.env.HOME, '.cargo/bin/cross');
    if (existsSync(homeCross)) {
      crossCmd = homeCross;
    }
  }

  try {
    run(`${crossCmd} build --release --target=${TARGET}`, { cwd: UPLOAD_SERVER_DIR });
    consola.success('Build complete!');
    return true;
  } catch (error) {
    consola.error('Build failed!');
    return false;
  }
}

async function deployFiles() {
  consola.start('Deploying files to Pi...');

  const binaryPath = join(UPLOAD_SERVER_DIR, 'target', TARGET, 'release', 'upload-server');
  if (!existsSync(binaryPath)) {
    consola.error('Binary not found. Build may have failed.');
    return false;
  }

  try {
    // Stop service.
    consola.info('Stopping service...');
    run(`ssh ${piUser}@${piHost} "sudo systemctl stop inky-soup-server.service 2>/dev/null || true"`);

    // Copy binary.
    consola.info('Copying binary...');
    run(`scp ${binaryPath} ${piUser}@${piHost}:/tmp/upload-server`);
    run(`ssh ${piUser}@${piHost} "sudo cp /tmp/upload-server /usr/bin/inky-soup-server && sudo chmod +x /usr/bin/inky-soup-server"`);

    // Copy static files and templates.
    consola.info('Copying static files...');
    run(`scp -r ${UPLOAD_SERVER_DIR}/static ${piUser}@${piHost}:~/inky-soup/`);
    run(`scp -r ${UPLOAD_SERVER_DIR}/templates ${piUser}@${piHost}:~/inky-soup/`);
    run(`scp ${UPLOAD_SERVER_DIR}/Rocket.toml ${piUser}@${piHost}:~/inky-soup/`);

    // Copy Python display script to system location.
    consola.info('Copying display script...');
    run(`scp ${PROJECT_ROOT}/update-image.py ${piUser}@${piHost}:/tmp/update-image.py`);
    run(`ssh ${piUser}@${piHost} "sudo cp /tmp/update-image.py /usr/bin/inky-soup-update-display && sudo chmod +x /usr/bin/inky-soup-update-display"`);

    // Start service.
    consola.info('Starting service...');
    run(`ssh ${piUser}@${piHost} "sudo systemctl start inky-soup-server.service"`);

    consola.success('Deploy complete!');
    return true;
  } catch (error) {
    consola.error(`Deploy failed: ${error.message}`);
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('-h') || args.includes('--help')) {
    showHelp();
    process.exit(0);
  }

  // Parse --host option.
  const hostIndex = args.indexOf('--host');
  if (hostIndex !== -1 && hostIndex + 1 < args.length) {
    piHost = args[hostIndex + 1];
  }

  // Parse --user option.
  const userIndex = args.indexOf('--user');
  if (userIndex !== -1 && userIndex + 1 < args.length) {
    piUser = args[userIndex + 1];
  }

  consola.box(`Quick Deploy → ${piUser}@${piHost}`);

  if (!await checkPiReachable()) {
    process.exit(1);
  }

  const startTime = Date.now();

  if (!await buildServer()) {
    process.exit(1);
  }

  if (!await deployFiles()) {
    process.exit(1);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  consola.success(`Done in ${elapsed}s!`);
  consola.info(`Server running at http://${piHost}:8000/`);
}

main().catch((err) => {
  consola.error(err);
  process.exit(1);
});
