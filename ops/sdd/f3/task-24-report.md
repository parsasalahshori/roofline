# F3 Task 24: Import job: creating customers, homes and jobs

Built: P1 packages/db/src/repos/import-apply.ts (claim, planned skips, chunk apply with bulk customers/homes/jobs/timeline, progress, finish, fail); P2 apps/api/src/imports/run.ts (runImport: plan once, chunked apply with geocoding, retry-safe, plain failure on last attempt, alreadyPlanned() resume marker); P3 apps/api/test/import-run.test.ts (11 tests).

Review 1: verify passed, 0 findings.
CI round 1 (run 38185372182): failed. apps/api/test/jobs.test.ts "default handler map runs the stub jobs" sent import-customers with empty deps, which now runs the real runImport. Fixed (d25d662): that test only sends texting-registration; import-customers is covered by import-run.test.ts.
CI round 2 (run 38186638401): PASSED.

Minors: located/notLocated count a row with an earlier geom but a failed geocode as notLocated (per brief); geocoding also covers rows that later match existing customers (extra geocoder calls); writePlannedSkips does not touch updated_at.

Verify: local typecheck and lint clean; CI Platform job passed on d25d662.
