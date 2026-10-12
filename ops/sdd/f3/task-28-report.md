# F3 Task 28 report: registration progress (callbacks, poll, number, fees)

Commit 1e1a962 on f3-t28.

## Built
- P1-progress: apps/api/src/account/texting/progress.ts (continueRegistration steps 1-4 under withRegistrationLock; monthKey, monthLabel, numberFeeDescription) and test/texting-progress.test.ts.
- P2-hooks-poll-db: packages/db/src/system/texting.ts (companyIdForTextingSid, registrationsToCheck, addMainNumber, companiesWithTextingFees), hooks/twilio-registration.ts (signed callback, enqueues texting-registration, never reads statuses), jobs/scheduler/poll-texting.ts, test/texting-callbacks.test.ts.
- P3-fees-recorded: jobs/scheduler/bill-monthly-fees.ts, test/texting-fees.test.ts, test/texting-recorded.test.ts.

## Reviews
- Review 1: verify passed, 0 findings.

## Minors
- progress.ts and advance.ts form an ESM import cycle (call-time use only; eslint clean).
- Error reporting uses reportJobError because AppDeps.logError is optional.
- Recorded test number is +14025550123 (fixture-defined); brand-failed path asserted without resubmit step.

## Verify
- typecheck and lint: clean.
- ci-check: PASSED (run 38193810297).
