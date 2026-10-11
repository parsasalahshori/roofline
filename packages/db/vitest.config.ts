import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    // One PostGIS container per run. Pulling and starting the amd64 image under emulation is slow.
    globalSetup: ['./src/testing/global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Tests share one database, so test files run one after another.
    fileParallelism: false,
  },
});
