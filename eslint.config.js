import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

/*
 * Import boundary: `@roofline/db/system` is the app_system pool (BYPASSRLS), so it can read across
 * companies. Everything else goes through `withTenant`. Only the places below may import it
 * (ruled in Task 19; scripts ratified in Task 14). Adding a place here is a design decision, not a
 * lint fix. The relative patterns close the back door: a path straight into the db package's source.
 */
const DB_SYSTEM_RESTRICTION = {
  patterns: [
    {
      group: [
        '@roofline/db/system',
        '@roofline/db/system/*',
        '**/packages/db/src/system',
        '**/packages/db/src/system/**',
      ],
      message:
        'Only auth, the Twilio hooks, the scheduler jobs, scripts, the worker and the db package may import @roofline/db/system. Use withTenant from @roofline/db instead.',
    },
  ],
};

const DB_SYSTEM_ALLOWED = [
  'apps/api/src/auth/**',
  'apps/api/src/hooks/**',
  'apps/api/src/jobs/scheduler/**',
  'apps/api/src/scripts/**',
  'apps/worker/**',
  'packages/db/**',
  '**/test/**',
];

export default defineConfig(
  { ignores: ['v1/**', '**/node_modules/**', '.superpowers/**'] },
  {
    files: ['apps/**/*.ts', 'packages/**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    rules: { 'no-restricted-imports': ['error', DB_SYSTEM_RESTRICTION] },
  },
  {
    // `off` switches the whole rule off here, so any restriction added to it later must be
    // repeated for these places if it should apply to them.
    files: DB_SYSTEM_ALLOWED,
    rules: { 'no-restricted-imports': 'off' },
  },
);
