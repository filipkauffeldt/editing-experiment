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
    // same time: that races into ETXTBSY on CI. The raw tests also decode large
    // NEFs, so running this package's files in parallel is not worth the flake.
    fileParallelism: false,
    // A stuck app launch or close fails the job instead of holding the runner.
    hookTimeout: 60_000,
    teardownTimeout: 60_000,
    bail: process.env.CI === '1' ? 1 : 0,
  },
});
