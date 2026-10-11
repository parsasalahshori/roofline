# Merge notes, sibling 2c (F3 Tasks 18, 19, 20; Opus contact 37, run wf_4257d0b1-5b4)

| Task | Branch | Head | CI run (Platform) |
|---|---|---|---|
| 18 Stripe adapter and plan sync | f3-t18 | 72938ec | 38185479308 passed |
| 19 Billing API | f3-t19 | 484c9e4 | 38185483903 passed |
| 20 Stripe webhooks | f3-t20 | 5b22d88 | 38185489548 passed |

Each head already contains f3-setup 74ee852, so merging into f3-setup (suggested order T18, T19, T20) only adds each task's own commits. The three earlier local T9 merge commits have the same tree and drop out.

Each branch started from f3-setup 9a469c8 plus a local merge of f3-t9 80083cc (controller-approved). After the team run, f3-setup 74ee852 (T9 final) was merged into each branch, so the stale pgboss.test.ts expectation that failed every team CI run is gone.

Sibling fix after the group check (controller rule: take the recommended option): T19 04bd44b. Checkout's 409 'You already have a plan' now applies only while hasPaymentMethod is true (active or past_due), so a canceled or trial_ended company can check out again. /plan answers 409 'Pick a plan first.' unless the subscription is live. Test added: 'a canceled company can pick a plan again, but cannot change plan'. T20 still leaves stripe_subscription_id set on subscription.deleted (the optional second half of the suggestion, not done).

T20's dedupe choice: claimWebhookEvent was not used, because a transaction handle does not type-check as Db (it has no $client). The insert into webhook_events ... on conflict do nothing returning id is inline in applyBillingEvent's transaction. routing.ts is untouched.

## Group check merge notes

The three bases (1d02197, 8a0b3fa, 36eb0cf) are different commits with the same tree: each is f3-setup after Task 11 plus a merge of f3-t9. Current origin/f3-setup (74ee852, which has T9 merged) differs from those bases in apps/api only in apps/api/test/{jobs,pgboss,rep-visibility}.test.ts. None of the three branches touches those files, so the duplicate T9 merge commit should drop out cleanly.

No file is changed by more than one task:
- T18: apps/api/package.json (one script line), providers/stripe.ts, billing/stripe-sync.ts, scripts/sync-stripe-plans.ts, test/stripe-provider.test.ts, test/stripe-sync.test.ts.
- T19: account/billing-routes.ts, packages/db/src/repos/billing.ts, packages/db/src/system/billing-customers.ts, test/billing-routes.test.ts.
- T20: billing/stripe-events.ts, billing/stripe-signature.ts, hooks/stripe.ts, packages/db/src/system/billing-events.ts, test/stripe-helpers.ts, test/stripe-events.test.ts, test/stripe-hooks.test.ts.

I predict no conflicts, in any merge order (suggested order: T18, T19, T20). The barrels already re-export repos/billing.ts and system/billing-{customers,events}.ts from the skeleton, and the new exported names do not collide: billingFacts, usageTotals, BillingFacts, setStripeCustomerIfMissing, companyIdForStripeCustomer, applyBillingEvent and the db-side BillingUpdate type. The api-side BillingUpdate in billing/stripe-events.ts is a separate module, and the two copies are intentionally identical in shape.

The interfaces fit together:
- T18's StripeBillingProvider implements T9's BillingProvider exactly, including configured=true.
- T19 sends priceLookupKeys in the order monthly, ai_call_minute, sms_segment, which matches T18's destructuring.
- T19 catches T18's BillingUnavailableError and replaces its text with T19's own constant.
- Checkout (T18) and changePlan (T18) both write subscription metadata.plan_key, which T20 reads first, before falling back to planFromLookupKey.
- T19 stores stripe_customer_id before Checkout, and T20 resolves companies by that id.
- STRIPE_WEBHOOK_SECRET is read only in T20, and STRIPE_SECRET_KEY only in T18.

