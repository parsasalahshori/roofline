### Task P3b: Billing polish (typed Stripe refusals, one error mapping, cancel clears the subscription, safer change plan, trial margin, dead webhook claim helpers)

**Base:** `f3-setup` 202396a (F3 Tasks 1–12, 18, 19, 20 merged). Written by sibling 2 from its G1 group-check carries (controller message 2026-10-12). No new dependencies; do not touch `package.json` or `package-lock.json` (if you somehow must, check `npm ls playwright-core` stays 1.56.1).
**Carry (T3's scan):** no `19900`/`39900` in any `apps/*/src` or `packages/*/src` file.

**Split:**
- Builder 1 — provider side: `apps/api/src/providers/billing.ts`, `apps/api/src/providers/stripe.ts`, `apps/api/src/billing/stripe-sync.ts`, `apps/api/src/scripts/sync-stripe-plans.ts`, `apps/api/src/providers/fakes/billing.ts`, `apps/api/test/stripe-provider.test.ts` (items 1, 3, 4).
- Builder 2 — routes and trial margin: `apps/api/src/account/billing-routes.ts`, `apps/api/test/billing-routes.test.ts` (items 1-routes, 5). Depends only on the names in item 1 (`BillingRefusedError`, `FakeBillingProvider.failNext(n, kind)`), which the lead creates as shells first.
- Builder 3 — webhooks and dead code: `apps/api/src/billing/stripe-events.ts`, `packages/db/src/system/billing-events.ts`, `apps/api/test/stripe-events.test.ts`, `apps/api/test/stripe-hooks.test.ts`, `packages/db/src/system/routing.ts`, `packages/db/test/routing.test.ts` (items 2, 6).

**1. A typed refusal (`providers/billing.ts`)**
```ts
export class BillingUnavailableError extends Error {}      // unchanged
export class BillingRefusedError extends Error {}          // new: Stripe answered and said no
```
- The provider throws `BillingRefusedError` (never a bare `Error`) for: any Stripe error that is not "unavailable" (below), a Checkout session without a `url`, a missing price ("A Stripe price is missing; run sync:stripe-plans."), and the change-plan refusal of item 4. Messages stay plain constants; Stripe's own message is never read, stored or logged.
- `FakeBillingProvider.failNext(n = 1, kind: 'unavailable' | 'refused' = 'unavailable')`: the next `n` calls throw `BillingUnavailableError('Fake billing is unavailable.')` or `BillingRefusedError('Fake billing refused.')`. Existing callers (`failNext(1)`) keep working.
- `account/billing-routes.ts` `guarded()`: `BillingUnavailableError` → 503 (unchanged); `BillingRefusedError` → **502** `{ error: REFUSED }` with the new constant `const REFUSED = "The payment service turned this down. Check your plan details or try again later.";` Anything else is rethrown (a real bug stays a 500).
- Test (`billing-routes.test.ts`): `test('a refusal from the payment service is a 502 with a plain message')` — `t.billing.failNext(1, 'refused')` then `POST /api/billing/checkout { planKey: 'starter' }` → 502 `{ error: REFUSED }`; same for `/portal` (after a checkout made a customer) and `/plan` (with a live subscription set by SQL as in the existing tests).

**2. A deleted subscription clears the stored id (`stripe-events.ts`, `system/billing-events.ts`)**
- Both `BillingUpdate` copies: `set.stripeSubscriptionId?: string | null`, plus a new optional `onlyIfSubscription?: string`.
- `billingUpdateFor('customer.subscription.deleted')` → `{ set: { status: 'canceled', stripeSubscriptionId: null }, onlyIfSubscription: object.id }`.
- `applyBillingEvent`: after the stale check, when `u.onlyIfSubscription` is set and the company's stored `stripe_subscription_id` is non-null and differs from it, only `billing_event_at` moves → `{ applied: false, before, after: before }` (a late delete of an old subscription must not cancel a company that has already subscribed again). Otherwise apply as today; `null` writes `stripe_subscription_id = null`.
- Tests: `stripe-events.test.ts` — the deleted mapping now equals `{ status: 'canceled', stripeSubscriptionId: null }` with `onlyIfSubscription: 'sub_4'`. `stripe-hooks.test.ts` — extend `'a deleted subscription cancels'` to assert `stripe_subscription_id` is null afterwards; new `test('deleting an old subscription leaves the new one alone')`: company has `sub_2` stored (status `active`) → `customer.subscription.deleted { id: 'sub_1' }` → still `active`, `sub_2`, no `billing.status_changed` audit row.
- With this, T19's checkout guard (`hasPaymentMethod`) and the stored id agree; keep T19's guard as is.

**3. One Stripe error mapping (`providers/stripe.ts`, used by `billing/stripe-sync.ts`)**
```ts
export const STRIPE_UNAVAILABLE = "Stripe didn't answer.";
export const STRIPE_REFUSED = 'Stripe refused the request.';
/** Maps a thrown value from the Stripe SDK. Non-Stripe errors come back unchanged, so real bugs are not hidden. */
export function stripeFailure(err: unknown): unknown;
```
- `Stripe.errors.StripeConnectionError`, `statusCode >= 500`, `429`, and **`409` (idempotency key in use: a concurrent request with the same key is still running, so a retry succeeds)** → `new BillingUnavailableError(STRIPE_UNAVAILABLE)`. Any other `Stripe.errors.StripeError` → `new BillingRefusedError(STRIPE_REFUSED)`. Anything else → returned as is.
- `StripeBillingProvider.call()` becomes `try { return await fn(); } catch (err) { throw stripeFailure(err); }` (keep the lint rule `preserve-caught-error` happy the same way T18 did: do not attach the Stripe error as `cause`). `stripe-sync.ts` deletes `refusalAsPlainError` and its `REFUSED` constant and uses the same helper. `scripts/sync-stripe-plans.ts` prints `err.message` for `BillingUnavailableError`/`BillingRefusedError` and its own plain `REFUSED` line only for anything else (drop the duplicate constant if it becomes unused).
- Test (`stripe-provider.test.ts`): a 409 answer → `BillingUnavailableError`; a 400 → `BillingRefusedError` whose message is `STRIPE_REFUSED` (not Stripe's); a non-Stripe error thrown from the injected `fetch` path that the SDK wraps stays a connection error (unavailable) — and a unit test of `stripeFailure(new TypeError('x'))` returns the same `TypeError`.

**4. Change plan refuses cleanly (`providers/stripe.ts`)**
- In `changePlan`, after building `items`: when `items.length` is not exactly 3 (one per kind: `_monthly`, `_ai_call_minute`, `_sms_segment`) — e.g. a sync moved the lookup keys off the old prices with `transfer_lookup_key` — throw `new BillingRefusedError("This subscription's prices are out of date; run sync:stripe-plans, then change the plan in the Stripe portal.")` **before** calling `subscriptions.update` (never send empty or partial `items`).
- Test: a canned subscription whose items have `lookup_key: null` → `BillingRefusedError`, and no `POST /v1/subscriptions/sub_…` request was recorded.

**5. Trial margin (`account/billing-routes.ts`)**
- Stripe Checkout requires `subscription_data.trial_end` to be at least 48 hours after it receives the request. Keep the trial only when `trial_ends_at` is at least **49 hours** after `deps.clock.now()`: `const TRIAL_KEEP_MS = 49 * 60 * 60 * 1000;` with a one-line comment saying why (Stripe's 48-hour minimum plus an hour for clock skew and slow requests). Under that, `trialEnd: null` and Checkout bills at once (Ruling 7 unchanged in spirit).
- Test: `trial_ends_at` = now + 48 h 30 min → `trialEnd: null`; now + 49 h → kept. Keep the existing 10-day test.

**6. Remove the dead claim helpers (`system/routing.ts`)**
- `claimWebhookEvent` and `releaseWebhookEvent` have no production caller (T11 dropped them from `/status`; T20 writes its claim inline). Before deleting, grep `apps/` and `packages/` (src and test) for both names; delete them only if nothing but `packages/db/test/routing.test.ts` uses them. Delete their `describe('claimWebhookEvent / releaseWebhookEvent', …)` block and any imports/barrel exports that become unused. Update the comment in `system/billing-events.ts` that mentions `claimWebhookEvent` so it no longer points at a deleted function. Leave the `webhook_events` table, its migration and `migrations.test.ts`/`rls.test.ts` alone.

**Verify:**
- Locally: `npm run typecheck && npm run lint` (through `ops/bin/slot`) and `npx vitest run --project @roofline/shared billing`. The api and db suites need PostGIS (no Docker here): prove them with `ops/bin/ci-check` (Platform job).
- Commit: `fix(billing): typed Stripe refusals, one error mapping, cancel clears the subscription, safer change plan, trial margin`.
