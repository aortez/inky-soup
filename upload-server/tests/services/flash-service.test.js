import { describe, it, expect } from 'vitest';

import { computeFlashBufferDimensions } from '../../static/js/services/flash-service.js';

describe('flash-service computeFlashBufferDimensions', () => {
  it('keeps physical dimensions for 0 and 180 degree mounts', () => {
    expect(computeFlashBufferDimensions(0, 1600, 1200)).toEqual({ width: 1600, height: 1200 });
    expect(computeFlashBufferDimensions(180, 1600, 1200)).toEqual({ width: 1600, height: 1200 });
  });

  it('swaps dimensions for 90 and 270 degree mounts', () => {
    expect(computeFlashBufferDimensions(90, 1600, 1200)).toEqual({ width: 1200, height: 1600 });
    expect(computeFlashBufferDimensions(270, 1600, 1200)).toEqual({ width: 1200, height: 1600 });
  });
});
