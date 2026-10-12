### Task 22: Web skeleton

**Base:** `s1-storm` after Task 6 is merged. **[C1]** `router.tsx`, `shell/apps.ts` (`DockApp.shipped: boolean`, Ruling CB), `Settings.tsx`/`tabs.ts`, `ConnectionsTab.tsx` (Ruling CA). Real (F2): `features/storm/StormWindow.tsx`.

Read first: `ops/sdd/s1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-storm-scout-design.md`. Names marked **[C1]** / **[E1]** come from the C1/E1 plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`), not from built code: check each against `c1-crm`/`e1-estimator` before starting and report any difference.

**Split:** Builder 1 routes (`/storm`, `/storm/:id`, `/storm/routes`, `/storm/routes/:routeId`) and dock flag (`storm` shipped, no "Coming soon"); Builder 2 placeholders and empty `api.ts` (`features/storm`, `features/storm/routes`), Settings slots (`StormTab`, `AdConnections` under F3's Connections section); Builder 3 copy files (`storm`, `doors`, `ads`; Google Ads / Meta names in `copy/connections.ts`), `test/s1-routes.test.tsx`.

**Files:** Create placeholders and copy; Modify `apps/web/src/app/router.tsx`, `apps/web/src/shell/apps.ts`, `apps/web/src/features/settings/{SettingsPage,ConnectionsSection}.tsx` (slots only).

**Tests:**
- each route renders its placeholder; the dock's Storm opens `/storm`; Settings shows the Storm tab for owner/office only.

**Carries and rulings:**
- **Ruling SE:** the plan's `SettingsPage`/`ConnectionsSection` mean `Settings.tsx`/`tabs.ts` (a new `storm` tab for owner/office) and **[C1]** `ConnectionsTab.tsx` (slot for `AdConnections`).

**Verify notes:**
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(web): routes and slots for Storm Scout`
