### Task 16: Web: measure view with the outline editor

**Base:** `e1-estimator` after Tasks 2 and 14 are merged. Real (F2): `shell/map/mapStyle.ts` `mapStyle(env, mode)`, `satelliteAvailable(env)`, the MapLibre mock used in F2's map tests. From T2: `instantEstimate`, `outlineProblem`.

Read first: `ops/sdd/e1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-estimator-design.md`. Names marked **[C1]** come from the C1 plan/briefs (`ops/sdd/c1/`), not from built code: check each against `c1-crm` before starting and report any difference.

**Split:** Builder 1 `OutlineEditor.ts` (MapLibre layers and pointer handlers: drag a corner, add on an edge midpoint, delete with Delete/long-press, draw mode with clicks and double-click/Enter to finish; keyboard: Tab through corners, arrow keys nudge 0.5 m); Builder 2 `MeasureWindow.tsx` (satellite style from F2's `mapStyle(env, 'satellite')`, structure toggles, pitch picker with diagrams, overhang, the numbers, "Get exact report", "Make proposal"); Builder 3 `copy/measure.ts`, `features/measure/api.ts`, tests (MapLibre mocked as in F2).
- **Geometry in the browser** comes from `@roofline/shared` `roof.ts` (live numbers while dragging); saving PATCHes the outline (debounced 500 ms).

**Tests:**
- editor reducers (pure: `moveCorner`, `insertCorner`, `deleteCorner`, `closeDrawing`) with `outlineProblem` messages; numbers update; pitch change PATCH; exact report button posts and shows "Waiting for your OK"; "Estimate" label present; attribution line.

**Carries and rulings:**
- Files: `apps/web/src/features/measure/{MeasureWindow.tsx,OutlineEditor.ts,api.ts}` (+ CSS), `copy/measure.ts`; test `apps/web/test/measure.test.tsx`.

**Verify notes:**
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(web): measure on satellite with an editable roof outline`
