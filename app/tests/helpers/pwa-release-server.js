import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve, extname} from 'node:path';

// Serve successive built releases over real HTTP: Playwright routing does not
// intercept the browser's service-worker script/update requests.
export async function releaseServer() {
  const root = resolve('dist');
  const state = {version: 1, failDownload: false, holdDownload: null};
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      const path = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
      const filename = resolve(root, `.${path}`);
      if (!filename.startsWith(`${root}/`)) {response.writeHead(404).end(); return;}
      if (state.version === 2 && path === '/frame/icon-512.png') {
        if (state.holdDownload) await state.holdDownload;
        if (state.failDownload) {response.writeHead(503).end(); return;}
      }
      let body = await readFile(filename);
      if (path === '/frame/sw.js') body = Buffer.from(body.toString().replace(/(const CACHE = '[^']+)';/, `$1-test-${state.version}';`));
      if (path === '/frame/index.html') body = Buffer.from(body.toString().replace('<html lang="en">', `<html lang="en" data-release="${state.version}">`));
      const type = {'.js':'text/javascript','.html':'text/html','.css':'text/css','.png':'image/png',
        '.svg':'image/svg+xml','.webmanifest':'application/manifest+json'}[extname(filename)] || 'application/octet-stream';
      response.writeHead(200, {'Content-Type':type,'Cache-Control':'no-store'}).end(body);
    } catch {response.writeHead(404).end();}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    state, url: `http://127.0.0.1:${server.address().port}/frame/`,
    close: () => new Promise(resolve => {server.close(resolve); server.closeAllConnections();}),
  };
}
