
## Task 6 report: C1 jobs: stage rules, next step, board and job view

Built:
- pkg1-db-repos (packages/db/src/repos/jobs.ts, board.ts, index.ts): nextStep/nextStepOn persisted and audited, stage rules (StageRuleError, now also exported from the db index), job.next_step activity, board filters/totals/cards, jobViewFor.
- pkg2-api-route (apps/api/src/routes/jobs.ts): next step fields, StageRuleError mapping, GET /board, GET /:id/view. jobBody also returns nextStep and nextStepOn (extra).
- pkg3-api-tests: jobs-board, jobs-stage-rules, job-view tests (not run: no Docker; CI is down).

Review round 1: verify passed, 0 findings.

Minors: memberNames does not filter by member status (deactivated names still show); totalCents coalesced to 0; showcase jobs all go to rep2; do not run prettier --write.

Verify: `slot npm run typecheck && slot npm run lint` both passed with no output errors (tsc -b, eslint .).
