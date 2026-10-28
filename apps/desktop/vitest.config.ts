import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  test: {
    name: '@ee/desktop',
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    css: true,
    // Two Electron tests must not launch the binary (or download it) at the
    // same time: that races into ETXTBSY on CI.
    fileParallelism: false,
  },
});
