# Task 2 report: Web app scaffold, lint boundaries and copy rules

Status: DONE_WITH_CONCERNS (concerns are judgement calls and observations, listed below; nothing blocks Task 3).
Commit: `3d33a7c feat(web): app scaffold, copy rules, status labels and lint boundaries` on `f2-shell` (24 files, package-lock.json included).

## What was implemented

- **`apps/web` (`@roofline/web`)**
  - Vite 8.3.4 + React 19.3 SPA. `vite` is `^8.3.0` and `@vitejs/plugin-react` is `^6.1.2` (its peer is `vite ^8`, and vitest 5 allows 8).
  - Depends on `@roofline/ui` and `@roofline/shared` at `^0.0.0`. Dev deps mirror `packages/ui` (jsdom, jest-dom, @types/react*).
  - `vite.config.ts`: React plugin; `server` is `127.0.0.1:4401`, `strictPort`, proxying `/api`, `/hooks`, `/health` to `127.0.0.1:4400`; `build.outDir: 'dist'`.
  - `vitest.config.ts`: jsdom, `include: ['test/**/*.test.{ts,tsx}']` (never `e2e/`), `setupFiles: ['test/setup.ts']`.
  - `tsconfig.json` mirrors the ui one. `.env.development` is `VITE_MAP_TILES=osm`. It is committed, and `.gitignore` does not exclude it (the `.env` rule matches only a file named exactly `.env`).
  - `main.tsx` imports `@roofline/ui/tokens.css`, then `base.css`, and renders `<StrictMode><p>{common.appName}</p></StrictMode>`.
- **Copy files** (`src/copy/`), each a named `as const` object:
  - `common`: appName, networkError, close.
  - `auth`: sign-in strings.
  - `connections`, `billing`, `setup`: one `later` string each.
  - `legal`: `mapAttribution` ('© OpenStreetMap contributors'), terms, privacy.
  - `status.ts`: `TASK_STATUS_LABEL`, `STEP_STATUS_LABEL`, `AGENT_LABEL`, `stepStatusLabel`, `taskStatusLabel`, with the exact labels and signature from the brief.
  - For `partly_done`, N is the sum of numeric positive `failed` and `blocked` over the steps. Nested records, missing keys and non-numbers are ignored. When N is 0 it is the count of steps in `failed`/`needs_attention`. `Mostly done — N couldn't send`, or `Mostly done` when N is 0.
- **`eslint.config.js`**
  - Files pattern widened to `{apps,packages}/**/*.{ts,tsx}`. `eslint-plugin-react-hooks@^7.1.1` is added (root devDependency) via `reactHooks.configs.flat.recommended`, scoped to `**/*.tsx`.
  - Web/kit import boundary for `apps/web/src/**` and `packages/ui/src/**`, with patterns for `@roofline/db`, `send-gate` and `api` (plus relative back doors). It holds both the db/system and the web pattern sets. The block sits after the allow-list block, so `**/test/**` cannot switch it off for a folder named test under `src`.
  - `no-restricted-syntax` literal-text selectors for web and kit `.tsx`, verbatim from the brief. A second, later block for `apps/web/src/**/*.tsx` repeats them and adds the raw-`<button>` selector (flat config replaces options, so the web block carries all three).
  - Ignores added: `apps/web/dist/**`, `**/playwright-report/**`.
- **Root:** scripts `dev:api`, `dev:web`, `build:web`; `tsconfig.json` references `apps/web`; `.gitignore` gets the four web paths.

## Tests

- New (3 files, 25 tests): `copy-rules.test.ts` (5), `status-labels.test.ts` (9), `lint-rules.test.ts` (11).
- The copy-rules tests include a guard that the file list holds all 7 copy files, and a test of the scanner itself on an inline source (plain, template-with-holes, import/export/type skipped).
- `lint-rules.test.ts` covers more than the brief's six cases:
  - the kit may use a raw button;
  - an `alt` and an `aria-label` literal are refused;
  - `@roofline/send-gate` and `@roofline/api` are refused;
  - the relative back doors are refused;
  - the db/system boundary still holds, and still allows `apps/api/src/auth`;
  - the web boundary survives a `src/test/` folder;
  - ui/shared/npm imports are allowed.
- Results:
  - `npx vitest run --project @roofline/web`: 3 files, 25 tests passed.
  - `npm run lint`: clean.
  - `npm run lint:css`: clean.
  - `npm run typecheck`: clean.
  - `npm run build:web`: OK, `apps/web/dist/index.html` exists (17 modules, JS 219.68 kB).
  - Full `npx vitest run` before commit: 45 files, 2084 tests, all passed (378 s). The known `rep-visibility` flake did not appear.
- Dev server check: `vite` starts on `http://127.0.0.1:4401/`, serves `/src/main.tsx` (with the ui CSS imports resolved), and `/health` returns 502 with no API running, so the proxy is wired.

