# Task P3b report: billing polish (commit 28bfd2a, branch f3-p3b)

## Built
- B1-provider: providers/stripe.ts stripeFailure (connection, 5xx, 429, 409 -> BillingUnavailableError; other StripeError -> BillingRefusedError STRIPE_REFUSED); checkout-without-url, missing price and changePlan item-count guard are refusals; stripe-sync uses stripeFailure; sync script prints typed messages.
- B2-routes: guarded() maps BillingRefusedError to 502 REFUSED, unavailable stays 503; TRIAL_KEEP_MS 49h.
- B3-webhooks-dead-code: subscription.deleted sets status canceled and stripeSubscriptionId null, guarded by onlyIfSubscription (late delete of an old subscription is ignored); removed claimWebhookEvent/releaseWebhookEvent and their tests.

## Review rounds
- Round 1: verify passed, 0 findings.

## Minors
- stripe-sync MISSING_PRODUCT remains a bare Error (not in brief).
- A deleted subscription event without an id is treated as malformed and ignored.

## Verify
typecheck and lint clean; vitest @roofline/shared billing: 6 passed. CI: run 38186859048 PASSED (Platform job passed).
