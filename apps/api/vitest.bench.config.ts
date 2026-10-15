import { defineProject } from 'vitest/config';

/**
 * The roof benchmark's own tests: pure geometry, scoring and gate logic on synthetic data. No database and no network,
 * so unlike the rest of this package they need no Testcontainer: `npm run test:bench -w @roofline/api`.
 */
export default defineProject({
  test: {
    name: 'roof-bench',
    include: ['test/bench/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
