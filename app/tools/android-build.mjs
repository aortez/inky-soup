import {spawnSync} from 'node:child_process';

// Use the caller's Java/Android SDK configuration, including Android Studio's local.properties.
const result = spawnSync(process.platform === 'win32' ? 'gradlew.bat' : './gradlew',
  ['--no-daemon', 'assembleDebug'], {cwd: 'android', stdio: 'inherit', shell: process.platform === 'win32'});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
