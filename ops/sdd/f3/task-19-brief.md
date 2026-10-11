### Task 19: Billing API: summary, checkout, portal, change plan

**Base:** `f3-setup` after Task 9 is merged (T3 is in). From T9: stub `apps/api/src/account/billing-routes.ts` (`billingRoutes(deps): Router`, mounted at `/api/billing`), `deps.billing` (`BillingProvider`, `BillingUnavailableError`; `TestApp.billing` is a `FakeBillingProvider`), `billing/plans.ts` `billingConfig(deps)`, `billing/guards.ts` `hasPaymentMethod`, `@roofline/db/system` allowed in `account/**`. From T3: `BillingView`, `PlanSummary`, `Meter`, `METERS`, `meterUnits`, `planByKey`, `priceLookupKeys`. From T1: `companies.stripe_customer_id` (unique), `stripe_subscription_id`, `billing_period_start`, `plan_key`, `trial_ends_at` (tenant-readable; **only `app_system` may write them**), placeholders `packages/db/src/repos/billing.ts` and `packages/db/src/system/billing-customers.ts` (both in their barrels). `requireCapability('billing')` (owner only) in `permissions.ts`, `requireVerifiedEmail` in `auth/middleware.ts`.
**Carry (T3's scan):** no `19900`/`39900` in any `src` file; the test below may assert them.

**Split:**
- Builder 1: `packages/db/src/repos/billing.ts` and `packages/db/src/system/billing-customers.ts`.
- Builder 2: `apps/api/src/account/billing-routes.ts`.
- Builder 3: `apps/api/test/billing-routes.test.ts`.

**Files:**
- Modify: `packages/db/src/repos/billing.ts`, `packages/db/src/system/billing-customers.ts`, `apps/api/src/account/billing-routes.ts`
- Test: `apps/api/test/billing-routes.test.ts`
- Do not touch: `repos/usage.ts` (T22, in parallel), `system/billing-events.ts` (T20), `providers/*`.

**Interfaces:**
```ts
// repos/billing.ts
export type BillingFacts = { status: CompanyStatus; planKey: string | null; trialEndsAt: Date | null; stripeCustomerId: string | null;
  stripeSubscriptionId: string | null; billingPeriodStart: Date | null; createdAt: Date; name: string; email: string | null };
export async function billingFacts(tx: Tx, ctx: TenantContext): Promise<BillingFacts>;
export async function usageTotals(tx: Tx, ctx: TenantContext, since: Date): Promise<Record<Meter, number>>;   // Σ meterUnits(kind, quantity).value over usage_events with at ≥ since
// system/billing-customers.ts
export async function setStripeCustomerIfMissing(system: Db, companyId: string, customerId: string): Promise<string>;
// `update companies set stripe_customer_id = $2 where id = $1 and stripe_customer_id is null`, then return the stored value (the first writer wins)
```
  `usageTotals` filters on `usage_events.at >= since` (the `usage_events_company_at_idx` index), and per-row `meterUnits` so `mms` counts ×3 into `sms_segment`; kinds with no meter are skipped; both meters are always present (0).
- **`GET /api/billing`** (`requireCapability('billing')`) → `BillingView`:
  - `status`, `planKey`, `planName` (`planByKey(config, planKey)?.name ?? null`), `trialEndsAt` ISO or null.
  - `hasPaymentMethod` = `hasPaymentMethod({ stripeSubscriptionId, status })`; `canOpenPortal` = a Stripe customer exists.
  - `periodStart` = `(billing_period_start ?? created_at).toISOString()`.
  - `usage`: `[{ meter: 'ai_call_minute', used, included }, { meter: 'sms_segment', used, included }]`, `included` from the plan (`included.ai_call_minutes` / `.sms_segments`), null with no plan.
  - `plans`: every config plan as `PlanSummary` (camelCase).
- **`POST /api/billing/checkout { planKey }`** (`billing` + `requireVerifiedEmail`):
  - unknown plan → 400, field `planKey`, "Pick one of the plans."
  - `stripe_subscription_id` set → 409 "You already have a plan. Use Change plan."
  - `ensureCustomer({ companyId, name, email, existingCustomerId })`, then `setStripeCustomerIfMissing` and use the **returned** id (two tabs at once end on one customer).
  - `trialEnd` = `trial_ends_at` when it is ≥ 48 hours after `deps.clock.now()`, else null (Ruling 7).
  - `successUrl` = `${APP_ORIGIN}/settings/billing?checkout=done`; `cancelUrl` = `${APP_ORIGIN}/settings/billing`; `priceLookupKeys` = `[monthly, ai_call_minute, sms_segment]` of `priceLookupKeys(planKey)`.
  - audit `billing.checkout_started { planKey }` → 200 `{ url }`.
- **`POST /api/billing/portal`** (`billing`): no customer → 409 "Add a card first."; else `createPortal({ customerId, returnUrl: ${APP_ORIGIN}/settings/billing })` → `{ url }`.
- **`POST /api/billing/plan { planKey }`** (`billing`): unknown plan → 400 as above; no subscription → 409 "Pick a plan first."; `changePlan({ subscriptionId, planKey, priceLookupKeys })`, audit `billing.plan_change_requested { planKey }` → 200 `{ ok: true }` (the state follows by webhook).
- **Provider problems** (all three POSTs): `deps.billing.configured === false` → 503 "Billing isn't set up yet."; `BillingUnavailableError` → 503 "We couldn't reach the payment service. Try again in a minute." Messages are constants in `billing-routes.ts` (Ruling 33).

**Tests (`billing-routes.test.ts`)** — `makeTestApp`, `loginAs`; usage rows inserted with T1's `recordUsage` (or SQL):
- `test('owner sees the plan, trial and usage')`: usage `sms_segment` 2, `sms_segment` 1, `mms` 1, `ai_call_minute` 4 → `usage` equals `[{ meter: 'ai_call_minute', used: 4, included: null }, { meter: 'sms_segment', used: 6, included: null }]`; `plans` are the two example plans in camelCase (starter `monthlyPriceCents: 19900`); `status 'trial'`; `canOpenPortal false`.
- `test("office and reps can't see billing")` → 403, 403.
- `test('checkout keeps the trial end')`: set `trial_ends_at` = clock now + 10 days → 200 `{ url: 'https://checkout.stripe.test/c/cs_fake_1' }`; `t.billing.checkouts[0]` equals `{ customerId: 'cus_fake_1', companyId, planKey: 'starter', priceLookupKeys: ['roofline_starter_monthly','roofline_starter_ai_call_minute','roofline_starter_sms_segment'], trialEnd: <trial_ends_at>, successUrl: 'https://app.roofline.test/settings/billing?checkout=done', cancelUrl: 'https://app.roofline.test/settings/billing' }`; `companies.stripe_customer_id = 'cus_fake_1'`.
- `test('a trial ending within 48 hours bills at checkout')` → `trialEnd: null`.
- `test('two checkouts at once make one customer')`: `Promise.all` of two → one distinct stored customer id; both answers 200.
- `test('unknown plan, already subscribed, unconfirmed email')` → 400 (field `planKey`), 409, 403.
- `test('portal needs a customer')` → 409, then after a checkout → `{ url: 'https://billing.stripe.test/p/bps_fake_1' }`.
- `test('change plan asks the provider')`: with `stripe_subscription_id 'sub_1'` set by SQL → `t.billing.planChanges[0].planKey === 'pro'`.
- `test("billing that isn't set up says so")`: swap `t.deps.billing` for T9's `UnconfiguredBillingProvider` (build a second app with it) → 503 "Billing isn't set up yet."; `t.billing.failNext(1)` → 503 with the payment-service message.

**Verify notes:**
- api suite needs Docker (none here): locally `npm run typecheck && npm run lint` and `npx vitest run --project @roofline/shared billing` (prices scan); prove with `ops/bin/ci-check`.
- Commit: `feat(billing): plan and usage summary, Checkout with the trial kept, portal, change plan`.
