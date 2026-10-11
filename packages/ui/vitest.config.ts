import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    environment: 'jsdom',
    setupFiles: ['test/setup.ts'],
    // Tests assert roles and data-* attributes, never generated class names, but keeping the
    // class names readable makes a failing DOM dump easier to follow.
    css: { modules: { classNameStrategy: 'non-scoped' } },
  },
});
