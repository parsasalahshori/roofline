# Task 9 report: Storm match (company storms and hits)

## Built
- A-fanout-scheduler: packages/db/src/system/storm-match-fanout.ts (companiesWithCandidateStorms, bbox prefilter then ST_Intersects on geom_075 vs service_area, SRID 4326); apps/api/src/jobs/scheduler/storm-match.ts (per-company 'storm-match-company' send, singletonKey companyId); tests packages/db/test/storm-fanout.test.ts, apps/api/test/storm-match-scheduler.test.ts.
- B-repos: packages/db/src/repos/company-storms.ts, packages/db/src/repos/storm-hits.ts (shared zone CTE; refreshHits upsert, countHomes, countCustomersHit, thresholdContourInArea); test packages/db/test/storm-hits.test.ts.
- C-match: apps/api/src/storm/match.ts (+ candidate-days.ts), test apps/api/test/storm-match.test.ts (10 required tests).
- Fixtures: apps/api rootDir blocks importing packages/db/test/fixtures, so the shared storm fixtures are exported from packages/db/src/testing/storms.ts (@roofline/db/testing). seedFootprintFixture was absent on the base; tests use insertFixtureFootprint.
- No grant change needed (writes run as app_tenant in withTenant); migration 0018 untouched.

## Review rounds
- Review 1: verify passed, 0 findings.

## Minors
- CI assumptions to watch: footprint counts (4 inner points), hail_in sorted [1, 1.5], threshold-edge nested boxes.

## Verify tail
typecheck clean, lint clean, vitest @roofline/shared: 28 files, 657 tests passed. DB/api suites run on CI only.

## CI round 1 (run 38206854416, Platform failed)
Two storm-hits tests read storm_hits through the owner pool while the writes were still uncommitted inside the tenant transaction, so they saw no rows. Fixed in the test only: hitRows now reads through the open transaction. CI re-run below.
CI round 2: run 38208363292 PASSED at ee63a7a.
