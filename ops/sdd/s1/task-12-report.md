# Task 12 report: send_email_batch and the email send path

## Built
- A-db-and-dispatch: packages/db repos email-sends, email-opt-outs, messages; apps/api messaging/dispatch-email.ts and dispatcher.ts (scheduled email dispatch, parked steps for both batch types).
- B-email-batch-handler: apps/api storm/email-batch.ts, tasks/handlers.ts (send_email_batch wired), tasks/service.ts (previewFacts with companyAddress).
- C-tests: apps/api/test/email-batch.test.ts and email-helpers.ts (eight scenarios; db tests run on CI only).

## Review rounds
- Review 1: verify passed, 0 findings.

## Minors
- Customers without an email get no row and are left out of step counts.
- Tests use t.deps.config; lease-loss test relies on the first deps.clock.now() call being in the lease keeper.

## Verify output tail
typecheck: clean. lint: clean. vitest shared + send-gate: 33 files, 1182 tests passed.

## CI round 1
Run 38215911397: Platform failed on storm-skeleton.test.ts (send_email_batch is no longer a not-yet stub); E2E and Hail passed. Fixed by dropping send_email_batch from the stub-rejection loop (still asserted registered).
