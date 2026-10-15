import { configDefaults, defineProject } from 'vitest/config';

export default defineProject({
  test: {
    // The roof benchmark's tests need no database: they run in their own project (vitest.bench.config.ts).
    exclude: [...configDefaults.exclude, 'test/bench/**'],
    // Same Testcontainers PostGIS harness as @roofline/db. Each Vitest project runs its own
    // globalSetup, so this project gets its own container, and its resetDb never touches the
    // database that packages/db's tests are using at the same time.
    globalSetup: ['../../packages/db/src/testing/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Tests share one database, so test files run one after another.
    fileParallelism: false,
  },
});
