export function processPhoto(draft, config, signal) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('/frame/photo-worker.js');
    const finish = (error, result) => {
      worker.terminate();
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(result);
    };
    const abort = () => finish(new DOMException('Photo changed', 'AbortError'));
    if (signal?.aborted) {abort(); return;}
    signal?.addEventListener('abort', abort, {once: true});
    worker.onerror = () => finish(new Error('Could not process this photo. Try a JPEG, PNG, WebP, or GIF image.'));
    worker.onmessage = ({data}) => finish(data.error ? new Error(data.error) : null, data);
    worker.postMessage({...draft, config});
  });
}
