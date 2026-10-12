import { defineProject } from 'vitest/config';

// The hand-run scripts' pure parts (G1 Task 18a). No database and no network: nothing here calls a model.
export default defineProject({
  test: {
    name: 'scripts',
    include: ['test/**/*.test.ts'],
  },
});
