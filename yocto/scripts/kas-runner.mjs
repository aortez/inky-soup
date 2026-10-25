/** Run Yocto in the supported container while preserving checkout and cache paths. */

import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { run } from '../pi-base/scripts/lib/index.mjs';

const DEFAULT_IMAGE = 'ghcr.io/siemens/kas/kas:5.4-debian-bookworm';

export async function runKas(args, yoctoDir, { host = false } = {}) {
  if (host) {
    await run('kas', args, { cwd: yoctoDir });
    return;
  }

  const root = dirname(yoctoDir);
  const dockerArgs = [
    'run', '--rm', '--init', '--user', 'root',
    '-e', `USER_ID=${process.getuid()}`,
    '-e', `GROUP_ID=${process.getgid()}`,
    '-e', `KAS_WORK_DIR=${yoctoDir}`,
    '-e', `KAS_BUILD_DIR=${join(yoctoDir, 'build')}`,
    '-v', `${root}:${root}:rw`,
    '-w', yoctoDir,
  ];

  // Cache directories are often symlinks outside the checkout. Keep their real
  // paths visible so externalsrc and the SD-card helpers also use normal paths.
  for (const [variable, name] of [['DL_DIR', 'downloads'], ['SSTATE_DIR', 'sstate-cache']]) {
    const path = join(yoctoDir, name);
    mkdirSync(path, { recursive: true });
    const realPath = realpathSync(path);
    dockerArgs.push('-v', `${realPath}:${realPath}:rw`, '-e', `${variable}=${realPath}`);
  }

  // Match kas-container's Ubuntu user-namespace handling for BitBake workers.
  if (existsSync('/etc/apparmor.d/rootlesskit')) {
    dockerArgs.push('--security-opt', 'apparmor=rootlesskit');
  }
  for (const variable of ['http_proxy', 'https_proxy', 'no_proxy', 'NO_PROXY']) {
    if (process.env[variable]) dockerArgs.push('-e', variable);
  }
  if (process.stdin.isTTY && process.stdout.isTTY) dockerArgs.push('-it');
  dockerArgs.push(process.env.KAS_CONTAINER_IMAGE || DEFAULT_IMAGE, ...args);
  await run('docker', dockerArgs, { cwd: yoctoDir });
}
