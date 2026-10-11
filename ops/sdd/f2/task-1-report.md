# Task 1 report: Design kit package, tokens and the 12px font rule

**Status:** DONE_WITH_CONCERNS (concerns are notes for the controller, none block the task)
**Commit:** `f30026c feat(ui): S1 tokens, base styles and the 12px font rule` on `f2-shell`

## What I implemented

- **`packages/ui` workspace** (`@roofline/ui`): `type: module`, exports `.` -> `src/index.ts`, `./tokens.css`, `./base.css`. Peer deps `react@^19`, `react-dom@^19`; dev deps `react`, `react-dom`, `@types/react`, `@types/react-dom`, `jsdom`, `@testing-library/jest-dom`.
- **`tsconfig.json`**: extends the base, `composite`, `rootDir: "."`, `jsx: react-jsx`, `lib` ES2023 + DOM + DOM.Iterable, `types: ["node"]`. `include` is `src`, `test`, `stylelint`, `*.ts` (the last so `vitest.config.ts` is type-checked, as `apps/api` does).
- **`vitest.config.ts`**: `defineProject`, `environment: 'jsdom'`, `setupFiles: ['test/setup.ts']`, `css.modules.classNameStrategy: 'non-scoped'`. `test/setup.ts` imports `@testing-library/jest-dom/vitest`. The two test files carry `// @vitest-environment node` (they read files and run stylelint, no DOM needed).
- **`src/tokens.css`**: every token in the Global Constraints, verbatim: the 12 spec rows, `--text-muted: rgba(43, 38, 32, 0.72)`, `--font`, three font sizes, hail 1-5, `--pin-customer`, four `--stage-*`. 27 tokens.
- **`src/tokens.ts`**: `export const tokens = {...} as const` keyed without `--` (literal values), plus `export type TokenName = keyof typeof tokens`. `src/index.ts` re-exports both.
- **`src/base.css`**: border-box, `body` (margin 0, `--bg`, `--text`, `font: 400 var(--font-size-body)/1.45 var(--font)`), global `:focus-visible` ring (`2px solid var(--text)`, offset 2px), `.visually-hidden` (clip pattern), and a `prefers-reduced-motion: reduce` block that sets `transition: none` and `animation: none` (see concerns).
- **`src/css-modules.d.ts`**: `declare module '*.module.css'`.
- **`stylelint/min-font-size.js`** (+ `.d.ts` so the TS test can import it): `createPlugin` + `postcss-value-parser`. Rule name `roofline/min-font-size`.
  - Checks `font-size` and the size token of the `font` shorthand (token before `/` when present, otherwise the first size-like token; `var(--font)` family is ignored).
  - px >= 12 passes; rem converted x16; `var(--font-size-*)` passes (and its fallback is checked, so `var(--font-size-body, 11px)` fails).
  - Too small: message contains `at least 12px`. Everything else (%, em, keywords, calc/clamp/min/max, any other `var()`, `inherit`): message contains `Use px, rem or a var(--font-size-*) token`.
  - One warning per declaration, positioned on the offending token.
- **`stylelint.config.js`** (root): loads the plugin, enables the rule, and scopes it to `packages/ui/src/**/*.css` and `apps/web/src/**/*.css`. See concerns (stylelint has no top-level `files`).
- **Root changes**: `lint:css` script (exactly as the brief), `stylelint` and `postcss-value-parser` as root devDependencies, `packages/ui` added to the root `tsconfig.json` references, `npm run lint:css` step added after `npm run lint` in `.github/workflows/ci.yml`. `package-lock.json` committed and `npm ci --dry-run` is clean.

## Tests and results

- `npx vitest run --project @roofline/ui`: 2 files, 19 tests, all pass.
  - `tokens.test.ts`: `has every S1 token with its exact value` (27 name/value pairs) and `tokens.ts mirrors tokens.css` (key count equals CSS count and every value equal).
  - `min-font-size.test.ts`: the brief's 7 bad and 5 good cases, plus extras: other `var()` rejected, fallback checked, `font` shorthand cases (italic/weight before size, no-slash form, `font: inherit` passes, small size, non-token var size), custom properties holding sizes are ignored, uppercase + `!important`.
