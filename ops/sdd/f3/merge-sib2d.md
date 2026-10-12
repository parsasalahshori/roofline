# Merge notes, sibling 2d (F3 P3b billing polish; Opus contact 40, run wf_8340cb97-1c6)

- Branch f3-p3b from f3-setup 202396a. Team commit 28bfd2a (review round 1 clean; ci-check run 38186859048 Platform passed). Sibling follow-up commit on top: MISSING_PRODUCT in stripe-sync.ts now throws BillingRefusedError, so sync-stripe-plans prints its hint instead of the generic refusal; stripe-sync.ts imports Stripe as a type only.
- Deliberate deviation from the controller's item 1: Stripe's idempotency 409 (a concurrent request with the same key is still running) maps to BillingUnavailableError (503, try again), not to a refusal, because a retry succeeds. Everything else in items 1-6 is as listed.
- Item 6: claimWebhookEvent/releaseWebhookEvent and their routing.test.ts block are removed; there were no other callers. Any in-flight branch that still imports them will fail to compile after this merge (none found on f3-setup).
- The trial cutoff is now 49 h (Stripe's 48 h minimum plus 1 h). The F3 plan text still says 48 h, which is worth a ledger note.

## Group check merge notes

There is only one task in this batch (P3b, branch f3-p3b, base 202396a, head 28bfd2a: one commit across 15 files). I checked the merge into f3-setup directly.

Conflicts: none expected. 202396a is an ancestor of origin/f3-setup. The commits on f3-setup since the base are F2 merges and ops/sdd docs, and none of them touches the files P3b changes: billing-routes.ts, billing/stripe-events.ts, billing/stripe-sync.ts, apps/api/src/index.ts, providers/billing.ts, providers/fakes/billing.ts, providers/stripe.ts, scripts/sync-stripe-plans.ts, the four api tests, packages/db/src/system/billing-events.ts, packages/db/src/system/routing.ts and packages/db/test/routing.test.ts. A plain merge should apply cleanly.

How the pieces fit:
- BillingRefusedError is added in providers/billing.ts and exported from the api barrel (index.ts). It is used by the fake, by stripe.ts, by guarded() in billing-routes (refusal maps to a 502 with "The payment service turned this down. Check your plan details or try again later.") and by sync-stripe-plans.
- stripeFailure() and STRIPE_UNAVAILABLE / STRIPE_REFUSED in providers/stripe.ts are now the one Stripe error mapping. stripe-sync's mapStripeFailure and the provider's call() both use it. Behaviour change: a 409 (idempotency key still in use) now counts as unavailable, so it becomes a 503. Errors that do not come from Stripe are rethrown unchanged, which means real bugs now surface as 500s instead of becoming "refused".
- The web client (apps/web/src/api/client.ts) shows body.error for any status, so the new 502 message reaches users with no web change. No web billing caller exists yet.
- BillingUpdate.set.stripeSubscriptionId is now `string | null`, and the new onlyIfSubscription field is added in both places it is defined: apps/api/src/billing/stripe-events.ts and packages/db/src/system/billing-events.ts. The two definitions match. applyBillingEvent reads the stored subscription id; if it differs from the deleted subscription, only billing_event_at moves and no audit is written. A stored null still lets the cancel apply.
- claimWebhookEvent / releaseWebhookEvent are removed from routing.ts, with their tests in packages/db/test/routing.test.ts. There are no remaining callers in the code. The only mentions left are in ops/sdd docs on f3-setup, which call for exactly this removal ("remove them in P3b unless a later task uses them"). `and` is still used in routing.ts, so the import stays correct. Merge risk: if any other in-flight F3 branch not in this batch still imports claimWebhookEvent, it will fail to compile after this merge. A grep of the current f3-setup code finds no such caller.
- The trial margin is now TRIAL_KEEP_MS = 49h (Stripe's 48h minimum plus 1h of slack). The plan text (docs/superpowers/plans/2026-10-11-roofline-f3-setup.md:1795, 3049) still says "at least 48 hours". The controller may want to note the deliberate one-hour margin in the F3 ledger.

Copy and lint: the changes are API-side only. There is no JSX and no web copy, so the copy rule and the raw-button rule do not apply. The route messages are plain English, as Ruling 33 requires.

Verification after merge: run `/home/user/roofline/ops/bin/slot npm run typecheck` and `/home/user/roofline/ops/bin/slot npm run lint`. Run the stripe-provider and stripe-events vitest files locally (both are DB-free). billing-routes, stripe-hooks and packages/db routing need a database, so they must go through `/home/user/roofline/ops/bin/ci-check`.

## Group check issues

- (minor) P3b moves a missing Stripe price to BillingRefusedError, but a missing Stripe product in apps/api/src/billing/stripe-sync.ts (MISSING_PRODUCT, lines ~189 and ~196) still throws a plain Error. The catch in sync-stripe-plans main() only prints err.message for typed billing errors, so 'A Stripe product is missing; run sync:stripe-plans.' is replaced by the generic 'Stripe refused the request.' and the operator never sees the useful hint. The same thing happened before this change, but P3b now handles the two missing-resource cases differently. Suggestion: Throw new BillingRefusedError(MISSING_PRODUCT) in both places so the sync script prints the specific message. A follow-up is fine; this does not block the merge.
- (minor) apps/api/src/billing/stripe-sync.ts still has `import Stripe from 'stripe'` as a value import, but after the refactor Stripe is only used as a type (stripe: Stripe, Stripe.PriceCreateParams). No consistent-type-imports or verbatimModuleSyntax setting showed up in the root configs, so lint and typecheck should still pass. It is just slightly inconsistent. Suggestion: Optionally change it to `import type Stripe from 'stripe'`. Confirm with the slot-wrapped `npm run lint` before merging.
- (minor) FakeBillingProvider.failNext(n, kind) keeps one failKind for the whole failure counter. If a test calls failNext(1, 'refused') and then failNext(1), the earlier queued failure also becomes 'unavailable'. No current test mixes the two, so nothing is wrong today. Suggestion: Replace the counter with a queue of kinds if a test ever needs mixed failures. No action is needed for this merge.
- (minor) apps/api/test/stripe-provider.test.ts (the 400 test) checks the message twice: toBe(STRIPE_REFUSED), then toBe('Stripe refused the request.'). The second check repeats the first. Suggestion: Cosmetic. It can stay, since the literal check pins the plain text.

Status: issues 1 and 2 are fixed in the follow-up commit; 3 and 4 are left as is.

## Task minors

- apps/api/src/billing/stripe-events.ts: a customer.subscription.deleted event without an object id now returns null, so it is acknowledged and ignored. That is defensible, but the brief does not say so; consider a one-line comment.
- apps/api/test/stripe-provider.test.ts: the first 400 test asserts the message twice (STRIPE_REFUSED and the literal), which is redundant. The stripeFailure unit tests do not cover 429, 5xx or a 400 directly, though the provider tests cover 409, 400 and the connection failure.
- apps/api/src/providers/stripe.ts: the STRIPE_UNAVAILABLE export is only used inside the file and in tests (no problem, just noting it).
