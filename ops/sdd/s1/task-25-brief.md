### Task 25: Web: plan review previews and Edit for the new steps

**Base:** `s1-storm` after Task 22 is merged. Real (F2): `features/approvals/{Review.tsx,toReviewStep.ts,editable.ts,EditStepSheet.tsx}` — there is **no** `features/approvals/steps/` folder (Ruling SD). **[E1]** E1 T20 may have added copy keys there.

Read first: `ops/sdd/s1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-storm-scout-design.md`. Names marked **[C1]** / **[E1]** come from the C1/E1 plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`), not from built code: check each against `c1-crm`/`e1-estimator` before starting and report any difference.

**Split:** Builder 1 `EmailBatchPreview.tsx` + Edit (subject, body with missing-token warnings from `missingStormTokens`); Builder 2 `BuildRoutesPreview.tsx` + Edit (rep switches); Builder 3 `AdCampaignPreview.tsx` + Edit (max spend, days, headline/description/keywords or primary text, photo choice; a static circle thumbnail drawn as SVG from the step's circles; "Up to $150" prominent; "Only the owner can approve spending" for office) and registration in `features/approvals/steps/index.ts`.

**Tests:**
- each preview from fixture payloads; Edit validates with the shared `validate`; office sees the spend notice and can't approve ad steps; the texts step shows the per-recipient sample.

**Carries and rulings:**
- **Ruling SD:** create `features/approvals/steps/index.ts` (a registry `{ [stepType]: { Preview, editFields } }`) and the three preview components; wire it with one edit each in `toReviewStep.ts` (use the registry's preview when present) and `editable.ts` (registry edit fields). This task is S1's only editor of those F2 files.

**Verify notes:**
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(web): review and edit storm emails, routes and ads before approving`
