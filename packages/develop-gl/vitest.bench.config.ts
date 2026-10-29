import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

// Not part of the test run: `pnpm --filter @ee/develop-gl bench`.
export default defineConfig({
  test: {
    name: 'develop-gl (bench)',
    include: ['bench/**/*.bench.ts'],
    testTimeout: 600_000,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({
        launchOptions: {
          args: [
            '--use-angle=swiftshader',
            '--use-gl=angle',
            '--enable-unsafe-swiftshader',
            '--ignore-gpu-blocklist',
          ],
        },
      }),
      instances: [{ browser: 'chromium' }],
    },
  },
});
