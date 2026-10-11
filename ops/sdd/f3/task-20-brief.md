### Task 20: Stripe webhooks

**Base:** `f3-setup` after Task 9 is merged (T3 is in). From T9: stub `apps/api/src/hooks/stripe.ts` (`stripeHooks(deps): Router`, mounted at `/hooks/stripe` **before** the JSON parser, its router already using `express.raw({ type: '*/*', limit: '512kb' })`), config `STRIPE_WEBHOOK_SECRET` (`testConfig` sets `whsec_test_roofline`). From T3: `planFromLookupKey`. From T1: `companies.billing_event_at`, `past_due_at`, `stripe_subscription_id`, `billing_period_start`, `plan_key` (app_system-only writes), placeholder `packages/db/src/system/billing-events.ts` (in the system barrel). `webhook_events (provider, event_id)` unique, app_system ALL. `@roofline/db/system` is allowed in `hooks/**`. The send gate's billing rule already blocks with "Texting is paused until billing is sorted out." (`packages/send-gate/src/decide.ts`).

**Split:**
- Builder 1: `apps/api/src/billing/stripe-signature.ts`, `apps/api/src/billing/stripe-events.ts` and `apps/api/test/stripe-events.test.ts`.
- Builder 2: `packages/db/src/system/billing-events.ts` and `apps/api/src/hooks/stripe.ts`.
- Builder 3: `apps/api/test/stripe-helpers.ts` and `apps/api/test/stripe-hooks.test.ts`.

