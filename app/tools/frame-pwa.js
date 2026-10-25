import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

export function framePwa() {
  return {
    name: 'frame-pwa', enforce: 'post',
    generateBundle(options, bundle) {
      const entry = Object.values(bundle).find(item => item.type === 'chunk' && item.name === 'frame' && item.isEntry);
      if (!entry) throw new Error('Frame app entry was not built');
      const files = new Set(['/frame/index.html', '/frame/manifest.webmanifest', '/frame/icon.svg', '/frame/icon-192.png',
        '/frame/icon-512.png', '/frame/photo-worker.js', '/frame/vendor/dither.js', '/frame/vendor/filters.js']);
      const visit = filename => {
        if (files.has(`/${filename}`)) return;
        files.add(`/${filename}`);
        const chunk = bundle[filename];
        if (chunk?.type === 'chunk') {
          for (const dependency of [...chunk.imports, ...chunk.dynamicImports]) visit(dependency);
          for (const css of chunk.viteMetadata?.importedCss || []) files.add(`/${css}`);
          for (const asset of chunk.viteMetadata?.importedAssets || []) files.add(`/${asset}`);
        }
      };
      visit(entry.fileName);
      const hash = createHash('sha256');
      for (const path of [...files].sort()) {
        const built = bundle[path.slice(1)];
        hash.update(path).update(built ? (built.type === 'chunk' ? built.code : built.source) : readFileSync(`public${path}`));
      }
      const template = readFileSync('tools/frame-sw-template.js', 'utf8');
      hash.update(template);
      const source = template
        .replace('__CACHE__', `frame-app-${hash.digest('hex').slice(0,16)}`).replace('__FILES__', JSON.stringify([...files]));
      this.emitFile({type: 'asset', fileName: 'frame/sw.js', source});
    },
  };
}