- `npm run lint:css`: exit 0. `npm run lint`: exit 0. `npm run typecheck` (`tsc -b`): exit 0.
- Scope check of the config: a temporary 11px rule in `apps/web/src/*.css` and `packages/ui/src/*.module.css` was reported with `npm run lint:css`; the same rule in `packages/db/*.css` was ignored. Temp files removed.
- **Full suite** (`npx vitest run`, 385s): 41 of 42 files passed, 2054 of 2055 tests. One failure, `apps/api/test/rep-visibility.test.ts > ... value shows on a rep's own jobs ...`, is a pre-existing flake unrelated to this task: line 400 asserts `JSON.stringify(body)` does not contain `'333'`, and the random `propertyId` UUID in that run (`...a82b-8333e822b7dd`) contains `333`. Re-ran the file alone: 32 of 32 pass.

## TDD evidence

- **RED**: `npx vitest run --project @roofline/ui` (tests written first, no `src/` or `stylelint/` implementation):
  ```
  FAIL |@roofline/ui| test/min-font-size.test.ts
  Error: Cannot find module '../stylelint/min-font-size.js' imported from .../packages/ui/test/min-font-size.test.ts
  FAIL |@roofline/ui| test/tokens.test.ts
  Error: Cannot find module '../src/tokens.ts' imported from .../packages/ui/test/tokens.test.ts
  Test Files  2 failed (2)   Tests  no tests
  ```
  Expected: the modules under test did not exist yet.
- **GREEN**: same command after implementing:
  ```
  Test Files  2 passed (2)
        Tests  19 passed (19)
  ```

## Files changed

Created: `packages/ui/package.json`, `packages/ui/tsconfig.json`, `packages/ui/vitest.config.ts`, `packages/ui/test/setup.ts`, `packages/ui/test/tokens.test.ts`, `packages/ui/test/min-font-size.test.ts`, `packages/ui/src/{tokens.css,base.css,tokens.ts,index.ts,css-modules.d.ts}`, `packages/ui/stylelint/min-font-size.js`, `packages/ui/stylelint/min-font-size.d.ts`, `stylelint.config.js`.
Modified: `package.json`, `package-lock.json`, `tsconfig.json`, `.github/workflows/ci.yml`.

## Self-review findings

- Diff matches the brief's file list plus one extra file (`min-font-size.d.ts`), which `tsc -b` needs because the test imports a `.js` module under `strict`.
- No `.env` files, no nested `packages/ui/node_modules` (everything hoisted to the root, which already carries the iCloud ignore xattr), no secrets. `.superpowers/` is gitignored, so this report is not committed.
- Plugin edge cases probed by hand: `font-size: 0` (reported as too small), `12PX` (passes), comments inside the value, `clamp()`, `oblique 10deg` in the shorthand (angle not mistaken for a size), `font: 600 var(--w) 14px/1 serif` (passes, size is the 14px token).
- Known limit, documented in the plugin header: in the `font` shorthand without a `/`, a bare non-token `var()` cannot be told from a weight or family, so it is not read as the size.

## Concerns / notes for the controller

1. **Stylelint has no top-level `files` key.** `files` only exists inside `overrides`, and an overrides-only config fails with "No rules found". So `stylelint.config.js` sets the plugin and rule at the top level and expresses the scope as `ignoreFiles: ['**/*.css', '!packages/ui/src/**/*.css', '!apps/web/src/**/*.css']`. Verified in/out of scope as described above. The `lint:css` script globs are exactly the brief's.
2. **`font-size: inherit` (and `initial`, `unset`) is reported** with the "Use px, rem or a var(--font-size-*) token" message, following the brief's "anything else is reported". `font: inherit` passes (no size token to check). If later components want `font-size: inherit`, the plugin needs a one-line allowance; I did not add it unasked.
3. **Reduced motion also turns off `animation`**, not only transitions (WCAG 2.3.3 superset). Trim `animation: none !important` from `base.css` if you want transitions only.
4. **Pre-existing flake** in `apps/api/test/rep-visibility.test.ts` line 400 (random UUID containing `333`), see above. Worth a follow-up to assert on a field value rather than a substring of the whole body.
5. Did not install `@testing-library/react`; the later component tasks will need it (and its `@testing-library/dom` peer).
6. `tokens.test.ts` does not assert an exact token count (only mirror consistency), so later tasks can add tokens without editing the count.

