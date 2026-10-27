import { defineConfig } from 'vitest/config';

// Node unit tests. The WebGL parity tests need a browser: see vitest.browser.config.ts.
export default defineConfig({
  test: {
    name: 'develop-gl',
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.browser.test.ts', '**/node_modules/**'],
  },
});