No UI or copy files are involved. All new messages are module constants, as Ruling 33 requires, and no provider text is passed on. The @roofline/db/system imports are in account/** (T19) and hooks/** (T20), both on the allowlist. No source file contains 19900 or 39900.

After merging, run ops/bin/ci-check on f3-setup. The only failure every branch had, pgboss.test.ts:194, should already be fixed on f3-setup. The canceled-company dead end (T19 and T20) is the one behaviour issue worth a follow-up brief amendment.

## Group check issues

- **T19, T20** (important): A canceled company can never subscribe again. T20's customer.subscription.deleted sets only status='canceled' and leaves companies.stripe_subscription_id at the dead subscription id, because BillingUpdate.set has no way to clear it. T19's POST /api/billing/checkout returns 409 'You already have a plan. Use Change plan.' whenever stripe_subscription_id is non-null, whatever the status. POST /api/billing/plan then calls T18's changePlan on a deleted subscription, Stripe answers 400, T18 rethrows a plain Error('Stripe refused the request.'), and T19 does not catch it, so the user gets a 500. T9's hasPaymentMethod already treats a canceled company as having no payment method (it needs active or past_due), so the summary and checkout disagree. Each task follows its brief; the gap is between the two briefs. Suggestion: Smallest fix, in T19: in /checkout, return the 409 only when hasPaymentMethod({ stripeSubscriptionId, status }) is true, so canceled and trial_ended companies may check out again. In /plan, return 409 'Pick a plan first.' when hasPaymentMethod is false. Optionally also change T20 so subscription.deleted clears stripe_subscription_id: widen set.stripeSubscriptionId to string | null in both BillingUpdate copies. Add a T19 test: with stripe_subscription_id 'sub_1' and status 'canceled' set by SQL, checkout returns 200. This needs a controller ruling and a brief amendment; it does not block the merge.
- **T18, T19** (minor): T18 turns every Stripe error that is not 'unavailable' into a plain Error: 'Stripe refused the request.' or 'A Stripe price is missing; run sync:stripe-plans.'. T19's guarded() maps only BillingUnavailableError and rethrows everything else, so these errors become generic 500s. Examples: a lookup key that sync:stripe-plans never created, a 409 idempotency_key_in_use when two tabs call ensureCustomer with the same 'customer:<id>' key at once (the race T19 is designed to handle), and a trial_end that is under Stripe's 48-hour minimum by milliseconds. T19 sends exactly 48h because it uses >=, and Stripe measures from when it receives the request. Suggestion: Follow-up, not needed for the merge. Either have T19 map any other provider error to a plain 502 or 503 constant, or have T18 export a typed BillingRefusedError for T19 to map. Give the trial-keeping check a small margin (for example, 48h plus 5 minutes) so a boundary trial gets trialEnd null instead of a Stripe 400.
- **T18** (minor): The mapping from Stripe errors to BillingUnavailableError or 'Stripe refused the request.' is written twice in T18: StripeBillingProvider.call() in providers/stripe.ts and refusalAsPlainError() in billing/stripe-sync.ts, along with duplicate REFUSED constants. The SDK construction is also repeated in scripts/sync-stripe-plans.ts. call() also turns a non-Stripe programming error into 'Stripe refused', which hides bugs. Suggestion: Optional cleanup after the merge: export one helper from providers/stripe.ts (for example, stripeFailure(err)) and use it in both places, and rethrow errors that are not StripeError unchanged in call(), as stripe-sync.ts already does.
- **T18, T19, T20** (minor): All three tasks have status verify-failed for the same reason: apps/api/test/pgboss.test.ts:194 expects 3 schedules, but the T9 skeleton registers 8. (T19's report names apps/worker/test/pgboss.test.ts, but that file does not exist; the failing file is apps/api/test/pgboss.test.ts.) The three branches do not touch this file. origin/f3-setup (74ee852) already updates apps/api/test/pgboss.test.ts and jobs.test.ts, so the failure comes from the stale base, not from these tasks. Suggestion: Merge them anyway. After each merge into f3-setup, re-run ci-check; the pgboss failure should be gone. No task-side fix is needed.

## Task minors

### T18
- apps/api/src/providers/stripe.ts:85-92 changePlan: sync uses transfer_lookup_key, so after a sync the OLD prices on live subscriptions lose their lookup_key. Items whose current price has a null lookup_key are then skipped (the brief mandates suffix detection, so this is as specified), and subscriptions.update is called with items possibly empty. Consider throwing 'A Stripe price is missing; run sync:stripe-plans.' (or a plain refusal) when items.length === 0, and/or falling back to price.recurring.usage_type / price.metadata to tell kinds apart.
- apps/api/src/scripts/sync-stripe-plans.ts:499 builds its Stripe client separately from StripeBillingProvider (fine, brief allows it), but has no test for main() (flag refusal, sk_live_ without --live, --dry-run applies nothing). Optional follow-up test with an injected env and recording fetch.
- apps/api/test/stripe-sync.test.ts covers only planStripeSync as the brief requires; applySyncAction (meter-name to meter-id resolution when the meter is created in the same run) and readStripeState are untested.
- apps/api/src/billing/stripe-sync.ts monthly price comparison checks only unit_amount, not currency or interval; acceptable for the plan file's shape.

### T19
- apps/api/test/billing-routes.test.ts: 'two checkouts at once' cannot truly exercise the race, because FakeBillingProvider.ensureCustomer already returns one id per company. It passes either way and only proves the shape; the real first-writer-wins path is covered by setStripeCustomerIfMissing, which has no direct test.
- apps/api/test/billing-routes.test.ts: usage rows use at = t.clock.now(), and the GET summary filters on at >= companies.created_at (the seed's DB now()). Clock skew between the Node host and the DB could drop the rows; setting the clock slightly in the future, or the at value to now plus 1 minute, would remove the risk.
- apps/api/src/account/billing-routes.ts: the audit write comes after the provider call, so an audit failure returns 500 after Stripe has already created the session or changed the plan. Acceptable, and it matches the brief's order.
- apps/api/src/account/billing-routes.ts: requireConfigured runs after the 400 and 409 checks, so an unconfigured deploy returns 409 'Add a card first.' on portal. This matches the brief (and the test uses a valid checkout), but 503 first would be arguably clearer.

### T20
- Dedupe choice: claimWebhookEvent was NOT used. Db = NodePgDatabase & { $client: pg.Pool }, and a transaction handle has no $client, so it does not type-check as Db. The builders wrote the insert ... on conflict do nothing returning id directly inside applyBillingEvent's single transaction, as the brief allows. routing.ts is untouched. Mention this in the report.
- apps/api/test/stripe-hooks.test.ts:213 - the 'no webhook secret' test calls makeTestApp a second time and overwrites t without closing the first app's pools. Harmless (resetDb runs each time), but it may leak a pool per run.
- packages/db/src/system/billing-events.ts - BillingUpdate is declared in both billing-events.ts and apps/api/src/billing/stripe-events.ts. This is deliberate (packages cannot import from apps) and is covered by a comment, but the two can drift. The type-check at the call site in hooks/stripe.ts catches structural drift.
- packages/db/src/system/billing-events.ts, final update call - the .update(companies).set(patch).where(...) chain is split across lines in a way prettier may want on one line. Lint passed, so this is cosmetic only.
- No 19900/39900 appears in any src file (grep clean).

