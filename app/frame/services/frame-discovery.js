import {validateIdentity} from '../core/frame-registry.js';
import {normalizeAddress, request} from './frame-client.js';

export async function identifyFrame(base, signal) {
  base = normalizeAddress(base);
  const timeout = AbortSignal.timeout(4000);
  const identity = validateIdentity(await request(base, '/api/device', {timeout:4000,
    signal:signal ? AbortSignal.any([signal, timeout]) : timeout}));
  signal?.throwIfAborted();
  return {...identity, base};
}

export async function discoverFrames(bridge, signal, identify = identifyFrame) {
  const {services} = await bridge.discover();
  signal?.throwIfAborted();
  const bases = [...new Set((services || []).map(service => service.base))].slice(0, 16);
  const found = new Map();
  // Bound concurrent native requests, and probe identity without selecting a transport.
  for (let offset = 0; offset < bases.length; offset += 4) {
    const results = await Promise.allSettled(bases.slice(offset, offset + 4).map(base => identify(base, signal)));
    signal?.throwIfAborted();
    for (const result of results) if (result.status === 'fulfilled') found.set(result.value.id, result.value);
  }
  return [...found.values()];
}

export async function locateFrame(frame, bridge, signal, identify = identifyFrame) {
  try {
    const candidate = await identify(frame.base, signal);
    if (candidate.id === frame.id) return candidate;
  } catch { signal?.throwIfAborted(); }
  const candidates = await discoverFrames(bridge, signal, identify);
  const match = candidates.find(candidate => candidate.id === frame.id);
  if (!match) throw new Error('Your saved frame is unavailable. Check power, WiFi, and local-network permission in Android Settings, then Retry. If WiFi changed, use Bluetooth setup. Networks that block discovery may require its new address.');
  return match;
}
