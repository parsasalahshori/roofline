import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    environment: 'jsdom',
    setupFiles: ['test/setup.ts'],
    // Unit tests only. The browser tests in e2e/ are run by Playwright (Task 19) and must never be
    // picked up here.
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
