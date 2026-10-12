# Task 15 report: Estimator window and the address flow (e1-t15, 721ae6e)

## Built
- A-window: EstimatorWindow.tsx/.module.css (address Field, home matches, proposal groups, Skeleton, error alert, h1 + hint).
- B-make-proposal: MakeProposal.tsx/.module.css (measure, build, send, then /approvals/<taskId>; draw mode goes to the measure window; double-click guard; error alert).
- C-api-tests: api.ts (five hooks; useSendProposal also invalidates approvals), types.ts, estimator.test.tsx (7 tests), e1-routes.test.tsx updated (placeholder row replaced, dock test stubs GET /api/proposals).

## Reviews
- Review 1: 3 findings. F1 rejected, F2 amended, F3 approved/fixed.
- Review 2: 0 findings.

## Minors
- MakeProposal's Estimate Pill renders a focusable button that does nothing (a span would be non-interactive).
- copy comingSoon key is no longer referenced by e1-routes.test.tsx.

## Verify
web vitest 58 files / 597 tests passed; typecheck, lint, lint:css, build:web all exit 0. CI ci-check run 38205018808 PASSED.