**Files:**
- Create: `apps/api/src/billing/stripe-signature.ts`, `apps/api/src/billing/stripe-events.ts`, `apps/api/test/stripe-helpers.ts`
- Modify: `apps/api/src/hooks/stripe.ts`, `packages/db/src/system/billing-events.ts`
- Test: `apps/api/test/stripe-hooks.test.ts`, `apps/api/test/stripe-events.test.ts`
- Do not touch: `system/routing.ts` (T11/T13 chain; write the claim inside this task's own transaction), `app.ts`, `test/helpers.ts`.

**Interfaces:**
```ts
// billing/stripe-signature.ts
export class StripeSignatureError extends Error {}
export function verifyStripeSignature(rawBody: Buffer, header: string | undefined, secret: string, now: Date, toleranceSec = 300):
  { id: string; type: string; created: number; data: { object: Record<string, unknown> } };
// billing/stripe-events.ts
export type BillingUpdate = { customerId: string; eventId: string; eventCreated: Date;
  set: { status?: CompanyStatus; stripeSubscriptionId?: string; planKey?: string; billingPeriodStart?: Date }; onlyIfPastDue?: boolean };
export function billingUpdateFor(event: { id: string; type: string; created: number; data: { object: Record<string, unknown> } }): BillingUpdate | null;
export function companyStatusFor(subscriptionStatus: string): CompanyStatus | null;
// system/billing-events.ts
export async function companyIdForStripeCustomer(system: Db, customerId: string): Promise<string | null>;
export async function applyBillingEvent(system: Db, companyId: string | null, u: BillingUpdate):
  Promise<{ applied: boolean; before: CompanyStatus | null; after: CompanyStatus | null }>;
// test/stripe-helpers.ts
export function signedStripe(event: object, o?: { secret?: string; at?: Date }): { body: string; header: string };   // secret defaults to 'whsec_test_roofline', at to now
```
- **Signature:** header `t=<unix>,v1=<hex>[,v1=…]` (other keys ignored); expected = HMAC-SHA256(`secret`, `` `${t}.${rawBody}` ``) hex; compare with `timingSafeEqual` (equal-length buffers) against each `v1`; `|now − t| ≤ toleranceSec`. Anything missing, malformed, stale or unmatched → `StripeSignatureError`. The body must be valid JSON with string `id`, `type`, numeric `created`, object `data.object`.
- **`companyStatusFor`:** `trialing`, `active` → `active`; `past_due`, `unpaid` → `past_due`; `canceled`, `incomplete_expired` → `canceled`; anything else (`incomplete`, `paused`, …) → null.
- **`billingUpdateFor`** (`customerId` = `object.customer` string; null when missing):
  - `customer.subscription.created|updated`: `status` from `companyStatusFor(object.status)` (omitted when null), `stripeSubscriptionId = object.id`, `planKey` = `object.metadata.plan_key` else `planFromLookupKey` of the first item price's `lookup_key` that yields one, `billingPeriodStart` = `items.data[0].current_period_start ?? object.current_period_start` (unix → Date).
  - `customer.subscription.deleted` → `{ status: 'canceled' }`.
  - `invoice.payment_failed` → `{ status: 'past_due' }`.
  - `invoice.paid` → `{ status: 'active' }` with `onlyIfPastDue: true`.
  - anything else → null.
- **`applyBillingEvent`**, one `app_system` transaction:
  1. `insert into webhook_events (provider, event_id) values ('stripe', eventId) on conflict do nothing returning id` — a repeat → `{ applied: false, before: null, after: null }`.
  2. `companyId` null → stop (the claim stays: unknown customers are acknowledged once).
  3. `select … from companies where id = $1 for update`.
  4. `eventCreated < billing_event_at` → stale → `applied: false` (before = after = current status).
  5. `onlyIfPastDue` and status ≠ `past_due` → only `billing_event_at` moves; `applied: false`.
  6. Else update the given columns plus `billing_event_at = eventCreated`; `past_due_at = now()` when entering `past_due`, null when leaving it. Returns `{ applied: true, before, after }`.
- **`POST /hooks/stripe`:**
  - `STRIPE_WEBHOOK_SECRET` unset → 503 `{ error: "Billing isn't set up yet." }` (proposed Ruling Y: Stripe then retries; nothing is claimed).
  - Bad signature → 400 `{ error: 'Signature check failed.' }`.
  - `billingUpdateFor` null → 200 `{ received: true }`.
  - Else `companyIdForStripeCustomer`, `applyBillingEvent`; when `applied && before !== after`, write audit `billing.status_changed { from, to, event: type }` through `withTenant(pools, systemContext(companyId), …)`. → 200 `{ received: true }`.
  - The raw body is `req.body` (a `Buffer` from the router's `express.raw`).

**Tests:**
- `stripe-events.test.ts`: `companyStatusFor` for all 8 named statuses (+ `incomplete` → null); `billingUpdateFor` for each event type from canned objects; an item-level `current_period_start` is preferred over the top-level one; `planKey` from lookup key when metadata lacks it. `verifyStripeSignature`: good, wrong secret, `t` 301 s old, two `v1`s with the second correct.
- `stripe-hooks.test.ts` (set `stripe_customer_id = 'cus_A'` on Acme by SQL first; post with `supertest` `.set('Stripe-Signature', header).set('Content-Type', 'application/json').send(body)`):
  - `test('a bad or old signature is refused')`: wrong secret → 400; `at` = now − 301 s → 400; the company is unchanged and no `webhook_events` row.
  - `test('trial → plan and card → active, with the trial end kept')`: `customer.subscription.created { id: 'sub_1', customer: 'cus_A', status: 'trialing', metadata: { plan_key: 'starter' } }` → `status active`, `plan_key 'starter'`, `stripe_subscription_id 'sub_1'`, `trial_ends_at` unchanged, one `billing.status_changed` audit row.
  - `test('a failed payment makes the company past due and the gate blocks texts')`: `invoice.payment_failed` → `past_due`, `past_due_at` set; then a `send_sms_batch` to an attested customer with the registration approved (`approvedBatch` / `addSmsCustomers` from `./sms-helpers.ts`, drain the queue) → `result.blocked { billing: 1 }` and the message's `block_reason` "Texting is paused until billing is sorted out."
  - `test('a paid invoice clears past due, but never revives a canceled company')`.
  - `test('a deleted subscription cancels')`.
  - `test('the same event twice does nothing the second time')`: audit count 1.
  - `test('an older event after a newer one is ignored')`: `updated` (created 200, `past_due`), then `updated` (created 100, `active`) → still `past_due`.
  - `test('an unknown customer or event type is acknowledged and ignored')` → 200 `{ received: true }`, nothing changes.
  - `test('no webhook secret means not set up')` → 503.

**Verify notes:**
- api suite needs Docker (none here): locally `npm run typecheck && npm run lint`; prove with `ops/bin/ci-check`.
- Commit: `feat(billing): verified, idempotent Stripe webhooks that keep company status true`.
