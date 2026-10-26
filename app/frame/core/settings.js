export const settingIds = ['fit', 'photo_rotation_degrees', 'saturation', 'brightness', 'contrast', 'filter', 'dither'];

export function imageSettings(source = {}) {
  const choice = (value, choices, fallback) => choices.includes(value) ? value : fallback;
  const number = (value, min, max, fallback) => Number.isFinite(value) && value >= min && value <= max ? value : fallback;
  return {
    photo_rotation_degrees: choice(source.photo_rotation_degrees, [0, 90, 180, 270], 0),
    photo_rotation_revision: Number.isSafeInteger(source.photo_rotation_revision) && source.photo_rotation_revision >= 0 ? source.photo_rotation_revision : 0,
    fit: choice(source.fit ?? source.fit_mode, ['contain', 'cover'], 'contain'),
    saturation: number(source.saturation, 0, 1, 0.5),
    brightness: number(source.brightness, -100, 100, 0),
    contrast: number(source.contrast, -100, 100, 0),
    filter: choice(source.filter, ['bicubic', 'lanczos', 'mitchell', 'bilinear', 'nearest'], 'bicubic'),
    dither: choice(source.dither ?? source.dither_algorithm, ['floyd-steinberg', 'atkinson', 'ordered'], 'floyd-steinberg'),
  };
}

export function validatePhoto(file) {
  if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) throw new Error('Choose a JPEG, PNG, WebP, or GIF photo.');
  if (file.size > 20 * 1024 * 1024) throw new Error('Choose a photo under 20 MB.');
}
