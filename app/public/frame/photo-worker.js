/* Shared processing code is pinned to the device project's tested implementation. */
importScripts('./vendor/filters.js', './vendor/dither.js');

self.onmessage = async ({data: {blob, config, fit, saturation, filter = 'bicubic', brightness = 0, contrast = 0, dither = 'floyd-steinberg'}}) => {
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
    if (bitmap.width * bitmap.height > 64000000) throw new Error('Choose a photo smaller than 64 megapixels.');
    const source = new OffscreenCanvas(bitmap.width, bitmap.height);
    const sourceContext = source.getContext('2d');
    sourceContext.fillStyle = '#fff'; sourceContext.fillRect(0, 0, source.width, source.height);
    sourceContext.drawImage(bitmap, 0, 0); bitmap.close(); bitmap = null;
    const pixels = sourceContext.getImageData(0, 0, source.width, source.height);
    const resized = FilterLib.resizeToFit(pixels, config.width, config.height, filter, fit);
    const canvas = new OffscreenCanvas(config.width, config.height);
    const context = canvas.getContext('2d');
    context.putImageData(resized, 0, 0);
    const cache = await canvas.convertToBlob({type: 'image/png'});
    const thumbnail = new OffscreenCanvas(config.thumb_width, config.thumb_height);
    thumbnail.getContext('2d').drawImage(canvas, 0, 0, thumbnail.width, thumbnail.height);
    const thumb = await thumbnail.convertToBlob({type: 'image/png'});
    applyBrightnessContrast(resized, brightness, contrast);
    context.putImageData(resized, 0, 0);
    const adjusted = await canvas.convertToBlob({type: 'image/png'});
    const dithered = ditherForEInk(resized, saturation, dither, config.model);
    context.putImageData(dithered, 0, 0);
    self.postMessage({cache, thumb, adjusted, dithered: await canvas.convertToBlob({type: 'image/png'}), width: config.width, height: config.height, rotation_revision: config.rotation_revision ?? 0});
  } catch (error) { self.postMessage({error: error.message}); }
  finally { bitmap?.close(); }
};
