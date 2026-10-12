### Task 14: `build_routes` handler

**Base:** `s1-storm` after Tasks 5, 7 and 9 are merged. From T5: `splitIntoRoutes`. From T7: `Geocoder.reverseMany`. **[E1]** `building_footprints` and the footprint fixture.

Read first: `ops/sdd/s1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-storm-scout-design.md`. Names marked **[C1]** / **[E1]** come from the C1/E1 plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`), not from built code: check each against `c1-crm`/`e1-estimator` before starting and report any difference.

**Split:** Builder 1 `repos/door-routes.ts` (homes in the threshold area minus `door_exclusions` and do-not-contact customers' homes, with any matching property id; insert routes and stops); Builder 2 `storm/routes-build.ts` (pick, cluster, order, reverse-geocode non-customer stops in chunks, idempotent by `company_storm_id` + step); Builder 3 tests.

**Files:** Fill the listed files; Modify `apps/api/src/tasks/handlers.ts` (swap the stub); Test `apps/api/test/routes-build.test.ts`.
- **Interfaces:** `buildRoutesHandler: StepHandler<'build_routes'>` → result `{ routes: number, doors: number, byRep: { userId, doors }[] }`; route names `"Omaha · Route 1 (Sam)"`; stops with no address after geocoding show "Near 41.2565, -95.9345".

**Tests:**
- with the E1 footprint fixture and a fixture storm: every door once, ≤ 150, customers' homes carry `property_id` and their saved address, exclusions skipped, re-run returns the same routes, reverse geocoding called in chunks of ≤ 1000.

**Carries and rulings:**
- Swap only this task's stub in `tasks/handlers.ts`.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): build door-knock routes for the homes in the hail path`
