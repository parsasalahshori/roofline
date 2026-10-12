
# Task 5 report: shared door routes (k-means and 2-opt)

## Built
- kmeans: packages/shared/src/door-kmeans.ts (pickDoors, clusterDoors; seeded FNV-1a + mulberry32, k-means++, balanced assignment, empty-cluster repair) with test/door-kmeans.test.ts.
- tour: packages/shared/src/door-tour.ts (orderRoute, nearestNeighbourOrder, routeLength; NN start at NW corner, 2-opt, order-independent) with test/door-tour.test.ts (13 cases).
- split: packages/shared/src/door-routes.ts (splitIntoRoutes; k = max(reps, ceil(n/150)), least-loaded rep assignment) with test/door-routes.test.ts.
- door-types.ts holds shared types.

## Review rounds
- Review 1: verify passed, 0 findings.

## Minors
- Balanced assignment sorts n*k pairs per iteration; fine for k about 10 at 1,500 doors.
- Oversized-route halving path in splitIntoRoutes is defensive and not exercised by tests.

## Verify
- vitest @roofline/shared: 18 files, 415 tests passed. typecheck (tsc -b) clean. lint (eslint .) clean.
