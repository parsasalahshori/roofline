### Task 24: Web: map storm layer

**Base:** `s1-storm` after Task 22 is merged. Real (F2): `shell/map/layers.ts` (`SOURCE.stormSwath = 'storm-swath'`, `LAYER.stormSwathFill`, `addSourceOnce`), `MapView.tsx`, the MapLibre mock in F2's map tests; **[C1]** C1 T27 added `?focus=` handling in `MapView.tsx`.

Read first: `ops/sdd/s1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-storm-scout-design.md`. Names marked **[C1]** / **[E1]** come from the C1/E1 plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`), not from built code: check each against `c1-crm`/`e1-estimator` before starting and report any difference.

**Split:** Builder 1 `shell/map/stormLayer.ts` (fill the F2 `storm-swath` source from `/api/map/storm-layer` on move-end, debounced; fill colours by level `--hail-1`…`--hail-5`; spotter dots layer `storm-spots`); Builder 2 `HailLegend.tsx` ("Radar-estimated hail" with the five colours and sizes) and a toggle in the map's layer menu; Builder 3 tests.

**Files:** Create the two files; Modify `apps/web/src/shell/map/{layers.ts,MapHome.tsx}` (add the spots layer constant and mount the hook), `apps/web/src/styles/tokens.css` (the five hail colours if F2 didn't define them, light and dark).

**Tests:**
- the hook requests with bbox and zoom; source data set; legend visible only when swaths are present; colours meet 3:1 against the base map (documented values).

**Carries and rulings:**
- `shell/map/layers.ts` is edited only here in S1.

**Verify notes:**
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(web): hail swaths and spotter reports on the map`
