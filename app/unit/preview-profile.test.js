import {test} from 'node:test';
import assert from 'node:assert/strict';
import {previewConfig} from '../frame/core/preview-profile.js';
import {validateConfig} from '../frame/services/frame-client.js';

test('offline profiles use panel dimensions and preserve native geometry in portrait', () => {
  for (const [model, width, height] of [['impression-5.7', 600, 448], ['impression-13.3-2025', 1600, 1200]]) {
    for (const portrait of [false, true]) {
      const config = validateConfig(previewConfig(model, portrait));
      assert.deepEqual([config.width, config.height], portrait ? [height, width] : [width, height]);
      assert.deepEqual([config.physical_width, config.physical_height], [width, height]);
      assert.equal(config.orientation_supported, false);
      assert.equal(config.photo_rotation_supported, true);
      assert.equal(config.orientation_test_supported, false);
    }
  }
  assert.throws(() => previewConfig('unknown'), /supported display/);
});
