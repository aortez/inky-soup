import {test} from 'node:test';
import assert from 'node:assert/strict';

test('legacy metadata survives draft normalization and missing fields receive defaults', async () => {
  const {imageSettings} = await import('../frame/core/settings.js');
  const legacy = {fit_mode:'cover',filter:'lanczos',brightness:35,contrast:-20,saturation:0,dither_algorithm:'atkinson'};
  assert.deepEqual(imageSettings(legacy), {photo_rotation_degrees:0,photo_rotation_revision:0,fit:'cover',filter:'lanczos',brightness:35,contrast:-20,saturation:0,dither:'atkinson'});
  assert.deepEqual(imageSettings(imageSettings(legacy)), imageSettings(legacy));
  assert.equal(imageSettings({filter:'unknown',brightness:NaN,contrast:101}).filter, 'bicubic');
  assert.equal(imageSettings({brightness:NaN,contrast:101}).brightness, 0);
});

test('photo rotation and revision survive draft round trips independently of mounting', async () => {
  const {imageSettings} = await import('../frame/core/settings.js');
  for (const degrees of [0,90,180,270]) {
    const settings = imageSettings({photo_rotation_degrees:degrees, photo_rotation_revision:12, rotation_degrees:270});
    assert.equal(settings.photo_rotation_degrees,degrees);
    assert.equal(settings.photo_rotation_revision,12);
    assert.deepEqual(imageSettings(settings),settings);
  }
  assert.equal(imageSettings({photo_rotation_degrees:45}).photo_rotation_degrees,0);
});
