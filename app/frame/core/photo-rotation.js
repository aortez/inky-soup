// A pending operation belongs to one original on one frame, not to its pixels.
export function pendingPhotoRotation(draft, base, filename) {
  const pending = draft?.pending_photo_rotation;
  if (!pending || pending.base !== base || pending.filename !== filename
      || typeof pending.operation_id !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(pending.operation_id)
      || !Number.isSafeInteger(pending.expected_revision) || pending.expected_revision < 0
      || ![0,90,180,270].includes(pending.photo_rotation_degrees)) return null;
  return pending;
}
