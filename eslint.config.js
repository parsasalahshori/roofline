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
    'Only auth, the Twilio and Stripe hooks, the Front Desk relay socket, the call recording start and store job, the missed-call text-back, the scheduler jobs, account and public routes, scripts, the worker and the db package may import @roofline/db/system. Use withTenant from @roofline/db instead.',
};

const DB_SYSTEM_RESTRICTION = { patterns: [DB_SYSTEM_PATTERN] };

const DB_SYSTEM_ALLOWED = [
  'apps/api/src/auth/**',
  'apps/api/src/hooks/**',
  'apps/api/src/front-desk/relay-server.ts',
  'apps/api/src/front-desk/recording.ts',
  'apps/api/src/jobs/recording-store.ts',
  'apps/api/src/front-desk/text-back.ts',
  'apps/api/src/jobs/scheduler/**',
  // The footprint loader is global work as app_system (E1 Task 6).
  'apps/api/src/estimator/footprints-load.ts',
  // measureProperty reads whether a state's footprints are loaded (global table state, E1 Task 7).
  'apps/api/src/estimator/measure.ts',
  'apps/api/src/account/**',
  'apps/api/src/public/**',
  'apps/api/src/scripts/**',
  'apps/worker/**',
  'packages/db/**',
  '**/test/**',
];

/*
 * One-writer boundary (A1 review): every agent_task_events insert and step snapshot goes through
 * apps/api/src/tasks/service.ts, and only apps/api/src/agents/recount.ts rewrites snapshots or
 * refreshes task minutes. The names below may be imported from @roofline/db (or straight from its
 * source) only in those files. Tests and packages/db are not restricted.
 */
// The raw step finishers and the draft expiry write a step's or task's outcome without its snapshot
// and event, so they too belong to the task service (completeClaimedStep, completeParkedStep, expireOverdueTasks).
// moveStep and updateTask change a step's or task's status, so they pair with an event there as well
// (declineTask, supersedeDraft).
// setStepResult and insertTask write step and task rows, so they belong to the task service too
// (addToLiveTask, createLiveTask).
const EVENT_WRITERS = ['insertAgentEvent', 'setStepSnapshot', 'finishClaimedStep', 'finishParkedStep', 'expireOverdueDrafts', 'moveStep', 'updateTask', 'setStepResult', 'insertTask'];
const RECOUNT_WRITERS = ['rewriteStepSnapshot', 'refreshTaskMinutes'];
// A regex, not a group: the group '@roofline/db' would also match '@roofline/db/system'.
const DB_MODULE_REGEX = '^@roofline/db$|/packages/db/src/(?!system(/|$))';

const writerPattern = (importNames, owner) => ({
  regex: DB_MODULE_REGEX,
  importNames,
  message: `${importNames.join(', ')} may be imported only in ${owner}.`,
});
const EVENTS_PATTERN = writerPattern(EVENT_WRITERS, 'apps/api/src/tasks/service.ts');
const RECOUNT_PATTERN = writerPattern(RECOUNT_WRITERS, 'apps/api/src/agents/recount.ts');

// Each block replaces the rule's options, so every block lists all the patterns that apply to its files.
const restriction = (...patterns) => ({ patterns });

const API_DB_SYSTEM_ALLOWED = DB_SYSTEM_ALLOWED.filter((p) => p.startsWith('apps/api/src/'));
const API_SRC = ['apps/api/src/**/*.ts'];

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

/*
 * Spec 4.7: every word on screen comes from apps/web/src/copy, so JSX holds no text of its own.
 * Text can be written in JSX three ways, and all three are refused:
 * - as JSX text (`<p>Hello</p>`);
 * - as a string in an attribute a person reads (`title="Search"`, `alt`, `placeholder`, the aria text ones);
 * - as a string or template inside braces, as a child (`{"Hello"}`, `{`Hi ${name}`}`) or in one of those
 *   attributes (`title={"Search"}`), also when it is a branch of a ternary or of ||, && or ?? (`{done ? 'Yes' : 'No'}`).
 * Strings in other attributes (className, href, type, role, key) are not text and are left alone.
 */
