### Task 17: CSV export

**Base:** `c1-crm` after Tasks 4 and 5 are merged; F3 **Task 21** (read-only mode: `readOnlyGuard` lets GETs through) must be in `f3-setup` for the read-only test. From T4: `csvCell`, `toCsv`. From F1: `CONSENT_LABELS` (`repos/customers.ts`), `JOB_STAGE_LABELS`, `requireCapability('view_money_totals')`, `audit`, `company_members` view. From T5: stub `routes/export.ts` mounted at `/api/export`.

Read first: `ops/sdd/c1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-core-crm-design.md`.

**Split:** Builder 1 `repos/export.ts`; Builder 2 `routes/export.ts`; Builder 3 the tests.

**Files:**
- Modify: `packages/db/src/repos/export.ts`, `apps/api/src/routes/export.ts`
- Test: `apps/api/test/export.test.ts`

**Interfaces:**
```ts
export async function* customerExportRows(tx: Tx, ctx: TenantContext, batch = 1000): AsyncGenerator<(string | number | boolean | null)[]>;
export async function* jobExportRows(tx: Tx, ctx: TenantContext, batch = 1000): AsyncGenerator<(string | number | boolean | null)[]>;
export const CUSTOMER_EXPORT_HEADERS = ['Name', 'First name', 'Last name', 'Phone', 'Other phones', 'Email', 'Other emails', 'Address', 'City', 'State', 'ZIP', 'Texting', 'Do not contact', 'Tags', 'Source', 'Created', 'Archived'];
export const JOB_EXPORT_HEADERS = ['Customer', 'Address', 'City', 'State', 'ZIP', 'Stage', 'Value', 'Rep', 'Source', 'Lost reason', 'Next step', 'Next step date', 'Stage since', 'Created', 'Archived'];
```
- Plain-word values (stage labels, consent words from `CONSENT_LABELS`, dollars with two decimals), dates `YYYY-MM-DD` in the company zone, no consent evidence, keyset-paged by `id` in batches.
- **Routes** (owner, office: `view_money_totals`; else 403): `GET /api/export/customers.csv`, `GET /api/export/jobs.csv` → `text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="customers-2026-10-12.csv"`, streamed through `csvCell`/CRLF (Task 4); works in read-only mode (GET). Audit `export.customers|jobs`.

**Tests:**
- headers and one row each exact; a customer named `=HYPERLINK("x")` is neutralized; archived included with "Yes"; rep → 403; company B data absent; read-only (`trial_ended`) still 200; 2,500 customers stream in order.

**Carries and rulings:**
- Works in read-only mode (GET); every export writes an audit row.

**Verify notes:**
- CI.
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint` plus focused pure tests; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(export): customers and jobs as formula-safe CSV`
