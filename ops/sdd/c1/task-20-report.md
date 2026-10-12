# Task 20: C1 Web: job window (branch c1-t20, commit 15c9669)

Built: P1 (JobWindow, JobHeader, StageStepper, EditJobSheet + CSS), P2 (JobSections), P3 (job api hooks with no retry on 404, job-window.test.tsx with 7 tests). Also touched copy/job.ts and the c1-routes, create-job and shell tests (review fixes).

Review 1: verify failed, 4 findings; contact check F1/F2/F4 amend, F3 approve; all addressed. Review 2: verify passed, 0 findings.
Minors: next-step date formatted as UTC calendar date; Button has no secondary variant (primary/ghost used); Lost chip is a span; useCreateQuote body {} (T15 measurement unverified).

Verify: web vitest 51 files / 518 tests passed; typecheck, lint, lint:css, build:web passed. CI: run 38205896069 PASSED.