---

# Fix round 1 (controller review of f30026c)

**Commit:** see the reply (`fix(ui): the 12px rule checks --font-size-* definitions; allow CSS-wide keywords`)

## What changed

- **Important finding fixed: the `var(--font-size-*)` pass was bypassable.** `firstArgIsSizeToken` passes on the name alone and custom-property declarations were never walked, so `a{--font-size-tiny:8px;font-size:var(--font-size-tiny)}` and `.x{--font-size-body:8px;font-size:var(--font-size-body)}` gave 0 warnings.
  - `walkDecls` now matches `/^(font(-size)?|--font-size-.*)$/i`, so every `--font-size-*` definition is checked with the same `check()` (px >= 12, rem x16, other units, keywords, calc and other var() reported; `var(--font-size-x)` as the value passes, so tokens may alias each other).
  - `sizeNode` takes the first value token for anything that is not the `font` shorthand.
  - Custom properties that are not `--font-size-*` (e.g. `--tiny:8px`, `--font-size:8px`) are still left alone; using one as `font-size: var(--tiny)` is already reported by the var() rule.
  - `tokens.css` still lints clean (`--font-size-min` 12px, `--font-size-body` 14px, `--font-size-stat` 24px).
- **Ruling D applied:** `inherit`, `initial`, `unset`, `revert` (case-insensitive) pass in `font-size` and in `--font-size-*` definitions. `revert-layer` is not in the ruling and is still reported. The plugin header comment documents both changes.
- **Tests (`min-font-size.test.ts`)**: added `a{font-size:inherit}` and `a{font-size:unset}` to the good list; a test for all four keywords plus `INHERIT`; replaced the old "ignores custom properties that merely hold a size" test with one that checks definitions (`:root{--font-size-tiny:11px}` -> 1 warning with `at least 12px`; `:root{--font-size-body:14px}` -> 0; `0.75rem` and an alias to another token -> 0; the shadowed `.x{--font-size-body:8px;font-size:var(--font-size-body)}` -> 1 warning; `--font-size-big:120%` -> 1 warning with the "Use px, rem..." message), and a test that non-`--font-size-*` custom properties are untouched.

## TDD evidence

- **RED** (new tests first, rule unchanged): `npx vitest run --project @roofline/ui`
  ```
  × accepts a{font-size:inherit}
  × accepts a{font-size:unset}
  × accepts every CSS-wide keyword ... (inherit: expected [ Array(1) ] to deeply equal [])
  × checks the definition of every --font-size-* token ... (expected [] to have a length of 1 but got +0)
  Test Files  1 failed | 1 passed (2)   Tests  4 failed | 19 passed (23)
  ```
  Expected: `inherit`/`unset` were still reported and definitions were not walked.
- **GREEN**: same command after the change:
  ```
  Test Files  2 passed (2)
        Tests  23 passed (23)
  ```

## Verification run

- `npx vitest run --project @roofline/ui`: 2 files, 23 tests pass.
- `npm run lint:css`: exit 0 (tokens.css and base.css clean).
- `npm run lint`: exit 0. `npm run typecheck`: exit 0.
- Through the real config, a temporary `packages/ui/src/zz-bypass.css` holding both bypasses the reviewer named reported two errors (`Font size "8px" is too small. Use at least 12px.`) with exit 2; file removed.
- Full suite not re-run (the change touches only the stylelint plugin and its test; the covering commands above were requested).
