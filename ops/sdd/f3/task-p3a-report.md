# Task 103 / P3a report

## Built
- geocoding: Ruling AN. Unplaceable sign-up address creates the account unlocated; 2 s sign-up geocode timeout (8 s kept for imports); shared ADDRESS_NOT_FOUND_MESSAGE; FakeGeocoder 2-part city; tests in signup-company, geocodio, fakes.
- early-reports-prune: migration 0012 (drizzle-kit generate --custom), system prune helper, scheduled prune job, worker registration, tests (prune-early-reports, pgboss, hardening, migrations).
- small-fixes: read-only bare paths (ALWAYS_OPEN_SECTIONS), InlineJobs per-queue singletonKey dedupe, MAX_IMPORT_ROWS text, read-only-guard.test.ts, jobs.test.ts.

## Reviews
- Round 1: 1 finding, amended (packages/db/test/rls.test.ts app_system grants and APP_SYSTEM_RLS_TABLES updated for early_delivery_reports).
- Round 2: 0 findings.
- Contact check 1: F1 = amend.

## Verify
typecheck and lint clean (tsc -b, eslint .). DB suites run on GitHub via ci-check (commit d0a305b); result recorded below.

## CI
- Run 38187015138 (d0a305b): failed; pgboss.test.ts schedule order and jobs.test.ts SCHEDULES list lacked prune-early-reports. Fixed in 51375ed (test-only).
- Run 38187733886 (51375ed): Platform job PASSED.
