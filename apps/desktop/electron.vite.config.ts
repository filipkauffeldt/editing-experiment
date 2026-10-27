import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import { resolve } from 'node:path';

// Workspace packages are TypeScript source that Node cannot load, so they are
// bundled into the main/jobs output instead of being left as external imports.
const bundledWorkspacePackages = ['@ee/contracts', '@ee/core'];

// Only the renderer's own bundle and `app:` images may load; applied at build time
// because the dev server needs inline scripts for React refresh.
const contentSecurityPolicy: Plugin = {
  name: 'ee-content-security-policy',
  apply: 'build',
  transformIndexHtml: () => [
    {
      tag: 'meta',
      attrs: {
        'http-equiv': 'Content-Security-Policy',
        content:
          "default-src 'self'; img-src 'self' app: data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' app:",
      },
      injectTo: 'head-prepend',
    },
  ],
};

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: bundledWorkspacePackages },
      rollupOptions: {
        // `jobs` is the utility process entry; it lives next to `index` so
        // main can fork it by file name.
        input: {
          index: resolve(import.meta.dirname, 'src/main/index.ts'),
          jobs: resolve(import.meta.dirname, 'src/jobs/index.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: { exclude: bundledWorkspacePackages },
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, 'src/preload/index.ts') },
        // Sandboxed preload scripts must be CommonJS.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    plugins: [react(), contentSecurityPolicy],
    build: {
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, 'src/renderer/index.html') },
      },
    },
  },
});
