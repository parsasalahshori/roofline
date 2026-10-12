### Task 9: Storm match — company storms and hits

**Base:** `s1-storm` after Task 7 is merged. Real: `companies.service_area` (F2/F3, set by `setServiceArea`), `properties.geom`, `company_settings.hail_threshold_in`. **[E1]** `building_footprints` (`geom`, GIST) and the E1 test fixture `apps/api/test/fixtures/footprints-ne.json` / `seedFootprintFixture(pools)` (E1 T21).

Read first: `ops/sdd/s1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-storm-scout-design.md`. Names marked **[C1]** / **[E1]** come from the C1/E1 plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`), not from built code: check each against `c1-crm`/`e1-estimator` before starting and report any difference.

**Split:** Builder 1 `system/storm-match-fanout.ts` (companies with a service area and candidate storms) + the scheduler; Builder 2 `repos/{company-storms,storm-hits}.ts` (upsert, hits by contour ∩ service area, homes count from `building_footprints`); Builder 3 `storm/match.ts` and tests with fixture storms.

**Files:** Fill the listed repo/system/storm modules and `jobs/scheduler/storm-match.ts`; Create `packages/db/test/fixtures/storms.ts` (fixture storm geometries over the Omaha showcase and a second city); Test `apps/api/test/storm-match.test.ts`, `packages/db/test/storm-hits.test.ts`.

**Interfaces:**
```ts
// system/storm-match-fanout.ts
companiesWithCandidateStorms(sys, { days: string[] }) → { companyId: string }[]       // service_area intersects storms.geom_075 for those convective days
// repos
upsertCompanyStorm(tx, { stormId, maxIn, customersHit, homesHit, now }) → { companyStorm, created: boolean }
thresholdContourInArea(tx, stormId, thresholdIn) → geometry | null                 // highest contour ≥ threshold ∩ company service area (ST_Intersection), null when empty
refreshHits(tx, companyStormId, stormId, thresholdIn) → { customersHit: number }   // properties (not archived) inside the threshold contour; hail_in = highest containing contour level
countHomes(tx, stormId, thresholdIn) → number                                      // building_footprints with ST_Intersects(geom, area) (centroid-in)
// storm/match.ts
export async function matchCompany(deps, companyId: string, now: Date): Promise<{ created: string[]; grown: string[] }>
    // per candidate storm: max inside area ≥ hail_threshold_in → upsert; dismissed rows are left alone; final storms are matched once more after becoming final, then skipped
```

**Tests:**
- threshold edge (0.99 vs 1.00 with threshold 1.00); outside the service area → nothing; two companies get separate rows; growth increases counts; customer hail_in from the right contour; a dismissed storm doesn't reopen; footprint count with the E1 fixture.

**Carries and rulings:**
- Footprint homes count by centroid-in (`ST_Intersects` on the footprint centroid).

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): match storms to service areas and count customers and homes hit`