## TDD evidence

- RED: scaffold (package.json, vitest config, setup) in place, tests written, no copy files, original ESLint config. Command: `npx vitest run --project @roofline/web`. Result: `Test Files 3 failed (3)  Tests 11 failed | 5 passed (16)`.
  - `status-labels.test.ts`: `Failed to resolve import "../src/copy/status.ts" ... Does the file exist?`
  - `copy-rules.test.ts`: only the guard `finds strings in every copy file` failed (`expected [] to deeply equal ArrayContaining{…}`). The other three pass vacuously with no files, which is exactly what that guard exists for.
  - `lint-rules.test.ts`: 10 of 11 failed, `.tsx` cases with `File ignored because no matching configuration was supplied.` (original config lints only `.ts`), import-boundary cases with `expected '' to contain '@roofline/ui, @roofline/shared'`.
  - Output saved at the scratchpad `red.txt`.
- GREEN: after the copy files, status map and ESLint config: `Test Files 3 passed (3)  Tests 25 passed (25)`.
- Mutation check: temporarily adding `Sign in with Google and Meta: needs_attention, API, null, ${1} env` to `common.ts` made `uses no technical words`, `uses no enum tokens` and `names vendors only where ...` fail with each offender listed. It was reverted.

## Files changed

- Created: `apps/web/{package.json, index.html, vite.config.ts, vitest.config.ts, tsconfig.json, .env.development}`, `apps/web/src/{main.tsx, vite-env.d.ts}`, `apps/web/src/copy/{common,status,auth,connections,setup,billing,legal}.ts`, `apps/web/test/{setup.ts, copy-rules.test.ts, status-labels.test.ts, lint-rules.test.ts}`.
- Modified: `eslint.config.js`, `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`.

## Self-review findings

- Fixed during review:
  - A type error in `copy-rules.test.ts`: `Object.values(shared)` is now `Object.values<unknown>(shared)`.
  - `taskStatusLabel` uses a type guard (`hasFixedLabel`) instead of a cast.
  - Long lines in `lint-rules.test.ts` were tidied with `importing()`/`component()` helpers.
- `apps/web/node_modules` (npm nested `@vitejs/plugin-react` there) is marked with `xattr com.apple.fileprovider.ignore#P`. It is git-ignored.
- No `.env` files created; `.env.development` has only `VITE_MAP_TILES=osm`.

## Concerns / decisions to know about

1. **The copy scanner skips strings that are code, not words.** The brief says to collect every `StringLiteral`. I skip import/export module specifiers and anything inside a type node (`ts.isTypeNode`), because the specified signature `Record<Exclude<TaskStatus,'partly_done'>, string>` contains the literal `'partly_done'`, a banned enum token, and `@roofline/shared` is an import path. Every string in an expression is still scanned.
2. **No snake_case literal in `status.ts` expressions.** To pass the same test, the code checks `Object.hasOwn(TASK_STATUS_LABEL, status)` rather than `=== 'partly_done'`. The "did not finish" statuses come from a `Record<StepStatus, boolean>` keyed by identifiers, which also makes TypeScript force a decision when a status is added.
3. **The two JSX text selectors are the brief's and have gaps.** `<p>{'Hello'}</p>`, `title={'x'}` and template literals in JSX are not caught. Closing them would need a third selector (`JSXExpressionContainer > Literal`). Not added, to keep the brief's exact selectors; say if you want it.
4. **React-hooks plugin:** v7's `recommended` includes the React Compiler rules (`purity`, `refs`, `set-state-in-effect`, ...), stricter than the old two-rule set. Nothing in Task 2 trips them. It may bite in later tasks.
5. **Port 4401 is already held on this machine** by an unrelated `node server.js` (PID 5837) listening on the IPv6 wildcard `*:4401`. Vite's `127.0.0.1:4401` bind still succeeded, but a browser on `http://localhost:4401` could reach the other process. Use `127.0.0.1` explicitly (the config and `APP_ORIGIN` already do).
6. **Import order in `main.tsx`:** tokens first, then base, the reverse of the brief's wording, because `base.css` says "Import after tokens.css".
7. The back-door pattern `**/api/src/**` is intentionally loose, so it also catches `../../../api/src/...` from the web app. It would also refuse a web feature folder literally named `api/src`.
8. `npm install` reported 9 audit vulnerabilities in the existing dependency tree. Not touched.

---

# Fix round 1: the no-literal-text lint (review finding, controller Ruling E)

Commit: `fix(web): the no-literal-text lint catches strings in JSX expressions` (on top of 3d33a7c; short SHA in the git log).

## The finding

