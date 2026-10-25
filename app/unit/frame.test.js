import {test} from 'node:test';
import assert from 'node:assert/strict';

test('legacy metadata survives draft normalization and missing fields receive defaults', async () => {
  const {imageSettings} = await import('../frame/core/settings.js');
  const legacy = {fit_mode:'cover',filter:'lanczos',brightness:35,contrast:-20,saturation:0,dither_algorithm:'atkinson'};
  assert.deepEqual(imageSettings(legacy), {fit:'cover',filter:'lanczos',brightness:35,contrast:-20,saturation:0,dither:'atkinson'});
  assert.deepEqual(imageSettings(imageSettings(legacy)), imageSettings(legacy));
  assert.equal(imageSettings({filter:'unknown',brightness:NaN,contrast:101}).filter, 'bicubic');
  assert.equal(imageSettings({brightness:NaN,contrast:101}).brightness, 0);
});
