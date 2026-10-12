
# Task 28: C1 end-to-end tests, acceptance map and docs

Branch c1-t28, commits 2484416 (task) and 9dc2423 (CI fixes). CI run 38221120268 PASSED (Platform and E2E).

## Built
- P1-crm-e2e: apps/web/e2e/crm.spec.ts (6 tests: board, drag, new job, timeline, quote, rep visibility).
- P2-calendar-e2e: calendar.spec.ts, phone.spec.ts and a11y.spec.ts additions; FakeCalendarApi self-callback auth URL (on only in createCalendarApis fake branch); calendar-fake test.
- P3-docs: docs/superpowers/c1-acceptance.md (spec section 14 map, gaps) and README "Calendar connections".

## Review rounds
- Review 1: 4 findings. F1 amended, F2 approved, F3 approved, F4 amended (fixes in providers.tsx and providers-download test).
- Review 2: 0 findings.

## CI round 1 (run 38219011301): 3 e2e failures, all real product bugs, fixed in 9dc2423
- Quote creation: web posted `{}` but POST /api/jobs/:id/quotes requires a measurement (400). Fixed in features/job/api.ts: sends v1 default roof from defaultScope.
- Timeline did not show "Moved to Inspection" while the job window stayed open: useMoveJob now invalidates ['timeline'].
- a11y calendar week: scrollable-region-focusable on the time grid. TimeGrid scroll div is now role=region, labelled (copy/calendar.ts gridLabel), tabIndex 0.

## Minors
- crm.spec.ts runs in the desktop project only (phone testMatch is /phone\.spec/).
- c1-manual-smoke.md link dangles until Task 29.
- Fixes touched files outside the brief (web src) because the e2e exposed the bugs.

## Verify tail
typecheck, lint clean; playwright --list: 43 tests in 11 files; focused vitest (calendar, job-window, copy, job, quote, jobs) pass; CI run 38221120268 PASSED.