const NO_TEXT_MESSAGE = 'Put UI text in apps/web/src/copy and pass it in.';
const HAS_LETTER = '/[A-Za-z]/';
const TEXT_ATTRIBUTE = 'JSXAttribute[name.name=/^(aria-label|aria-description|aria-placeholder|aria-roledescription|title|placeholder|alt|label)$/]';

// The braces whose contents are shown: a child of an element or fragment, or the value of a text attribute.
const TEXT_BRACES = [':matches(JSXElement, JSXFragment) > JSXExpressionContainer', `${TEXT_ATTRIBUTE} > JSXExpressionContainer`];

// Where in the braces a string can sit: as the whole expression, or as a branch of a ternary or a
// logical expression, nested up to three deep (`a ? 'x' : b ? 'y' : copy.z`). Only direct branches:
// a string deeper than that (a function's argument, an element's own attribute) is not what is shown.
const TEXT_PLACES = TEXT_BRACES.flatMap((braces) =>
  [0, 1, 2, 3].map((depth) => braces + ' > :matches(ConditionalExpression, LogicalExpression)'.repeat(depth)),
);

const NO_LITERAL_TEXT = [
  { selector: 'JSXText[value=/[A-Za-z]/]', message: NO_TEXT_MESSAGE },
  { selector: `${TEXT_ATTRIBUTE} > Literal[value=${HAS_LETTER}]`, message: NO_TEXT_MESSAGE },
  {
    selector: TEXT_PLACES.flatMap((place) => [
      `${place} > Literal[value=${HAS_LETTER}]`,
      `${place} > TemplateLiteral > TemplateElement[value.raw=${HAS_LETTER}]`,
    ]).join(', '),
    message: NO_TEXT_MESSAGE,
  },
];

// The kit's own Button and IconButton are built on a raw button; nothing else in the web app is.
const NO_RAW_BUTTON = {
  selector: 'JSXOpeningElement[name.name="button"]',
  message: 'Use Button or IconButton from @roofline/ui.',
};

export default defineConfig(
  { ignores: ['v1/**', '**/node_modules/**', '.superpowers/**', 'ops/**', 'apps/web/dist/**', '**/playwright-report/**', '**/test-results/**'] },
  {
    files: ['{apps,packages}/**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    rules: { 'no-restricted-imports': ['error', DB_SYSTEM_RESTRICTION] },
  },
  {
    files: ['**/*.tsx'],
    extends: [reactHooks.configs.flat.recommended],
    rules: { 'jsx-quotes': ['error', 'prefer-double'] },
  },
  {
    // `off` switches the whole rule off here, so any restriction added to it later must be
    // repeated for these places if it should apply to them.
    files: DB_SYSTEM_ALLOWED,
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    ignores: ['apps/api/src/tasks/service.ts', 'apps/api/src/agents/recount.ts', '**/test/**', ...API_DB_SYSTEM_ALLOWED],
    files: API_SRC,
    rules: { 'no-restricted-imports': ['error', restriction(DB_SYSTEM_PATTERN, EVENTS_PATTERN, RECOUNT_PATTERN)] },
  },
  {
    files: ['apps/api/src/tasks/service.ts'],
    rules: { 'no-restricted-imports': ['error', restriction(DB_SYSTEM_PATTERN, RECOUNT_PATTERN)] },
  },
  {
    files: ['apps/api/src/agents/recount.ts'],
    rules: { 'no-restricted-imports': ['error', restriction(DB_SYSTEM_PATTERN, EVENTS_PATTERN)] },
  },
  {
    // These places may import @roofline/db/system, so only the two writer restrictions apply.
    files: API_DB_SYSTEM_ALLOWED,
    ignores: ['**/test/**'],
    rules: { 'no-restricted-imports': ['error', restriction(EVENTS_PATTERN, RECOUNT_PATTERN)] },
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
