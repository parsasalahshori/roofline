# S1 Task 14 report: build_routes handler

## Built
- repo (packages/db/src/repos/door-routes.ts): listHomesInZone (zone CTE, lateral property pick, door_exclusions and do-not-contact filters), listBuiltRoutes, insertRoutesOnce (advisory lock, idempotent, stops in multi-row inserts of 500).
- handler (apps/api/src/storm/routes-build.ts): buildRoutesHandler, wired in tasks/handlers.ts; reports { routes, doors, byRep } (ruling AY). REVERSE_CHUNK = 1000. Reverse-geocodes missing addresses, falls back to `Near lat, lng`.
- tests (apps/api/test/routes-build.test.ts): 9 tests; storm-skeleton.test.ts no longer expects build_routes to be a stub.

## Reviews
- Review 1: 1 finding; contact check 1 outcome: amend (applied).
- Review 2: 0 findings.

## Minors
- Removed the stale "Task 14 shell" header comment in door-routes.ts.
- SQL (member lookup `= any(...::uuid[])`, PostGIS queries) first runs on CI; no local DB.

## Verify
typecheck, lint clean; `vitest --project @roofline/shared`: 28 files, 657 tests passed.
