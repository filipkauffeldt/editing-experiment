import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

// Runs the shaders in real headless Chromium. SwiftShader provides WebGL2 without a GPU
// (CI, containers); a machine with a GPU can still use it, the flags only allow the fallback.
export default defineConfig({
  test: {
    name: 'develop-gl (browser)',
    include: ['test/**/*.browser.test.ts'],
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
