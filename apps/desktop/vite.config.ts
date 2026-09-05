import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  root: resolve(import.meta.dirname, 'src/renderer'),
  build: {
    outDir: resolve(import.meta.dirname, 'dist/renderer'),
    emptyOutDir: false,
  },
});
