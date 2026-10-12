### Task 12: Web: "How we count time saved"

**Base:** `a1-agents` after Task 8 is merged. Real (F3): `useCompany` (hourly rate in Settings → Company).

Read first: `ops/sdd/a1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-agents-screen-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** / **[D1]** come from the plans and briefs of those milestones (`ops/sdd/<milestone>/`), not from built code: check each against the merged branch before starting and report any difference.

**Split:** `TimeBaselines.tsx` (table: work, unit, basis, minutes input, reset), recount dialog showing before/after totals from a dry-run endpoint (`?dryRun=1`), hourly-rate link; tests.

**Carries and rulings:**
- Recount shows a dry run before confirming.

**Verify notes:**
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(web): owner-editable time-saved baselines`
