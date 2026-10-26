import {releaseManifestUrl, validateInstalled, validateRelease, resolveUpdate} from '../core/app-update.js';

// The bridge is injected so release discovery and installation can be exercised without a phone.
export async function installedApp(bridge) {
  return validateInstalled(await bridge.installed());
}

export async function checkForUpdate(bridge, manifestUrl = releaseManifestUrl) {
  const installed = validateInstalled(await bridge.installed());
  const release = validateRelease(await bridge.check({url: manifestUrl}));
  return resolveUpdate(installed, release);
}

export async function downloadUpdate(bridge, release, onProgress = () => {}) {
  const listener = await bridge.addListener('updateProgress', event => {
    onProgress(Number(event?.received) || 0, Number(event?.total) || release.apk_size);
  });
  try {
    await bridge.download({url: release.apk_url, size: release.apk_size, sha256: release.apk_sha256});
  } finally {
    try {await listener?.remove?.();} catch { /* The native listener dies with its plugin instance. */ }
  }
}

// Android's installer finishes the update; the app only hands it a verified file.
export async function installUpdate(bridge, release) {
  const result = await bridge.install({sha256: release.apk_sha256});
  if (!['launched', 'permission'].includes(result?.status)) throw new Error('The Android installer could not be opened.');
  return result.status;
}

export const cancelDownload = bridge => bridge.cancel().catch(() => {});
