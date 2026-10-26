// Signed Android releases are published by the frame-release workflow; see docs/android-release.md.
export const releaseManifestUrl = 'https://github.com/aortez/inky-soup/releases/download/frame-app/frame-release.json';
// Automatic checks are rare so launches never wait on GitHub; Settings can always check now.
export const updateCheckInterval = 6 * 60 * 60 * 1000;
export const updateCheckKey = 'sparkle-update-check';
const manifestHost = new URL(releaseManifestUrl).host;
const maximumApk = 64 * 1024 * 1024;

export function updateBlockReason(state, action = 'Reload', doing = 'reloading') {
  if (state.job) return `${action} will be available when your frame finishes refreshing.`;
  if (state.busy || state.importing || state.connecting) return `Finish the current task before ${doing}.`;
  if (state.processing) return `Your photo preview is finishing. ${action} will be available shortly.`;
  if (state.imports.some(item => !item.regenerate && item.status !== 'Saved')) {
    return `Finish adding your photos before ${doing}.`;
  }
  return '';
}

const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const integer = (value, maximum) => Number.isSafeInteger(value) && value >= 1 && value <= maximum;
const applicationId = value => typeof value === 'string' && /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/i.test(value);
function httpsUrl(value, host = '') {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && (!host || url.host.toLowerCase() === host.toLowerCase());
  } catch {return false;}
}

// The installed description comes from the native plugin; a malformed bridge must not look like an update.
export function validateInstalled(value) {
  const valid = value && typeof value === 'object' && applicationId(value.applicationId)
    && typeof value.versionName === 'string' && value.versionName.length > 0 && value.versionName.length <= 64
    && integer(value.versionCode, 2100000000) && integer(value.sdk, 1000) && digest(value.signingSha256)
    && typeof value.canInstall === 'boolean' && (value.downloadedSha256 === null || digest(value.downloadedSha256));
  if (!valid) throw new Error('The installed app version could not be read.');
  return {
    applicationId: value.applicationId, versionName: value.versionName, versionCode: value.versionCode, sdk: value.sdk,
    signingSha256: value.signingSha256, canInstall: value.canInstall, downloadedSha256: value.downloadedSha256,
  };
}

// Packages must come from the manifest's own host, so a manipulated manifest cannot name another server.
export function validateRelease(value, host = manifestHost) {
  const valid = value && typeof value === 'object' && applicationId(value.application_id)
    && typeof value.version_name === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value.version_name)
    && integer(value.version_code, 2100000000) && integer(value.min_sdk, 1000) && httpsUrl(value.apk_url, host)
    && digest(value.apk_sha256) && integer(value.apk_size, maximumApk) && digest(value.signing_sha256)
    && (value.notes === undefined || value.notes === null || typeof value.notes === 'string')
    && (value.release_url === undefined || value.release_url === null || value.release_url === '' || httpsUrl(value.release_url));
  if (!valid) throw new Error('The update information could not be read. Try again later.');
  return {
    application_id: value.application_id, version_name: value.version_name, version_code: value.version_code,
    min_sdk: value.min_sdk, apk_url: value.apk_url, apk_sha256: value.apk_sha256, apk_size: value.apk_size,
    signing_sha256: value.signing_sha256, notes: (value.notes || '').trim().slice(0, 1000), release_url: value.release_url || '',
  };
}

// Android refuses an update signed by another key, so such a release is reported rather than downloaded.
export function updateDecision(installed, release) {
  if (release.application_id !== installed.applicationId) return {status: 'incompatible', reason: 'This release is for a different app.'};
  if (release.signing_sha256 !== installed.signingSha256) {
    return {status: 'incompatible', reason: `Version ${release.version_name} uses a different signing key, so Android cannot install it over this build. Keep using this version or install the release separately.`};
  }
  if (release.min_sdk > installed.sdk) return {status: 'incompatible', reason: `Version ${release.version_name} needs a newer Android version than this phone has.`};
  if (release.version_code > installed.versionCode) return {status: 'available', reason: ''};
  return {status: 'current', reason: ''};
}

export const formatSize = bytes => `${(bytes / 1e6).toFixed(1)} MB`;

export function describeUpdate(update, blocked = '') {
  if (!update) return 'Updates are checked automatically a few times a day.';
  const version = update.release?.version_name;
  const notes = update.release?.notes ? ` ${update.release.notes}` : '';
  switch (update.status) {
    case 'checking': return 'Checking for updates…';
    case 'current': return 'You have the latest version.';
    case 'incompatible': return update.reason;
    case 'available': return `${update.error ? `${update.error} ` : ''}Version ${version} is available (${formatSize(update.release.apk_size)}).${notes}`;
    case 'downloading': return `Downloading version ${version}… ${formatSize(update.received || 0)} of ${formatSize(update.total || update.release.apk_size)}.`;
    case 'downloaded': return blocked || update.notice || `${update.error ? `${update.error} ` : ''}Version ${version} is ready to install. Your draft and remembered frames are kept.`;
    case 'installing': return 'Opening the Android installer…';
    case 'error': return update.error;
    default: return '';
  }
}

// A verified download for the offered release can be installed without downloading again.
export function resolveUpdate(installed, release) {
  const decision = updateDecision(installed, release);
  const downloaded = decision.status === 'available' && installed.downloadedSha256 === release.apk_sha256;
  return {installed, release, ...decision, status: downloaded ? 'downloaded' : decision.status};
}

function readCheck(storage) {
  try {return JSON.parse(storage.getItem(updateCheckKey)) || null;} catch {return null;}
}

export function updateCheckDue(storage, now = Date.now(), interval = updateCheckInterval) {
  const last = Number(readCheck(storage)?.at);
  return !Number.isFinite(last) || last <= 0 || now - last >= interval || last > now;
}

export function rememberUpdateCheck(storage, release = null, now = Date.now()) {
  try {storage.setItem(updateCheckKey, JSON.stringify({at: now, release}));} catch { /* Storage can be disabled. */ }
}

export function rememberedRelease(storage) {
  try {return validateRelease(readCheck(storage)?.release);} catch {return null;}
}
