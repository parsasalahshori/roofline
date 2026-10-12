# E1 Task 20 report

Branch e1-t20, commit acd124d. CI run 38220847476: Platform and E2E passed.

## Built
- A-job-proposals: Proposals section on the job window (New proposal, skeleton, error, empty state, list with "Estimate from $X" / "From $X"); useJobProposals filters client-side by jobId (first page only; a server-side jobId filter would fix that).
- B-review-previews: 5 tests for review previews (send_proposal, order_exact_report, payload-shape independence). No source changes needed.
- C-today-signed: "Signed today" section on Today via GET /api/proposals?status=signed&signedOn=<date>.
- Lead: added signedTodayRoute helper in test/helpers.tsx and stubbed proposals reads in job-window, today and today-crm tests.

## Reviews
- Review 1: 3 findings; contact check F1 amend, F2 amend, F3 approve. Outcome: addressed.
- Review 2: 0 findings.

## Minors
- Today copy `signedBy` unused.
- Job proposals list pulls only the first page.

## Verify tail
web vitest 75 files / 727 tests passed; typecheck, lint, lint:css, build:web clean.
