import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: '@ee/desktop', include: ['test/**/*.test.ts'] },
});
