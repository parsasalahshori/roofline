### Task 18: Stripe adapter and the plan sync script

**Base:** `f3-setup` after Task 9 is merged (T3 is in). From T9: `providers/billing.ts` (`BillingProvider`, `BillingUnavailableError`), the stub `providers/stripe.ts` (`stripeFor(config): BillingProvider | null`, already called by `createBillingProvider`), config `STRIPE_SECRET_KEY`, `BILLING_PLANS_FILE`, and `billing/plans.ts` `billingConfig(deps)`. From T3 (`@roofline/shared`): `BillingConfig`, `PlanConfig`, `Meter`, `METERS`, `METER_EVENT_NAME`, `priceLookupKeys`, `meteredTiers`, `parseBillingConfig`. `stripe` (^23) is already in `apps/api/package.json` and the lockfile (T1) — **do not install anything or edit `package-lock.json`**.
**Carry (T3's scan):** `packages/shared/test/billing.test.ts` fails if any file under `apps/*/src` or `packages/*/src` contains `19900` or `39900`. No source file here may hard-code a price; tests may.

**Split:**
- Builder 1: `apps/api/src/providers/stripe.ts`.
- Builder 2: `apps/api/src/billing/stripe-sync.ts` (`planStripeSync`, `readStripeState`, `applySyncAction`) and `apps/api/src/scripts/sync-stripe-plans.ts`, plus the `sync:stripe-plans` script in `apps/api/package.json`.
- Builder 3: `apps/api/test/stripe-provider.test.ts` and `apps/api/test/stripe-sync.test.ts`, with a recording `fetch`.

**Files:**
- Create: `apps/api/src/billing/stripe-sync.ts`, `apps/api/src/scripts/sync-stripe-plans.ts`
- Modify: `apps/api/src/providers/stripe.ts` (replace the stub), `apps/api/package.json` (`"sync:stripe-plans": "tsx src/scripts/sync-stripe-plans.ts"` only)
- Test: `apps/api/test/stripe-provider.test.ts`, `apps/api/test/stripe-sync.test.ts`

**Interfaces:**
```ts
// providers/stripe.ts
export class StripeBillingProvider implements BillingProvider { constructor(o: { secretKey: string; fetch?: typeof fetch }) }
export function stripeFor(config: Config): BillingProvider | null;   // STRIPE_SECRET_KEY set → StripeBillingProvider; else null
// billing/stripe-sync.ts
export type StripeState = { meters: { id: string; eventName: string }[];
  products: { id: string; planKey: string; name: string }[];
  prices: { id: string; lookupKey: string; unitAmount: number | null; tiers: { up_to: number | null; unit_amount_decimal: string }[] | null; meterId: string | null }[] };
export type SyncAction = { kind: 'create_meter'; meter: Meter } | { kind: 'create_product' | 'rename_product'; planKey: string; name: string }
  | { kind: 'create_price'; lookupKey: string; planKey: string; spec: Record<string, unknown> };
export function planStripeSync(config: BillingConfig, state: StripeState): SyncAction[];
export async function readStripeState(stripe: Stripe): Promise<StripeState>;
export async function applySyncAction(stripe: Stripe, action: SyncAction, state: StripeState): Promise<string>;   // returns the plain line printed
```
- **SDK setup:** `new Stripe(secretKey, { httpClient: Stripe.createFetchHttpClient(fetch), maxNetworkRetries: 2 })` (in tests `maxNetworkRetries: 0` via an option or by passing a fetch that answers once — keep tests fast).
- **Errors:** `Stripe.errors.StripeConnectionError`, any status ≥ 500, and 429 → `BillingUnavailableError("Stripe didn't answer.")`. Other Stripe errors are rethrown as `Error('Stripe refused the request.')` — never Stripe's own message.
- **Prices** are found by `stripe.prices.list({ lookup_keys, active: true })` and cached in memory per lookup key (a `Map` on the instance). A missing lookup key → `Error('A Stripe price is missing; run sync:stripe-plans.')`.
- **`ensureCustomer`:** returns `existingCustomerId` when given; else `customers.create({ name, email: email ?? undefined, metadata: { company_id } }, { idempotencyKey: 'customer:' + companyId })`.
- **`createCheckout`:** `checkout.sessions.create({ mode: 'subscription', customer, client_reference_id: companyId, payment_method_collection: 'always', line_items: [{ price: <monthly id>, quantity: 1 }, { price: <ai id> }, { price: <sms id> }], subscription_data: { metadata: { company_id, plan_key }, ...(trialEnd ? { trial_end: unix(trialEnd) } : {}) }, metadata: { company_id, plan_key }, success_url, cancel_url })` → `{ url: session.url }`. `priceLookupKeys` arrive in the order monthly, ai_call_minute, sms_segment.
- **`createPortal`:** `billingPortal.sessions.create({ customer, return_url })` → `{ url }`.
- **`changePlan`:** `subscriptions.retrieve(id)`; for each item, decide its kind by the current price's `lookup_key` suffix (`_monthly`, `_ai_call_minute`, `_sms_segment`) and swap to the new plan's price of that kind; `subscriptions.update(id, { items: [{ id: item.id, price: newId }, …], proration_behavior: 'create_prorations', metadata: { plan_key } })`.
- **`reportMeterEvent`:** `billing.meterEvents.create({ event_name, payload: { stripe_customer_id: customerId, value: String(value) }, identifier, timestamp: Math.floor(timestamp.getTime() / 1000) })`.
- **`createInvoiceItem`:** `invoiceItems.create({ customer, amount: amountCents, currency: 'usd', description }, { idempotencyKey })` → `{ invoiceItemId: item.id }`.
- **`planStripeSync`** (pure):
  - For each `METERS` meter whose `METER_EVENT_NAME` is not in `state.meters` → `create_meter` (spec: `display_name` "AI call minutes" / "Text segments", `event_name`, `default_aggregation: { formula: 'sum' }`, `customer_mapping: { type: 'by_id', event_payload_key: 'stripe_customer_id' }`, `value_settings: { event_payload_key: 'value' }`).
  - Products are matched by `metadata.roofline_plan` (`state.products[].planKey`): missing → `create_product`; name differs → `rename_product`.
  - For each plan and each of its three lookup keys: missing price, or one whose amount/tiers differ → `create_price` with `transfer_lookup_key: true`:
    - monthly: `{ currency: 'usd', unit_amount: monthly_price_cents, recurring: { interval: 'month' }, lookup_key, transfer_lookup_key: true }`
    - metered: `{ currency: 'usd', billing_scheme: 'tiered', tiers_mode: 'graduated', tiers: meteredTiers(plan, meter), recurring: { interval: 'month', usage_type: 'metered', meter: <meter id or the event name when the meter is being created in this run> }, lookup_key, transfer_lookup_key: true }`
  - Old prices are never archived (live subscriptions use them). Order of actions: meters, products, prices.
- **Script** (`npm run sync:stripe-plans -w @roofline/api -- [--dry-run] [--live]`): `loadConfigOrExit(process.env)`; refuses without `STRIPE_SECRET_KEY` ("Set STRIPE_SECRET_KEY first."); refuses an `sk_live_` key without `--live` ("This is a live key. Pass --live if you mean it."); reads the plan file via `parseBillingConfig`; reads state; prints one plain line per action (e.g. `Create price roofline_starter_sms_segment`), applying each unless `--dry-run`; prints `Stripe matches the plan file.` when there is nothing to do. Uses `readFileSync` of `config.BILLING_PLANS_FILE`.

**Tests:**
- `stripe-provider.test.ts` — a `fetch` that records method, URL, headers and the form body (`URLSearchParams`), and answers canned JSON by URL (`/v1/prices?…lookup_keys…` → three prices with `lookup_key`s and ids `price_m`, `price_ai`, `price_sms`):
  - checkout: the form has `line_items[0][price]=price_m`, `line_items[0][quantity]=1`, `line_items[1][price]=price_ai` and no `line_items[1][quantity]`, `subscription_data[trial_end]=<unix>` when given, and no `trial_end` key when null; the answer's `url` is returned.
  - `Idempotency-Key: customer:<companyId>` on customer create; `existingCustomerId` makes no request.
  - the meter event body has `identifier` and `payload[value]`.
  - the invoice item has `Idempotency-Key: usage:<id>` and `currency=usd`.
  - a 503 → `BillingUnavailableError`; a 400 → an error whose message is not Stripe's.
  - the price list is fetched once for two checkouts.
- `stripe-sync.test.ts` (pure, against the example config read with `parseBillingConfig`):
  - empty state → 2 `create_meter`, 2 `create_product`, 6 `create_price`.
  - a state matching the example config → `[]`.
  - starter `sms_segment` overage changed from 3 to 4 (in the config) → exactly one `create_price` for `roofline_starter_sms_segment`, with `spec.transfer_lookup_key === true`.
  - a product renamed → one `rename_product`.

**Verify notes:**
- api project needs Docker for its globalSetup (none here): locally `npm run typecheck && npm run lint` and `npx vitest run --project @roofline/shared billing` (the no-hard-coded-prices scan); prove the rest with `ops/bin/ci-check`.
- Commit: `feat(billing): Stripe adapter and a plan sync script driven by the plan config`.
