# Task 16 report: Retention sweep

## Built
- A-db: packages/db/src/repos/fd-retention.ts (expired recordings, blanked turns, customer lookups), packages/db/src/system/fd-retention.ts (companyIdsForRetention), export in index.ts.
- B-api: apps/api/src/front-desk/retention.ts (sweepCompanyRetention, purgeCustomerConversations per Ruling DX, not hooked into setArchived), apps/api/src/jobs/scheduler/fd-retention.ts (per-company fan-out, one failure does not stop the rest).
- C-tests: apps/api/test/front-desk/retention.test.ts.

## Review rounds
- Review 1: verify passed, 0 findings.

## Minors
- Raw SQL in the jsonb_array_elements subqueries and the company_settings / calls writes in tests are only proven by CI.
- purgeCustomerConversations does not catch objectStore.delete errors (aborts the caller's tx by design).

## Verify
typecheck, lint clean; vitest @roofline/shared 21 files, 805 tests passed. DB suites run on CI via ci-check.

## CI
- Run 38240450949 (b70aa12): Platform failed, E2E passed. Cause: test helper setRetention wrote company_settings through the system pool; app_system has no grant. Fixed by writing through withTenant (e965181).
- Run 38241765685 (e965181): Platform, v1 and E2E all success.
