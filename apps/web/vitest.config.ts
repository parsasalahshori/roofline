import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    environment: 'jsdom',
    setupFiles: ['test/setup.ts'],
    // Unit tests only. The browser tests in e2e/ are run by Playwright (Task 19) and must never be
    // picked up here.
    include: ['test/**/*.test.{ts,tsx}'],
    // The shell tests mount the whole app (router, providers, shell). Under the parallel load other
    // worktrees put on this machine, one such test has taken over 5s, Vitest's default limit.
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
