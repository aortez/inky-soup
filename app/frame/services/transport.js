import {androidApp} from '../core/platform.js';

let native;
async function adapter() {
  if (!native) native = loadAdapter();
  return native;
}

async function loadAdapter() {
  const [{registerPlugin}, {nativeTransport}] = await Promise.all([import('@capacitor/core'), import('./native-transport.js')]);
  return nativeTransport(registerPlugin('FrameTransport'));
}

export async function selectDevice(base) {
  if (androidApp) await (await adapter()).select(base);
}

export async function deviceFetch(base, path, options = {}) {
  if (androidApp) return (await adapter()).fetch(base, path, options);
  return fetch(`${base}${path}`, {credentials: 'omit', cache: 'no-store', redirect: 'error', ...options});
}
