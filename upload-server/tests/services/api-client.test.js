import {
  afterEach, describe, expect, it, vi,
} from 'vitest';

import { updateDisplayRotation } from '../../static/js/services/api-client.js';

describe('api-client updateDisplayRotation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns payload when rotation update succeeds', async () => {
    const payload = { success: true, rotation_degrees: 90 };
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => payload,
    }));

    const result = await updateDisplayRotation(90);
    expect(result).toEqual(payload);
    expect(global.fetch).toHaveBeenCalledWith('/api/settings/display-rotation', expect.objectContaining({
      method: 'POST',
    }));
  });

  it('throws clear error when rotation update fails validation', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        success: false,
        message: 'rotation_degrees must be one of 0, 90, 180, 270',
      }),
    }));

    await expect(updateDisplayRotation(45)).rejects.toThrow(
      'rotation_degrees must be one of 0, 90, 180, 270',
    );
  });
});
