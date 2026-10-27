import {copyFileSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {defineConfig} from 'vite';
import {framePwa} from './tools/frame-pwa.js';

// Vite's configuration contract requires a default export.
export default defineConfig(({mode}) => {
  const android = mode === 'android';
  const {version} = JSON.parse(readFileSync('package.json', 'utf8'));
  return {
    define: {'import.meta.env.APP_ANDROID': JSON.stringify(android), 'import.meta.env.APP_VERSION': JSON.stringify(version)},
    plugins: android ? [{
      name: 'android-entry',
      transformIndexHtml(html) {
        return html.replace(/\s*<link rel="manifest"[^>]+>/, '').replace('<head>', `<head>
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' blob: data:; worker-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'none'">`);
      },
      closeBundle() {
        copyFileSync(resolve('dist-android/frame/index.html'), resolve('dist-android/index.html'));
      },
    }] : [framePwa()],
    build: {
      outDir: android ? 'dist-android' : 'dist',
      rollupOptions: {input: android ? {frame: './frame/index.html'} : {
        frame: './frame/index.html', setup: './setup/index.html', wifi: './wifi/index.html',
      }},
    },
    server: {host: '127.0.0.1', port: 8080, strictPort: true},
  };
});
