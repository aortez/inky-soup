#!/usr/bin/env node
/**
 * Build script for Inky Soup Yocto images.
 *
 * Supports multiple target machines with persistent preference storage.
 *
 * Usage:
 *   npm run build                  # Use saved preference or prompt
 *   npm run build -- --zero1       # Build for Pi Zero W
 *   npm run build -- --zero2       # Build for Pi Zero 2 W
 *   npm run build -- --clean       # Clean image sstate before build
 *   npm run build -- --clean-all   # Clean server + image sstate
 */

import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import {
  colors,
  log,
  info,
  success,
  warn,
  error,
  prompt,
  loadConfig,
  saveConfig,
  run,
} from '../pi-base/scripts/lib/index.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const YOCTO_DIR = dirname(__dirname);
const CONFIG_FILE = join(YOCTO_DIR, '.flash-config.json');

// Machine definitions.
const MACHINES = {
  zero1: {
    id: 'zero1',
    name: 'Pi Zero W',
    machine: 'raspberrypi0-wifi',
    kasFile: 'kas-inky-soup-zero1.yml',
    description: 'ARMv6, single-core (original Zero W)',
  },
  zero2: {
    id: 'zero2',
    name: 'Pi Zero 2 W',
    machine: 'raspberrypi0-2w',
    kasFile: 'kas-inky-soup-zero2.yml',
    description: 'ARMv7, quad-core',
  },
};

/**
 * Prompt user to select a machine.
 */
async function selectMachine() {
  log('');
  log(`${colors.bold}Select target machine:${colors.reset}`);
  log('');
  log(`  ${colors.cyan}1)${colors.reset} ${MACHINES.zero1.name} - ${MACHINES.zero1.description}`);
  log(`  ${colors.cyan}2)${colors.reset} ${MACHINES.zero2.name} - ${MACHINES.zero2.description}`);
  log('');

  const choice = await prompt('Choice (1-2): ');

  if (choice === '1') return 'zero1';
  if (choice === '2') return 'zero2';

  error('Invalid selection.');
  process.exit(1);
}

/**
 * Get machine from config, args, or prompt.
 */
async function getMachine(args) {
  // Check for command-line override.
  if (args.includes('--zero1')) return { machine: MACHINES.zero1, save: false };
  if (args.includes('--zero2')) return { machine: MACHINES.zero2, save: false };

  // Check for saved preference.
  const config = loadConfig(CONFIG_FILE) || {};
  if (config.machine && MACHINES[config.machine]) {
    info(`Using saved machine: ${MACHINES[config.machine].name}`);
    return { machine: MACHINES[config.machine], save: false };
  }

  // Prompt user.
  const selected = await selectMachine();

  // Ask to save preference.
  const saveChoice = await prompt('Save as default? (Y/n): ');
  const shouldSave = saveChoice.toLowerCase() !== 'n';

  if (shouldSave) {
    config.machine = selected;
    saveConfig(CONFIG_FILE, config);
    success(`Saved ${MACHINES[selected].name} as default.`);
  }

  return { machine: MACHINES[selected], save: false };
}

/**
 * Run clean command.
 */
async function clean(kasFile, cleanAll = false) {
  const target = cleanAll ? 'inky-soup-server inky-soup-image' : 'inky-soup-image';
  info(`Cleaning ${target} sstate...`);
  await run('kas', ['shell', kasFile, '-c', `bitbake -c cleansstate ${target}`], { cwd: YOCTO_DIR });
  success('Clean complete!');
}

function showHelp() {
  log(`
Inky Soup Yocto Build Tool

Build Yocto images for Raspberry Pi Zero W or Zero 2 W.

Usage:
  npm run build [options]

Options:
  --zero1        Build for Pi Zero W (ARMv6)
  --zero2        Build for Pi Zero 2 W (ARMv7)
  --clean        Clean image sstate before build
  --clean-all    Clean server + image sstate before build
  -h, --help     Show this help

Your machine preference is saved in .flash-config.json.
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('-h') || args.includes('--help')) {
    showHelp();
    process.exit(0);
  }

  log('');
  log(`${colors.bold}${colors.cyan}Inky Soup Yocto Build${colors.reset}`);
  log('');

  const { machine } = await getMachine(args);

  info(`Target: ${machine.name} (${machine.machine})`);
  info(`KAS config: ${machine.kasFile}`);
  log('');

  // Handle clean flags.
  if (args.includes('--clean-all')) {
    await clean(machine.kasFile, true);
  } else if (args.includes('--clean')) {
    await clean(machine.kasFile, false);
  }

  // Run build.
  info('Starting build...');
  await run('kas', ['build', machine.kasFile], { cwd: YOCTO_DIR });

  log('');
  success('Build complete!');
  info(`Image: build/tmp/deploy/images/${machine.machine}/`);
}

main().catch(err => {
  error(err.message);
  process.exit(1);
});
