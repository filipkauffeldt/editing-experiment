import { defineConfig } from 'vitest/config';

// One vitest project per workspace package. Each package may add its own
// vitest.config.ts; packages without one run with defaults.
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*', 'crates/*'],
  },
});
