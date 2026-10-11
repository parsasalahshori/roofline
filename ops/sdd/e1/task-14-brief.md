### Task 14: Web skeleton

**Base:** `e1-estimator` after Task 4 is merged. **[C1]** From C1 T18: `router.tsx` (C1 routes), `shell/apps.ts` (`DockApp.shipped: boolean` — C1 Ruling CB), `copy/dock.ts`, `Settings.tsx`/`tabs.ts` with the `prices` tab; **[C1]** from C1 T25: `features/settings/PricesTab.tsx` (add section slots only). Real (F2): `AppWindow`, `EmptyState`, `RequireSession` in `app/`.

Read first: `ops/sdd/e1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-estimator-design.md`. Names marked **[C1]** come from the C1 plan/briefs (`ops/sdd/c1/`), not from built code: check each against `c1-crm` before starting and report any difference.

**Split:** Builder 1 routes (`/estimator`, `/estimator/measure/:measurementId`, `/estimator/proposals/:proposalId`, public `/p/:token` outside `RequireSession` and the shell), dock flag (`estimator` shipped); Builder 2 placeholders and empty `api.ts` per feature, Settings → Prices sections slots (`TiersSection`, `FinancingSection`, `EstimateSection` placeholders under C1's `PricesTab`); Builder 3 copy files (`estimator`, `measure`, `proposals`, `homeowner`, `tiers`) and `test/e1-routes.test.tsx`.

**Files:** Create `apps/web/src/features/{estimator,measure,proposals,homeowner}/{…Window|Page,api}.tsx|ts`, `apps/web/src/features/settings/{TiersSection,FinancingSection,EstimateSection}.tsx`, copy files, test; Modify `apps/web/src/app/router.tsx`, `apps/web/src/shell/apps.ts`, `apps/web/src/features/settings/PricesTab.tsx` (slots only), `apps/web/src/copy/legal.ts` (`footprintAttribution: 'Building outlines © Microsoft, ODbL'` — vendor names are allowed in `legal.ts`).

**Tests:**
- each route renders its placeholder; `/p/abc` renders without a session and without the shell (no dock, no map); the dock's Estimator has no "Coming soon".

**Carries and rulings:**
- Only this task edits `router.tsx`, `shell/apps.ts` and Settings slots for E1. The `/p/:token` route sits outside `RequireSession` and the shell.
- Files (plan): placeholders `features/{estimator,measure,proposals,homeowner}/…` + `api.ts`, `features/settings/{TiersSection,FinancingSection,EstimateSection}.tsx`, copy files, `test/e1-routes.test.tsx`; modify `copy/legal.ts` (footprint attribution).

**Verify notes:**
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(web): routes and slots for the Estimator, measuring, proposals and the homeowner page`
