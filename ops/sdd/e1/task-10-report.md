# E1 Task 10 report: exact report flow and aerial measure

Branch e1-t10, base 7d903e5. Commits 9d5e014 (feature) and 5236e8a (test fix).

## Built
- A-order-flow: db repo exact-reports.ts, app_system fan-out (exact-report-fanout.ts), requestExactReport and the orderExactReport handler (estimator/exact-report.ts), handler registered in tasks/handlers.ts. Order row claimed priced->ordering in its own tx before order(); uncertain or any order() error -> attention with plain message, never retried; price above approved max refused.
- B-poll-complete: completeExactReport (exact measurement, usage once per report, activity, order complete, parked step done, re-price of draft/sent/viewed proposals; signed ones get a revised draft per Ruling EJ) and the exact-report-poll scheduler job (10-minute gap, failed -> attention with our own sentence, unreadable cost bills priced max).
- C-aerial-routes: estimator/aerial.ts (3 s poll, 60 s budget, 503 fallback), POST /:id/aerial and /:id/exact-report in routes/measurements.ts, tests.

## Review rounds
- Review 1: 0 findings.

## CI round 1 (run 38219289667, Platform failed, E2E passed): 9 test failures, all in tests
- exact-report-poll.test.ts: the order is stamped last_polled_at when placed (at NOW), so polling at NOW is inside the 10-minute gap and finds nothing. Fixed: tests poll at LATER (NOW + 11 min); the gap test rewritten.
- aerial.test.ts:70: MeasurementView recomputes its estimate from outline and pitch, so the view cannot show the aerial area. Fixed: assert pitchX12 on the view and the stored surfaceSqFt (2480) on the row.

## Minors
- Product code stored as string, converted on order(); address parsed back from the step payload; parked-step result is {} (StepResult numbers only).
- FakeExactReports.report return type has costCents: number, so the null-cost test wraps it; widening is a possible follow-up.
- 'ready' proposals are not re-priced in place (reprice would make a revised draft).
- Aerial view shows the recomputed estimate, not the aerial area; the stored column holds the aerial area.

## Verify
- typecheck, lint, vitest @roofline/shared (462 passed): pass.
- ci-check run 38220889556 for e1-t10@5236e8a: PASSED (Platform and E2E).
