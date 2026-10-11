### Task 22: Usage reporting: meter batches and invoice items

**Base:** `f3-setup` after Task 9 is merged (T3 is in). From T1: `usage_events` columns `meter_batch_id uuid`, `stripe_invoice_item_id text`, `description`, `reported_to_stripe_at`, `quantity`/`unit_cost_cents` numeric (mode number), `at`; index `usage_events_unreported_idx (company_id) where reported_to_stripe_at is null`; app_system `SELECT (id, company_id, kind, reported_to_stripe_at)` + `app_system_all` policy; tenant full SELECT/INSERT/UPDATE; `recordUsage` in `packages/db/src/repos/usage.ts` (keep it); placeholder `packages/db/src/system/usage-fanout.ts`. From T9: stub `apps/api/src/jobs/scheduler/report-usage.ts` (`reportUsage(deps, now)`, in `SCHEDULES` every minute), `deps.billing` (`TestApp.billing` = `FakeBillingProvider` with `meterEvents`, `invoiceItems`, `failNext`), `billing/plans.ts` `billingConfig(deps)`. From T3: `Meter`, `METERS`, `METER_EVENT_NAME`, `INVOICE_KINDS`, `meterUnits`, `invoiceAmountCents`, `UsageKind`.
**Plan conflict (proposed Ruling Z):** the plan says step 1 reads `billingFacts.stripeCustomerId`, but `billingFacts` is T19's (`repos/billing.ts`), built in parallel. This task reads the customer id with its own `stripeCustomerIdFor(tx, ctx)` in `repos/usage.ts`, so T22 does not wait for T19 — cost if wrong: one duplicated 4-line query.

**Split:**
- Builder 1: `packages/db/src/repos/usage.ts` (batches, invoicing, `stripeCustomerIdFor`).
- Builder 2: `packages/db/src/system/usage-fanout.ts` and `apps/api/src/jobs/scheduler/report-usage.ts`.
- Builder 3: `apps/api/test/report-usage.test.ts`.

**Files:**
- Modify: `packages/db/src/repos/usage.ts` (append), `packages/db/src/system/usage-fanout.ts`, `apps/api/src/jobs/scheduler/report-usage.ts`
- Test: `apps/api/test/report-usage.test.ts`
- Do not touch: `repos/billing.ts` (T19), `jobs/worker.ts`.

**Interfaces:**
```ts
// repos/usage.ts
export type MeterBatch = { batchId: string; meter: Meter; value: number; rows: number };
export async function openMeterBatches(tx: Tx, ctx: TenantContext): Promise<MeterBatch[]>;
export async function markBatchReported(tx: Tx, ctx: TenantContext, batchId: string, now: Date): Promise<number>;
export type InvoiceUsageRow = { id: string; kind: UsageKind; quantity: number; unitCostCents: number; description: string };
export async function unbilledInvoiceUsage(tx: Tx, ctx: TenantContext): Promise<InvoiceUsageRow[]>;
export async function markInvoiced(tx: Tx, ctx: TenantContext, usageId: string, invoiceItemId: string, now: Date): Promise<void>;
export async function stripeCustomerIdFor(tx: Tx, ctx: TenantContext): Promise<string | null>;
// system/usage-fanout.ts
export async function companiesWithUnreportedUsage(system: Db): Promise<string[]>;   // distinct company_id where reported_to_stripe_at is null (only the granted columns)
// jobs/scheduler/report-usage.ts
export async function reportUsage(deps: AppDeps, now: Date): Promise<void>;
```
- **`openMeterBatches`:**
  - One statement assigns a new batch id per meter to every unreported metered row (`kind in ('sms_segment','mms')` → the `sms_segment` meter; `ai_call_minute` → its own) whose `meter_batch_id` is null: e.g. `update usage_events set meter_batch_id = case when kind = 'ai_call_minute' then $ai else $sms end where company_id = … and reported_to_stripe_at is null and meter_batch_id is null and kind in (…)` with two fresh `randomUUID()`s.
  - Then returns every open batch (batch id set, `reported_to_stripe_at` null), grouped by batch, with `value` = Σ `meterUnits(kind, quantity).value` (computed in TS per row so `mms` ×3 and `ceil` match T3) and `rows` = row count. Batches with no rows are not returned.
- **`markBatchReported`:** sets `reported_to_stripe_at = now` on the batch's rows; returns the count.
- **`unbilledInvoiceUsage`:** `kind in INVOICE_KINDS`, `stripe_invoice_item_id is null`, `unit_cost_cents is not null`; `description ?? ''`.
- **`markInvoiced`:** sets `stripe_invoice_item_id` and `reported_to_stripe_at = now`.
- **`reportUsage`,** for each company from `companiesWithUnreportedUsage(deps.pools.system)`, each inside its own `try/catch` that calls `deps.logError(err, 'report-usage')` and moves on:
  1. `stripeCustomerIdFor` null → skip the company.
  2. For each open batch: `deps.billing.reportMeterEvent({ eventName: METER_EVENT_NAME[meter], customerId, value, identifier: batchId, timestamp: now })`, then `markBatchReported` (own short tenant transaction; no provider call inside a transaction).
  3. For each invoice row: `createInvoiceItem({ customerId, amountCents: invoiceAmountCents(kind, quantity, unitCostCents, billingConfig(deps)), description, idempotencyKey: 'usage:' + id })`, then `markInvoiced`.
  - A throw leaves the rest for the next minute; resending a batch is safe because its id is Stripe's `identifier`, and an invoice item because of its idempotency key.
  - Skip silently when `deps.billing.configured === false`.

**Tests (`report-usage.test.ts`)** — `makeTestApp`; `stripe_customer_id = 'cus_fake_1'` on Acme by SQL; rows via `recordUsage` inside `withTenant`:
- `test('usage becomes one meter event per meter and invoice items with the right amounts')`: rows `sms_segment` 2, `sms_segment` 1, `mms` 1, `ai_call_minute` 4, `exact_report` 1 × 4500 "Exact roof report — 812 Oak St", `texting_registration_fee` 1 × 4400 "Texting registration: business check", `phone_number_month` 1 × 115 "Texting number (402) 555-0100 — October 2026". After `reportUsage(t.deps, now)`: `t.billing.meterEvents` sorted by event name `toMatchObject([{ eventName: 'roofline_ai_call_minute', customerId: 'cus_fake_1', value: 4 }, { eventName: 'roofline_sms_segment', customerId: 'cus_fake_1', value: 6 }])`; `t.billing.invoiceItems` amounts `[5400, 4400, 115]` with those descriptions and `usage:<id>` keys; every row has `reported_to_stripe_at`; the invoice rows have `stripe_invoice_item_id`.
- `test('a second run reports nothing new')`.
- `test('a crash after reporting resends the same batch, which the provider ignores')`: call `openMeterBatches` and `t.billing.reportMeterEvent` by hand with no mark; then `reportUsage` → still 2 meter events in all; the rows are marked.
- `test('companies without a customer are skipped; one failure does not stop the others')`: B has usage and `cus_fake_2`, A has none set → B reported; then `t.billing.failNext(1)` with both set → one company's rows stay unreported, the other's are reported, `t.logged` has one entry.
- `test("company B's usage never goes to A's customer")`.

**Verify notes:**
- api/db suites need Docker (none here): locally `npm run typecheck && npm run lint`; prove with `ops/bin/ci-check`.
- Commit: `feat(billing): batched meter events and invoice items, idempotent end to end`.
