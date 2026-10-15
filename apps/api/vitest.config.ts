import { configDefaults, defineProject } from 'vitest/config';

export default defineProject({
  test: {
    // The roof benchmark's tests and the pure tests need no database: they run in their own projects
    // (vitest.bench.config.ts, vitest.pure.config.ts).
    exclude: [...configDefaults.exclude, 'test/bench/**', 'test/pure/**'],
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
