import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*', 'apps/api/vitest.bench.config.ts', 'scripts'],
  },
});
