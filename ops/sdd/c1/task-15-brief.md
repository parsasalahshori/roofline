### Task 15: Pricebook and quotes API

**Base:** `c1-crm` after Tasks 4 and 5 are merged (Task 6's `updateJob` stage rules are used by `finalizeQuote`; merge T6 first or call `updateJob` signature-only). From F1 `packages/shared/src/pricing.ts`: `pricebookSchema`, `Pricebook`, `defaultPricebook`, `scopeSchema`, `Scope`, `defaultScope`, `calculateQuote`, `Calculation`, `money`. From T5: placeholder `listQuoteSummaries`, stubs `routes/{pricebook,quotes}.ts` (`pricebookRoutes`, `quoteRoutes`, `jobQuoteRoutes` with `mergeParams`). From T4: `PricebookView`, `QuoteDefaults`, `QuoteMeasurement`, `QuoteView`, `QuoteSummary`.

Read first: `ops/sdd/c1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-core-crm-design.md`.

**Split:** Builder 1 `repos/pricebook.ts` and `routes/pricebook.ts`; Builder 2 `repos/quotes.ts` and `routes/quotes.ts`; Builder 3 the tests.

**Files:**
- Modify: `packages/db/src/repos/{pricebook,quotes}.ts` (replacing Task 5's placeholder `listQuoteSummaries`), `apps/api/src/routes/{pricebook,quotes}.ts`
- Test: `apps/api/test/{pricebook,quotes}.test.ts`

**Interfaces:**
```ts
// repos/pricebook.ts
export const DEFAULT_QUOTE_DEFAULTS: QuoteDefaults;   // from v1 defaultScope: waste 12, markup 25, tax 0, material 'architectural'
export async function getPricebook(tx: Tx, ctx: TenantContext): Promise<PricebookView>;   // no row → defaultPricebook, isExample true
export async function savePricebook(tx: Tx, ctx: TenantContext, p: { prices: Pricebook; defaults: QuoteDefaults }, now: Date): Promise<PricebookView>;
// repos/quotes.ts
export async function nextQuoteNumber(tx: Tx, ctx: TenantContext): Promise<string>;   // upsert quote_counters … returning; 'Q-' + 4-digit pad (grows past 9999)
export async function createQuote(tx: Tx, ctx: TenantContext, i: { jobId: string; measurement: QuoteMeasurement; scope: Scope; notes: string | null }, now: Date, timeZone: string): Promise<QuoteView>;   // snapshot prices; calculation = calculateQuote(scope, prices); valid_until = today + 30 days
export async function updateQuote(tx: Tx, ctx: TenantContext, id: string, p: Partial<{ measurement: QuoteMeasurement; scope: Scope; notes: string | null; refreshPrices: boolean }>, now: Date): Promise<QuoteView | 'final' | null>;
export async function finalizeQuote(tx: Tx, ctx: TenantContext, id: string, now: Date): Promise<QuoteView | 'final' | null>;   // sets the job's value_cents when null (through updateJob, activity "Value set from quote Q-0003")
export async function copyQuote(tx: Tx, ctx: TenantContext, id: string, now: Date, timeZone: string): Promise<QuoteView | null>;   // a new draft with today's prices
export async function getQuote(tx: Tx, ctx: TenantContext, id: string): Promise<QuoteView | null>;
export async function listQuoteSummaries(tx: Tx, ctx: TenantContext, jobId: string): Promise<QuoteSummary[]>;
```
- **Scope from measurement:** the quote's `scope.areaSqFt/areaType/pitch` always equal the measurement's; other scope fields default from the pricebook `defaults`.
- **Visibility:** a quote is visible when its job is (`jobScope`); editing as the job. Reps never see the pricebook route; quotes they can see show prices (the quote is the job's).
- **Routes:** `GET /api/pricebook` (owner, office) → `PricebookView`; `PUT` (`company_admin`) → validates `pricebookSchema` (field `prices.<key>` "Enter an amount from 0 to 100,000.") and defaults; audit `pricebook.updated`. `GET /api/jobs/:jobId/quotes` → `{ quotes: QuoteSummary[] }`; `POST /api/jobs/:jobId/quotes { measurement, scope?, notes? }` → 201 `QuoteView` (activity on the job "Quote Q-0001 started"); `GET/PATCH /api/quotes/:id` (PATCH on a final quote → 409 "This quote is final. Copy it to make changes."); `POST /api/quotes/:id/finalize` → `QuoteView` (activity "Quote Q-0001 marked final · $14,250"); `POST /api/quotes/:id/copy` → 201.
- **Carry (F3 T3's scan):** no hard-coded prices in source except v1's ported `defaultPricebook` (already in `pricing.ts`, whose numbers are not the scanned ones).

**Tests:**
- pricebook default and save; office reads, can't save; rep 403 on the pricebook; a quote's calculation equals `calculateQuote` for v1's default scope (assert `totalCents` against the ported test's value); numbering `Q-0001`, `Q-0002` per company, and concurrently two creates get two numbers; changing the pricebook doesn't change an existing final quote; PATCH final → 409; finalize sets the job value when empty, not when set; copy uses today's prices; rep scope and company B 404.

**Carries and rulings:**
- F3 T3's scan: no `src` file may contain `19900` or `39900`; `defaultPricebook` in `pricing.ts` is the only home of v1's example prices.

**Verify notes:**
- CI.
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint` plus focused pure tests; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(quotes): company pricebook and single-option job quotes, frozen when final`
