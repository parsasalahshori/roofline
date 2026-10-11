### Task 18: Web: Settings — templates, financing, estimates

**Base:** `e1-estimator` after Tasks 3 and 14 are merged. From T3: `TierTemplateSchema`. **[C1]** `features/setup/SetupRow.tsx` (F3 T32, last edited by C1 T25 for `connect_calendar`) — add the `prices_and_tiers` action only.

Read first: `ops/sdd/e1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-estimator-design.md`. Names marked **[C1]** come from the C1 plan/briefs (`ops/sdd/c1/`), not from built code: check each against `c1-crm` before starting and report any difference.

**Split:** Builder 1 `TiersSection.tsx` (three template editors: name, material, waste, markup, add-ons, highlights, enabled); Builder 2 `FinancingSection.tsx` (APR, term) and `EstimateSection.tsx` (default pitch, overhang, proposal valid days, estimate clause toggle, aerial switch when configured); Builder 3 `copy/tiers.ts`, hooks in `features/settings/estimator-api.ts`, the `prices_and_tiers` setup row action (→ `/settings/prices`) in C1/F3's `SetupRow.tsx`, tests.

**Tests:**
- saves send the shared schemas' shapes; validation errors by field path; office read-only; aerial switch hidden when not configured; the setup row link.

**Carries and rulings:**
- Files: `apps/web/src/features/settings/{TiersSection,FinancingSection,EstimateSection,estimator-api}.tsx|ts`, `copy/tiers.ts`, `features/setup/SetupRow.tsx` (one action); test `apps/web/test/settings-estimator.test.tsx`.

**Verify notes:**
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(web): Good/Better/Best templates, financing and estimate settings`
