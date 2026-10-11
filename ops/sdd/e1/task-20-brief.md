### Task 20: Web: job window proposals, R2 previews, Today and Estimator badges

**Base:** `e1-estimator` after Task 14 is merged. **[C1]** From C1 T20: `features/job/JobSections.tsx` (add a Proposals section). **[C1]** From C1 T27: `features/today/{Today.tsx,api.ts}` (`useToday`). Real (F2): R2 review renders `preview()` from shared steps (`features/approvals/toReviewStep.ts`).

Read first: `ops/sdd/e1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-estimator-design.md`. Names marked **[C1]** come from the C1 plan/briefs (`ops/sdd/c1/`), not from built code: check each against `c1-crm` before starting and report any difference.

**Split:** Builder 1 the job window's Proposals section (C1 `JobSections.tsx`: status chips, "New proposal" → measure for the job's home); Builder 2 R2 review rendering for the two new step types (previews already flow from the shared `preview()`; add any copy keys and the "Estimate"/"Exact measurements" line); Builder 3 Today ("Signed today" list) and tests.

**Tests:**
- proposals listed in the job window; review shows "Text the proposal to Maria" with the totals and max spend for the exact report; Today lists signed proposals.

**Carries and rulings:**
- Files: `apps/web/src/features/job/JobSections.tsx` (Proposals section), `features/approvals/*` copy keys only if needed, `features/today/Today.tsx`; test `apps/web/test/e1-integration.test.tsx`.
- **Ruling ED:** Today's "Signed today" uses `GET /api/proposals?status=signed&signedOn=<today>`.

**Verify notes:**
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(web): proposals on the job, review previews, and signed proposals on Today`
