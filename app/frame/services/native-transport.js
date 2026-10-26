const chunkSize = 64 * 1024;
const maximumBody = 24 * 1024 * 1024;

function encoded(bytes) {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}

// Dependency injection lets tests exercise the bridge protocol without a phone.
export function nativeTransport(bridge) {
  return {
    select: base => bridge.select({base}),
    async fetch(base, path, options = {}) {
      const id = crypto.randomUUID();
      const signal = options.signal;
      let bodyId, responseId;
      const abort = () => {bridge.cancel({id}).catch(() => {});};
      signal?.throwIfAborted();
      signal?.addEventListener('abort', abort, {once: true});
      try {
        let contentType;
        if (options.body !== undefined) {
          // The browser encodes multipart boundaries/filenames. Only small slices
          // cross the bridge; native HTTP streams the resulting private file.
          const body = new Response(options.body, {headers: options.headers});
          contentType = body.headers.get('content-type');
          const blob = await body.blob();
          if (blob.size > maximumBody) throw new Error('Choose a photo under 20 MB.');
          ({id: bodyId} = await bridge.create());
          for (let offset = 0; offset < blob.size; offset += chunkSize) {
            signal?.throwIfAborted();
            const bytes = new Uint8Array(await blob.slice(offset, offset + chunkSize).arrayBuffer());
            await bridge.append({id: bodyId, data: encoded(bytes)});
          }
        }
        signal?.throwIfAborted();
        const result = await bridge.request({id, base, path, method: options.method || 'GET',
          bodyId, contentType, binary: options.binary === true, timeout: options.timeout ?? 60000});
        responseId = result.id;
        signal?.throwIfAborted();
        if (!Number.isSafeInteger(result.size) || result.size < 0 || result.size > maximumBody) throw new Error('Invalid frame response size.');
        const chunks = [];
        for (let offset = 0; offset < result.size; offset += chunkSize) {
          signal?.throwIfAborted();
          const {data} = await bridge.read({id: responseId, offset});
          const bytes = Uint8Array.from(atob(data), character => character.charCodeAt(0));
          if (bytes.length !== Math.min(chunkSize, result.size - offset)) throw new Error('Incomplete frame response.');
          chunks.push(bytes);
        }
        return new Response(new Blob(chunks), {status: result.status, headers: {'Content-Type': result.contentType}});
      } finally {
        signal?.removeEventListener('abort', abort);
        if (bodyId) await bridge.release({id: bodyId}).catch(() => {});
        if (responseId) await bridge.release({id: responseId}).catch(() => {});
      }
    },
  };
}
