import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import path from 'node:path';
import fs from 'node:fs';
import { licenseReport, packageDirOf } from './scripts/licenses.mjs';

// Где исходный код этой сборки (ссылка в справке — так велит лицензия AGPL для веб-программ):
// сборка на GitHub Actions подставляет свой репозиторий сама (TAVERNA_SOURCE_URL), иначе — homepage из package.json
const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
const SOURCE_URL = process.env.TAVERNA_SOURCE_URL || pkg.homepage || '';

// Тексты лицензий пакетов, попавших в сайт: dist/licenses.txt (ссылка — в справке на столе)
const licenses = () => ({
  name: 'taverna-licenses',
  apply: 'build',
  generateBundle(_, bundle) {
    const dirs = new Set();
    for (const item of Object.values(bundle)) {
      if (item.type !== 'chunk') continue;
      for (const id of Object.keys(item.modules)) {
        const d = packageDirOf(id);
        if (d) dirs.add(d);
      }
    }
    // шрифты подключаются как CSS и в список модулей могут не попасть
    for (const f of ['@fontsource/alegreya', '@fontsource/alegreya-sans']) dirs.add(path.resolve('node_modules', f));
    this.emitFile({ type: 'asset', fileName: 'licenses.txt', source: licenseReport([...dirs], 'Таверна, сайт (то, что работает в браузере)') });
  },
});

export default defineConfig({
  root: path.resolve('client'),
  publicDir: path.resolve('client/public'),
  plugins: [preact(), licenses()],
  define: {
    __TAVERNA_SOURCE__: JSON.stringify(SOURCE_URL),
  },
  resolve: {
    alias: {
      '@shared': path.resolve('shared'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/uploads': 'http://localhost:3000',
      '/socket.io': { target: 'http://localhost:3000', ws: true },
    },
  },
  build: {
    outDir: path.resolve('dist'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
    sourcemap: false,
  },
});
