# F3 Task 18 report: Stripe adapter and the plan sync script

Commit 49b1615 on f3-t18.

## Built
- p1-provider: apps/api/src/providers/stripe.ts, real StripeBillingProvider and stripeFor (null when STRIPE_SECRET_KEY unset). Connection errors, 5xx and 429 become BillingUnavailableError; other errors rethrow "Stripe refused the request." (provider text never kept). Price cache per instance.
- p2-sync: apps/api/src/billing/stripe-sync.ts (planStripeSync, readStripeState, applySyncAction, describeAction), apps/api/src/scripts/sync-stripe-plans.ts, sync:stripe-plans script line in apps/api/package.json.
- p3-tests: apps/api/test/stripe-provider.test.ts, apps/api/test/stripe-sync.test.ts (recording fetch only).

## Reviews
- Review 1: verify failed, 1 finding, fixed.
- Contact check 1: F1 approve.
- Review 2: verify passed, 0 findings.

## Minors
- meterId is not compared when matching metered prices (follows the brief).
- The script needs the full app env via loadConfigOrExit.

## Verify
typecheck, lint clean; vitest @roofline/shared billing: 6 passed.

## CI
- Run 38183867544 (49b1615): failed. Two stripe-provider idempotency-key assertions (test header parsing: SDK passes [key,value] pairs) plus apps/api/test/pgboss.test.ts:194.
- Fix f4717fc: recordingFetch accepts pair arrays. 
- Run 38184669082 (f4717fc): failed, only on apps/api/test/pgboss.test.ts:194 (schedules list expects 3 names, T9 base registers 8: bill-monthly-fees, end-trials, poll-texting, provision-texting, report-usage added). Not this task's file; it comes from the T9 skeleton (80083cc) and needs a T9/controller fix. All Stripe tests pass.
