# E1 Task 14: Web skeleton

Commit 20e2a6b on e1-t14 (base 278a478). CI run 38197723747: PASSED.

## Built
- P1-routes: router.tsx (three estimator routes in the shell; public /p/:token in the open group outside RequireSession and Shell), shell/apps.ts (estimator shipped), copy/legal.ts (footprintAttribution).
- P2-placeholders: Estimator, Measure, Proposal windows and HomeownerPage placeholders with api.ts files and copy files; TiersSection, FinancingSection, EstimateSection slots rendered after C1's EmptyState in PricesTab.
- P3-test: apps/web/test/e1-routes.test.tsx.

## Review rounds
- Review 1: verify passed, 0 findings.

## Minors
- P2 did not write the tests first; P3 added them afterwards.
- No fixes were needed at finalize.

## Verify tail
web vitest: 44 files, 435 tests passed. typecheck, lint, lint:css and build:web all exit 0 (build only warns about chunk size).
