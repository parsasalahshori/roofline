# E1 Task 6 report: Footprints loader job and lookup (branch e1-t6)

## Built
- A-provider-fixture: ms-footprints.ts (streaming zip + GeoJSON provider via yauzl/stream-json, plain error text), fakes/footprints.ts (NE fixture now lazy), NE.geojson.zip fixture + generator, footprints-provider.test.ts.
- B-db-loader-jobs: packages/db/src/system/footprints.ts (claim/insert/finish/fail, stale-loading window), estimator/footprints-load.ts (idempotent loader, batches, plain failure text), jobs/scheduler/footprints-ensure.ts (singletonKey = state), handlers.ts, eslint.config.js (DB_SYSTEM_ALLOWED gains footprints-load.ts: boundary decision).
- C-db-tests: apps/api/test/footprints.test.ts (14 cases).

## Reviews
- Review 1: 2 findings. F1 rejected, F2 amended (contact check).
- Review 2: 0 findings.

## CI
- Run 38201914643 (a2264d9): failed. insertFootprints on a bowtie polygon: ST_MakeValid gave a MultiPolygon and the planner applied the Polygon column typmod before the ST_GeometryType filter. Fixed in cecee73: ST_CollectionExtract(...,3), keep only ST_NumGeometries = 1, project ST_GeometryN(g,1).
- Run 38202803240 (cecee73): PASSED.

## Minors
- statesNeedingFootprintsFor uses Date.now() for its stale cutoff (no now parameter).
- Company id picked by min(id::text), text order.
- Bowtie results (multi-part) are skipped, not split.

## Verify tail
typecheck and lint clean; CI Platform job passed on run 38202803240.
