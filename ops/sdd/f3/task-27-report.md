
# Task 27 report: texting provisioning and submit

Branch f3-t27, commits 8fc3e1f (feature) and 7c8f77f (CI fix).

## Built
- B1-db-provision: packages/db/src/system/texting.ts repo bodies (companiesNeedingSubaccount, saveSubaccount never-overwrite upsert, saveSubmission transactional, withRegistrationLock NOWAIT); apps/api/src/jobs/scheduler/provision-texting.ts; apps/api/test/texting-provision.test.ts (3 tests).
- B2-routes-view: apps/api/src/account/texting/view.ts, texting-routes.ts (GET /, POST /registration; 403/400/409/202; audit with masked EIN; queue job).
- B3-advance-submit-tests: apps/api/src/account/texting/advance.ts (stage 1 under the lock, Rulings AE/X, fee record), apps/api/test/texting-submit.test.ts (8 tests).

## Reviews
- Review 1: verify passed, 0 findings.
- CI round 1 (run 38186669716): Platform failed. apps/api/test/jobs.test.ts "default handler map runs the stub jobs" drove the real texting-registration handler (now advanceRegistration) with empty deps. Fixed: the test now sends only the import job. E2E job also failed in that run (not judged by ci-check).
- CI round 2 (run 38187266174): Platform passed.

## Minors / parked
- Partial unique index on texting_registrations.messaging_service_sid parked (no migration here).
- Audit row is written after saveSubmission commits, in its own transaction (system pool).
- Fee write is inside the registration lock transaction (all-or-nothing).
- Seed gives every company an approved texting row; tests adapt.

## Verify tail
typecheck and lint: clean. ci-check: PASSED (run 38187266174).
