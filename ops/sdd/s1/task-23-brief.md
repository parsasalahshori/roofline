### Task 23: Web: Storm window and storm detail

**Base:** `s1-storm` after Task 22 is merged. Real (F2): `features/storm/StormWindow.tsx` (newest storm_scout draft + "Approve storm plan" — keep F2's test green), `shell/countedDrafts.ts`, `MapView`.

Read first: `ops/sdd/s1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-storm-scout-design.md`. Names marked **[C1]** / **[E1]** come from the C1/E1 plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`), not from built code: check each against `c1-crm`/`e1-estimator` before starting and report any difference.

**Split:** Builder 1 `StormWindow.tsx` (replaces F2's: list of company storms, "Approve storm plan" kept as F2's 2-click path for the newest plan, "Hail data is a little behind" banner from the layer's `stale`); Builder 2 `StormDetail.tsx` (swath mini-map using the shared map component with contour colours, counts, plan link, Dismiss with confirm); Builder 3 `StormResults.tsx` (live results, refetch every 60 s while a plan runs) + `api.ts` hooks + tests.
- **Hooks:** `useStorms()`, `useStorm(id)`, `useDismissStorm()`, `useRedraftStorm()`.

**Tests:**
- list from stubbed data with "radar-estimated"; the 2-click approve still works (F2 test kept green); detail counts and results; empty state "No hail in your area in the last 30 days. We check every 30 minutes."

**Carries and rulings:**
- Replace `StormWindow.tsx` only here; keep F2's "Approve storm plan" two-click path.

**Verify notes:**
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(web): Storm window — storms in your area, their plans and results`
