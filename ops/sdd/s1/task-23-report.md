# Task 23 report: Web storm window and storm detail

## Built
- A-storm-window: StormWindow list (newest first, dismissed hidden, stale banner, empty state, View and See plan links), CSS, storm-list tests. test/helpers.tsx and s1-routes.test.tsx updated so the F2 StormWindow test keeps its stubs (GET /api/storms, storm-layer).
- B-storm-detail: StormDetail, StormSwathMap (hail token colours, legend), dismiss confirm (alertdialog), redraft; owner/office only.
- C-api-results: five real hooks in features/storm/api.ts (useStorm polls every 60 s only while plan running), StormResults with StatCard, types.ts, copy keys in copy/storm.ts.

## Review rounds
- Review 1: verify failed, 4 findings. Contact check: F1 approve, F2 amend, F3 reject, F4 amend. Outcomes applied before this finalize.
- Review 2: verify passed, 0 findings.

## Minors
- Button has no secondary variant; ghost used.
- Money formatted with Intl.NumberFormat en-US USD (no shared formatter).

## Verify tail
typecheck, lint, lint:css clean; vitest @roofline/web: 50 files, 479 tests passed.
