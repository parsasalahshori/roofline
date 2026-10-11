import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

/*
 * Import boundary: `@roofline/db/system` is the app_system pool (its RLS policies let it through
 * every company's rows), so it can read across companies. Everything else goes through `withTenant`. Only the places below may import it
 * (ruled in Task 19; scripts ratified in Task 14). Adding a place here is a design decision, not a
 * lint fix. The relative patterns close the back door: a path straight into the db package's source.
 */
const DB_SYSTEM_PATTERN = {
  group: [
    '@roofline/db/system',
    '@roofline/db/system/*',
    '**/packages/db/src/system',
    '**/packages/db/src/system/**',
  ],
  message:
    'Only auth, the Twilio hooks, the scheduler jobs, scripts, the worker and the db package may import @roofline/db/system. Use withTenant from @roofline/db instead.',
};

const DB_SYSTEM_RESTRICTION = { patterns: [DB_SYSTEM_PATTERN] };

const DB_SYSTEM_ALLOWED = [
  'apps/api/src/auth/**',
  'apps/api/src/hooks/**',
  'apps/api/src/jobs/scheduler/**',
  'apps/api/src/scripts/**',
  'apps/worker/**',
  'packages/db/**',
  '**/test/**',
];

/*
 * Web boundary (F2): the web app and the design kit run in the browser, so they import only
 * @roofline/ui, @roofline/shared and npm packages, and talk to the server over HTTP. The relative
 * patterns close the back door, as above. The end-to-end tests (apps/web/e2e) sit outside src and
 * may import the server packages.
 */
const WEB_PATTERN = {
  group: [
    '@roofline/db',
    '@roofline/db/**',
    '@roofline/send-gate',
    '@roofline/send-gate/**',
    '@roofline/api',
    '@roofline/api/**',
    '**/packages/db/src/**',
    '**/packages/send-gate/src/**',
    '**/api/src/**',
  ],
  message:
    'The web app and the design kit import only @roofline/ui, @roofline/shared and npm packages. Ask the server over HTTP instead of importing @roofline/db, @roofline/send-gate or @roofline/api.',
};

// Flat config replaces a rule's options in each block that matches, so the web block holds both pattern sets.
const WEB_RESTRICTION = { patterns: [DB_SYSTEM_PATTERN, WEB_PATTERN] };

// Spec 4.7: every word on screen comes from apps/web/src/copy, so JSX holds no text of its own.
const NO_LITERAL_TEXT = [
  {
    selector: 'JSXText[value=/[A-Za-z]/]',
    message: 'Put UI text in apps/web/src/copy and pass it in.',
  },
  {
    selector: 'JSXAttribute[name.name=/^(aria-label|title|placeholder|alt|label)$/] > Literal[value=/[A-Za-z]/]',
    message: 'Put UI text in apps/web/src/copy and pass it in.',
  },
];

// The kit's own Button and IconButton are built on a raw button; nothing else in the web app is.
const NO_RAW_BUTTON = {
  selector: 'JSXOpeningElement[name.name="button"]',
  message: 'Use Button or IconButton from @roofline/ui.',
};

export default defineConfig(
  { ignores: ['v1/**', '**/node_modules/**', '.superpowers/**', 'apps/web/dist/**', '**/playwright-report/**'] },
  {
    files: ['{apps,packages}/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    rules: { 'no-restricted-imports': ['error', DB_SYSTEM_RESTRICTION] },
  },
  {
    files: ['**/*.tsx'],
    extends: [reactHooks.configs.flat.recommended],
  },
  {
    // `off` switches the whole rule off here, so any restriction added to it later must be
    // repeated for these places if it should apply to them.
    files: DB_SYSTEM_ALLOWED,
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    // After the block above on purpose: `**/test/**` there must not switch the web boundary off
    // for a folder named test under src.
    files: ['apps/web/src/**/*.{ts,tsx}', 'packages/ui/src/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': ['error', WEB_RESTRICTION] },
  },
  {
    files: ['apps/web/src/**/*.tsx', 'packages/ui/src/**/*.tsx'],
    rules: { 'no-restricted-syntax': ['error', ...NO_LITERAL_TEXT] },
  },
  {
    // Repeats the text rules: a later block replaces the rule's options, it does not add to them.
    files: ['apps/web/src/**/*.tsx'],
    rules: { 'no-restricted-syntax': ['error', ...NO_LITERAL_TEXT, NO_RAW_BUTTON] },
  },
);
