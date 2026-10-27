import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  submitFlashJob,
  uploadOriginalImage,
  uploadThumb,
} from '../../static/js/services/api-client.js';

describe('legacy API client failures', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports the server\'s explanation and status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      json: async () => ({
        success: false,
        message: 'Display orientation changed. Regenerate this photo before displaying it.',
      }),
    })));
    await expect(submitFlashJob('photo.png', false, 'editor', 0)).rejects.toMatchObject({
      message: 'Display orientation changed. Regenerate this photo before displaying it.',
      status: 409,
    });
  });

  it('falls back to the status for a failure without an explanation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      json: async () => { throw new SyntaxError('Unexpected token <'); },
    })));
    await expect(uploadThumb('photo.png', new Blob(['pixels']), 'editor', 0)).rejects.toMatchObject({
      message: 'Failed to upload thumbnail: Bad Gateway',
      status: 502,
    });
  });

  it.each([
    ['its explanation', 413,
      JSON.stringify({ success: false, message: 'The upload is larger than the frame accepts.' }),
      'The upload is larger than the frame accepts.'],
    ['the status without one', 502, '<html>Bad Gateway</html>', 'Upload failed with status 502'],
  ])('reports a refused original upload with %s', (_, status, responseText, message) => {
    vi.stubGlobal('XMLHttpRequest', class {
      upload = { addEventListener() {} };

      listeners = {};

      addEventListener(type, listener) { this.listeners[type] = listener; }

      open() {}

      send() {
        this.status = status;
        this.responseText = responseText;
        this.listeners.load();
      }
    });
    const onError = vi.fn();
    const onSuccess = vi.fn();
    uploadOriginalImage(new Blob(['photo']), () => {}, onSuccess, onError);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError.mock.calls[0][0].message).toBe(message);
  });
});
