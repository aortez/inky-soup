export function updateBlockReason(state) {
  if (state.job) return 'Reload will be available when your frame finishes refreshing.';
  if (state.busy || state.importing || state.connecting) return 'Finish the current task before reloading.';
  if (state.processing) return 'Your photo preview is finishing. Reload will be available shortly.';
  if (state.imports.some(item => !item.regenerate && item.status !== 'Saved')) {
    return 'Finish adding your photos before reloading.';
  }
  return '';
}