The reviewer ran `npx eslint --stdin` against `apps/web/src/features/x/Fake.tsx`. None of these gave an error: `<p>{"Hello there"}</p>`, ``<p>{`Hello ${n}`}</p>``, `<input title={"Search"} />`, `<div aria-description="Opens the menu" />`. Cause: the two plan selectors look only at `JSXText` and at an attribute's direct `Literal`, so anything inside `{...}` and any attribute outside the list got through. (This was my concern 2 in the first report.)

## What changed (`eslint.config.js` only, plus tests)

- **Same message** (`Put UI text in apps/web/src/copy and pass it in.`), same scope (`apps/web/src/**/*.tsx` and `packages/ui/src/**/*.tsx`). The raw-button rule is unchanged.
- **Text attributes** are now `aria-label|aria-description|aria-placeholder|aria-roledescription|title|placeholder|alt|label`. The direct-literal selector uses that list.
- **New selectors**, built from two parts so the list stays readable:
  - *Braces that are shown:* `:matches(JSXElement, JSXFragment) > JSXExpressionContainer` (a child) and `<text attribute> > JSXExpressionContainer`.
  - *Places in the braces:* the expression itself, or a direct branch of a `ConditionalExpression` / `LogicalExpression`, nested up to three deep (`a ? 'x' : b ? 'y' : copy.z`). At each place the rule matches `Literal[value=/[A-Za-z]/]` and `TemplateLiteral > TemplateElement[value.raw=/[A-Za-z]/]`. They are joined into one comma-separated selector.
  - **Not flagged on purpose:** `className`, `key`, `href`, `type`, `role`, `data-*` or any other attribute; a string deeper than a direct branch (a function's argument, e.g. `{t('x')}`); and the attributes of an element nested inside braces (`{items.map((i) => <li className={...}>)}`). The last one is safe because the nested element's attributes are not in the chain from the outer container, and its own children are checked on their own.
  - Only direct children of JSX are in the chain; descendant combinators are deliberately not used, since they would flag a nested element's `className`.
- **Existing src** still lints clean (`npm run lint`).

## Tests (`apps/web/test/lint-rules.test.ts`, now 16 tests, was 11)

New cases:
- Other text attributes: `aria-description`, `aria-placeholder`, `aria-roledescription`, `title`, `label`.
- Strings and templates as a child, in web and kit files, in an element and a fragment: `{"Hello there"}`, `{'Hello there'}`, `<>{"Hello there"}</>`, ``{`Hello there`}``, ``{`Hello ${who}`}``, ``{`${who} is here`}``.
- Ternary and logical branches: `done ? 'Yes' : 'No'`, `done ? copy.x : 'No'`, `who || 'Nobody'`, `who ?? 'Nobody'`, `done && 'Yes'`, a template branch, and a nested ternary.
- The same forms in text attributes inside braces: `title={"Search"}`, `placeholder={'Search'}`, ``alt={`A roof`}``, ``aria-label={`Close ${who}`}``, a ternary in `aria-label`, `||` in `aria-description`.
- Allowed (no message at all): `<p className={"x"}>{copy.x}</p>`, `<a href={"/jobs"}>{copy.x}</a>`, `className={done ? 'a' : 'b'} role={'note'}`, `{' '}`, `{'/'}`, `{2}`, `{done ? copy.x : null}`, ternary/`||` that use only `copy`, and a `.map` whose `<li>` has `key`, `className={done ? "a" : "b"}` and `data-x={"y"}`.
- The test helper `component()` now declares `copy`, `done`, `who`, `items` and reads them once (`export const used = [...]`) so unused declarations do not add noise to the assertions.

## RED / GREEN

- RED (new tests, old selectors): `npx vitest run --project @roofline/web test/lint-rules.test.ts` gave `Tests 4 failed | 12 passed (16)`. The four failures were the new "refuses" groups (`expected '' to contain 'apps/web/src/copy'`). The "allows" tests passed both before and after, as they should.
- GREEN (new selectors): `npx vitest run --project @roofline/web && npm run lint && npm run lint:css && npm run typecheck && npm run build:web`:
  - `Test Files 3 passed (3)  Tests 30 passed (30)`;
  - lint, lint:css and typecheck clean;
  - `vite build` OK (17 modules, `apps/web/dist/index.html` exists).
- The reviewer's reproduction, `npx eslint --stdin --stdin-filename apps/web/src/features/x/Fake.tsx`: each of the four bypass cases now gives `error  Put UI text in apps/web/src/copy and pass it in  no-restricted-syntax` (1 problem each). `<p className={"x"}>{1}</p>` gives no output.
- The full suite was not re-run: only `eslint.config.js` and one web test file changed, and the covering web project, lint and typecheck were green.

## Remaining limits (unchanged by design)

- A string passed to a helper in braces (`{label('Hello')}`) or kept in a variable (`const t = 'Hello'; <p>{t}</p>`) is not caught; the lint is a net for the common slips, and the copy-rules test and review cover the rest.
