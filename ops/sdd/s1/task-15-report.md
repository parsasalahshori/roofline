# Task 15 report: door outcomes API and leads from doors

## Built
- repo: packages/db/src/repos/door-routes.ts real SQL (stops, routes, outcome set-once, exclusions); jobs.ts stormId on createJob.
- doors: apps/api/src/storm/doors.ts recordDoorOutcome (customer + home + Lead job in one transaction; consent only when OK to text; do-not-knock adds exclusion).
- routes: apps/api/src/routes/door-routes.ts (GET /mine, GET /:id, POST /:id/stops/:stopId/outcome), apps/api/test/doors.test.ts.

## Reviews
- Review 1: 1 finding, fixed. Contact check 1: F1 amended. Review 2: 0 findings.

## Minors
- placeFor has a leftover `void tx; void ctx;`.
- Duplicate-address savepoint retry relies on nested transactions; covered only by CI.
- doors.test.ts column names for sms consent unverified locally.

## Verify
typecheck and lint clean; shared vitest 28 files, 667 tests passed. DB suites run on CI only.
CI: run 38223749281 PASSED (Platform, E2E, Hail) at 88c6bd7.
