# F2 Task 15: Today window

Commit 552d4c5 on f2-t15. CI run 38181682763: PASSED.

## Built
- P1-hooks-wiring: features/today/api.ts (useTodayShown), useTodayAutoOpen.ts, one-line Shell.tsx call, router.tsx, SHELL_ROUTES entry for POST /api/me/today-shown.
- P2-today-window: Today.tsx, Today.module.css, copy/today.ts (greeting, date, top-3 drafts, see all, empty appointments).
- P3-tests: apps/web/test/today.test.tsx (3 window cases, 4 auto-open cases).

## Reviews
- Round 1: verify passed, 0 findings.

## Minors
- Approvals request failure with no data shows errors.generic (not specified in brief).
- Negative auto-open tests use a 100 ms real-time settle (timing heuristic).
- Builder 2 wrote no tests per file ownership.

## Verify tail
web vitest: 28 files, 315 tests passed; typecheck, lint, lint:css clean.
