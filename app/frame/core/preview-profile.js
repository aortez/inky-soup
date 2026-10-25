const profiles = {
  'impression-5.7': {width: 600, height: 448, thumb_width: 150, thumb_height: 112},
  'impression-13.3-2025': {width: 1600, height: 1200, thumb_width: 160, thumb_height: 120},
};

export function previewConfig(model = 'impression-5.7', portrait = false) {
  const size = profiles[model];
  if (!size) throw new Error('Choose a supported display.');
  return {
    ...size, model, physical_width: size.width, physical_height: size.height,
    width: portrait ? size.height : size.width, height: portrait ? size.width : size.height,
    thumb_width: portrait ? size.thumb_height : size.thumb_width,
    thumb_height: portrait ? size.thumb_width : size.thumb_height,
    rotation_degrees: portrait ? 90 : 0, rotation_revision: 0, orientation_supported: false,
  };
}

export function savedPreviewConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem('sparkle-preview-profile'));
    return previewConfig(saved?.model, saved?.portrait === true);
  } catch { return previewConfig(); }
}

export function rememberPreviewConfig(config) {
  try {
    localStorage.setItem('sparkle-preview-profile', JSON.stringify({model: config.model, portrait: config.rotation_degrees === 90}));
  } catch { /* Preview remains available when storage is unavailable. */ }
}
