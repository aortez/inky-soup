const storageKey = 'sparkle-frames-v1';
const validId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);

export function validateIdentity(value) {
  if (!value || !validId(value.id) || !validId(value.instance_id) || value.api_version !== 1
      || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 255
      || !Array.isArray(value.capabilities) || !value.capabilities.includes('device-identity-v1')) {
    throw new Error('Update the frame firmware to support remembered frames, then reconnect.');
  }
  return value;
}

export function frameRegistry(storage, persist = () => {}) {
  let notice = '';
  function read() {
    const empty = {version: 1, selected: null, frames: []};
    try {
      const raw = storage.getItem(storageKey);
      if (!raw) return empty;
      const value = JSON.parse(raw);
      if (value.version !== 1 || !Array.isArray(value.frames)
          || value.frames.some(frame => !validId(frame.id) || typeof frame.base !== 'string' || typeof frame.name !== 'string')
          || new Set(value.frames.map(frame => frame.id)).size !== value.frames.length) throw new Error('Invalid registry');
      return value;
    } catch {
      notice = 'Saved frame settings could not be read. Enter a frame address or find it on WiFi to remember it again. Your photos and draft are still available.';
      return empty;
    }
  }
  function write(value, signal) {
    const previous = storage.getItem(storageKey);
    storage.setItem(storageKey, JSON.stringify(value)); notice = '';
    return Promise.resolve(persist(value, signal)).catch(error => {
      if (previous === null) storage.removeItem(storageKey);
      else storage.setItem(storageKey, previous);
      throw error;
    });
  }
  return {
    get notice() {return notice;},
    list: () => read().frames,
    selected: () => {const value = read(); return value.frames.find(frame => frame.id === value.selected) || null;},
    remember(frame, signal) {
      if (!validId(frame.id)) throw new Error('A verified frame identity is required.');
      const value = read();
      value.frames = [...value.frames.filter(item => item.id !== frame.id), frame];
      value.selected = frame.id; return write(value, signal);
    },
    select(id) {
      const value = read();
      if (!value.frames.some(frame => frame.id === id)) throw new Error('Choose a saved frame.');
      value.selected = id; return write(value);
    },
    forget(id) {
      const value = read();
      value.frames = value.frames.filter(frame => frame.id !== id);
      if (value.selected === id) value.selected = null;
      return write(value);
    },
  };
}

// An old address alone never grants ownership of an original on a newly verified device.
export function draftForFrame(draft, frame) {
  if (!draft?.sourceFilename) return draft;
  if (!draft.sourceDeviceId) return {...draft, sourceFrame:null, sourceFilename:null, pending_photo_rotation:null, photo_rotation_revision:0};
  if (draft.sourceDeviceId !== frame.id) return {...draft, sourceFrame:null};
  return {...draft, sourceFrame:frame.base,
    pending_photo_rotation:draft.pending_photo_rotation ? {...draft.pending_photo_rotation, base:frame.base} : null};
}

export function jobForFrame(job, frame) {
  if (!job) return null;
  if (!job.deviceId || !job.instanceId) throw new Error('The saved refresh predates device identity. Check the screen before sending again.');
  if (job.deviceId !== frame.id) throw new Error('The saved refresh belongs to another frame. Select that frame to check it.');
  if (job.instanceId !== frame.instance_id) throw new Error('The frame restarted. Check the screen before sending again.');
  return {...job, base:frame.base};
}
