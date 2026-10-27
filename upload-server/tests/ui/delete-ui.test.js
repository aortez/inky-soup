import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as state from '../../static/js/core/state.js';
import { elements } from '../../static/js/core/dom.js';
import { confirmDelete } from '../../static/js/ui/delete-ui.js';

describe('legacy Delete button', () => {
  let respond;

  beforeEach(() => {
    state.setCurrentFilename('photo.png');
    state.setCurrentSessionId('editor');
    elements.deleteConfirmModal = { classList: { remove: vi.fn() } };
    vi.stubGlobal('window', { location: { href: '/#detail' } });
    vi.stubGlobal('alert', vi.fn());
    vi.stubGlobal('fetch', vi.fn(async () => respond()));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('deletes with the page\'s edit session, then returns to the gallery', async () => {
    respond = () => ({ ok: true, json: async () => ({ success: true, filename: 'photo.png' }) });
    await confirmDelete();
    const [path, options] = fetch.mock.calls[0];
    expect(path).toBe('/api/delete-image');
    expect(JSON.parse(options.body)).toEqual({ filename: 'photo.png', session_id: 'editor' });
    expect(window.location.href).toBe('/');
    expect(alert).not.toHaveBeenCalled();
  });

  it('keeps the photo open and says why when the server refuses', async () => {
    respond = () => ({
      ok: false,
      statusText: 'Conflict',
      json: async () => ({
        success: false,
        message: 'This photo is queued or refreshing. Wait for the display to finish',
      }),
    });
    await confirmDelete();
    expect(alert).toHaveBeenCalledWith(
      'Cannot delete: This photo is queued or refreshing. Wait for the display to finish',
    );
    expect(elements.deleteConfirmModal.classList.remove).toHaveBeenCalledWith('active');
    expect(window.location.href).toBe('/#detail');
  });
});
