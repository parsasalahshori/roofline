# F3 Task 20: Stripe webhooks

Commit 70ae90c on f3-t20.

Built:
- P1-pure-logic: apps/api/src/billing/stripe-signature.ts, stripe-events.ts, test/stripe-events.test.ts
- P2-db-and-route: packages/db/src/system/billing-events.ts (applyBillingEvent, companyIdForStripeCustomer), apps/api/src/hooks/stripe.ts
- P3-hook-tests: apps/api/test/stripe-helpers.ts, stripe-hooks.test.ts (9 tests)

Dedupe: inline `webhook_events insert ... on conflict do nothing returning id` inside the single system transaction (not claimWebhookEvent); routing.ts untouched.

Review 1: verify passed, 0 findings. Minors: none.
Assumption for CI: approve endpoint does not refuse a send_sms_batch while past_due.

Verify: typecheck, lint clean; shared billing vitest 6/6 passed. CI result: see final report.

CI: run 38183225658, Platform job FAILED. 1 of 3069 tests failed: apps/api/test/pgboss.test.ts "it schedules expire-drafts ... and sweep-queued and dispatch-messages" expects 3 schedules but the worker registers 8 (bill-monthly-fees, end-trials, poll-texting, provision-texting, report-usage added by earlier F3 tasks). Not caused by Task 20 (this branch does not touch the worker or pgboss.test.ts); the stale expectation comes from the base. All 95 other files, including the stripe tests, passed. Not fixed here to avoid a cross-task conflict; the controller should update that expectation on the integration branch.
