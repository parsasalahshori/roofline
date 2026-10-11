
# Task 101 (P1 polish, Ruling O) report

Commit 3cad3b2 on f2-p1. CI run 38179389431 PASSED (platform job).

## Built
- Package A (Shell.tsx, hooks.ts, company-switch.test.tsx, lazy-map.test.tsx): MapView via React.lazy + Suspense at the import site only; useSwitchCompany now uses resetQueries on non-me queries; two new test files.
- Package B (api/types.ts, shell/map/types.ts, pins.ts, MapView.tsx, StormWindow.tsx, storm-window.test.tsx): Bbox moved to api/types (re-exported from map/types); StormWindow renders the summary only when present.
- Package C (auth.test.tsx, eslint.config.js, lint-rules.test.ts, SearchDialog/UserMenu/searchIcon, search-dialog.test.tsx): jsx-quotes prefer-double plus lint test and quote normalisation; auth.test now uses helpers.tsx, with the vitest.config.ts timeout as the only source.

## Reviews
- Round 1: verify failed, 1 finding. resetQueries (A) conflicted with the auth test's isInvalidated assertion. Fixed by changing that assertion to expect getQueryData(keys.approvals) toBeUndefined(), the same behaviour the company-switch test proves.
- Contact check 1: F1 approved.
- Round 2: verify passed, 0 findings.

## Minors
- search-dialog.test.tsx was touched for one quote fix flagged by the new lint rule.
- build:web warns the lazy MapView chunk is 1,039 kB (277 kB gzip); the main index chunk is now 390 kB (was ~1.4 MB combined).

## Verify tail
Web vitest 21 files / 210 tests passed; typecheck, lint, lint:css clean; build:web OK (index 389.71 kB, MapView 1,039.12 kB).
