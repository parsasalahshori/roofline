### Task 23: Import API: upload, mapping, preview, start, skipped rows

**Base:** `f3-setup` after Tasks 9 and **7** are merged (sibling team building T7 now). From T6: `parseUpload`, `ImportFileError` (`imports/parse.ts`), `autoMap` (`imports/mapping.ts`), shared `ImportMapping`, `ImportCounts`, `ImportView`, `ImportPreviewRow`, `IMPORT_FIELDS`, `MAX_IMPORT_ROWS`. From T7: `normalizeRow` (`imports/normalize.ts`), `planImport`, `previewRows`, `ExistingIndex`, `ExistingCustomer`, `ImportPlan` (`imports/plan.ts`), shared `consentAttestationText`, and the test fixture `buildImportFixture()` (`apps/api/test/fixtures/import-1000.ts`). From T9: stub `apps/api/src/routes/imports.ts` (`importRoutes(deps): Router`, mounted at `/api/imports`; **may not** import `@roofline/db/system`), `deps.jobs` (`TestApp.jobs` = `InlineJobs`). From T1: `imports`/`import_rows` tables (columns above in `schema/tenant.ts`), GIN indexes `customers_phones_gin` (`jsonb_path_ops`) and `customers_emails_gin`, placeholder `packages/db/src/repos/imports.ts` (in the barrel). `requireCapability('import')` (owner only).

**Split:**
- Builder 1: `packages/db/src/repos/imports.ts`.
- Builder 2: `apps/api/src/imports/preview.ts` and `apps/api/src/imports/skipped-csv.ts`.
- Builder 3: `apps/api/src/routes/imports.ts` and the tests.

**Files:**
- Create: `apps/api/src/imports/preview.ts`, `apps/api/src/imports/skipped-csv.ts`
- Modify: `packages/db/src/repos/imports.ts`, `apps/api/src/routes/imports.ts`
- Test: `apps/api/test/imports-api.test.ts`, `apps/api/test/skipped-csv.test.ts`
- Do not touch: T6/T7's `imports/{parse,mapping,normalize,plan}.ts`, `imports/run.ts` and `repos/import-apply.ts` (T24), `app.ts`.

**Interfaces:**
```ts
// repos/imports.ts
export type ImportRow = typeof imports.$inferSelect;
export async function createImport(tx: Tx, ctx: TenantContext, i: { fileName: string; headers: string[]; mapping: ImportMapping; rowCount: number }, now: Date): Promise<ImportRow>;   // created_by_user_id = ctx.userId
export async function insertImportRows(tx: Tx, ctx: TenantContext, importId: string, rows: readonly string[][]): Promise<void>;   // chunks of 1000; row_number = index + 2
export async function getImport(tx: Tx, ctx: TenantContext, id: string): Promise<ImportRow | null>;
export async function setImportMapping(tx: Tx, ctx: TenantContext, id: string, mapping: ImportMapping, counts: ImportCounts, now: Date): Promise<boolean>;   // only while 'uploaded'
export async function startImport(tx: Tx, ctx: TenantContext, id: string, i: { attested: boolean; text: string | null }, now: Date): Promise<boolean>;   // uploaded → queued (sets consent_attested/consent_text/attested_by_user_id/attested_at, started_at); false otherwise
export async function retryImport(tx: Tx, ctx: TenantContext, id: string, now: Date): Promise<boolean>;   // failed → queued, error_plain null
export async function importCells(tx: Tx, ctx: TenantContext, id: string): Promise<string[][]>;   // in row_number order
export async function existingIndexFor(tx: Tx, ctx: TenantContext, phones: readonly string[], emails: readonly string[]): Promise<ExistingIndex>;
export async function skippedImportRows(tx: Tx, ctx: TenantContext, id: string): Promise<{ row: number; reason: string; cells: string[] }[]>;
export async function listImports(tx: Tx, ctx: TenantContext, limit: number): Promise<ImportRow[]>;   // newest first
// imports/preview.ts
export async function buildImportView(tx: Tx, ctx: TenantContext, row: ImportRow, attestedPreview: boolean): Promise<ImportView>;
// imports/skipped-csv.ts
export function skippedCsv(headers: readonly string[], rows: readonly { row: number; reason: string; cells: string[] }[]): string;
```
- **`ExistingIndex` type import:** `packages/db` cannot import from `apps/api`. Declare a structurally identical local type in `repos/imports.ts` (`ImportExistingIndex = { byPhone: ReadonlyMap<string, ImportExisting>; byEmail: … }`, `ImportExisting = { id; status: ConsentStatus; doNotContact; optedOut }`) and let TS check it against T7's `ExistingIndex` where `preview.ts` passes it to `planImport`.
- **`existingIndexFor`:** non-archived customers of the company where `phones @> ANY(<array of '[{"e164":"+1…"}]'::jsonb>)` or `emails ?| <text[]>` (so the GIN indexes apply; empty inputs skip that half); `optedOut` = the customer's matching phone is in `opt_outs`; `doNotContact` = `do_not_contact`; `status` = `sms_consent_status`. `byPhone` keys every e164 of each customer; `byEmail` every lowercased email.
- **`buildImportView`:** before start (`uploaded`): `importCells` → `normalizeRow` per row with the stored mapping → `existingIndexFor` (all phones/emails of normalized rows) → `planImport(rows, index, attestedPreview)` → `counts`, `preview = previewRows(plan)`. After start: `counts` = the stored `imports.counts` (the job's), `preview` = `[]`. `progress = { processed: counts.processed ?? 0, total: rowCount }`; `skippedDownloadUrl` = `error_file_url` when `done`; dates ISO.
- **Routes** (all `requireCapability('import')`; messages as constants in `routes/imports.ts`):
  - **`POST /api/imports?fileName=<name>`:** route-level `express.raw({ type: () => true, limit: '10mb' })` — the client sends `application/octet-stream` (a JSON content type would meet the global 256 KB JSON parser first). A body-parser 413 (`err.type === 'entity.too.large'`) → 413 "That file is too big. The most we can take is 10 MB." (a small error middleware on this router). Missing/blank `fileName` → 400 field `file` "Please upload a .csv or .xlsx file.". Flow: `parseUpload` → `autoMap` → `createImport` + `insertImportRows` in one tenant transaction → 201 `ImportView` (preview unchecked). `ImportFileError` → 400 with its message, field `file`.
  - **`PATCH /api/imports/:id { mapping }`:** every value an integer `0 ≤ i < headers.length` and keys in `IMPORT_FIELDS`, else 400 field `mapping` "Match each column once."; not `uploaded` → 409 "This import already started."; recompute counts (unchecked) → `setImportMapping` → 200 `ImportView`.
  - **`GET /api/imports/:id?attested=true|false`** → `ImportView` (default false). Unknown id / other company → 404.
  - **`POST /api/imports/:id/start { consentAttested: boolean, consentText?: string }`:** mapping needs `name` or (`firstName` or `lastName`) → else 400 field `mapping` "Match a column to Name."; needs `phone` or `email` → else 400 field `mapping` "Match a column to Phone or Email."; when attested, `consentText` must equal `consentAttestationText(company.name)` → else 400 field `consentText` "Please confirm the consent statement as shown."; `startImport` false → 409 "This import already started."; audit `import.started { importId }` plus `import.consent_attested { importId, text }` when attested; then `deps.jobs.send('import-customers', { companyId, importId }, { singletonKey: importId })` → 202 `ImportView`.
  - **`POST /api/imports/:id/retry`:** `retryImport` false → 409 "Only a failed import can be tried again."; else send the job as above → 202 `ImportView`.
  - **`GET /api/imports/:id/skipped.csv`:** not `done` → 409 "This import isn't finished yet."; else `text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="skipped-rows.csv"`, body `skippedCsv(headers, skippedImportRows(...))`.
  - **`GET /api/imports`** → `{ imports: ImportView[] }`, the last 10, without a preview.
- **`skippedCsv`:** header `Row,Reason,<the file's headers>`; RFC 4180 quoting (quote when a value has `,`, `"`, CR or LF; double inner quotes); any cell or header starting with `=`, `+`, `-`, `@`, a tab or a CR is prefixed with `'` before quoting; CRLF line endings; a trailing CRLF.

**Tests:**
- `imports-api.test.ts` (seed the 50 existing customers from `buildImportFixture().existing` — phones, consent, `do_not_contact`, and an `opt_outs` row for the revoked ones; upload `Buffer.from(csv)` with `.set('Content-Type', 'application/octet-stream')` to `/api/imports?fileName=customers.csv`):
  - `test('upload the 1,000-row file: auto-mapped, with exact counts and 20 preview rows')`: 201; `rowCount 1000`; `counts.new 850, updated 50, skipped 100`; `preview.length 20`; `mapping` equals `{name:0, phone:1, email:2, street:3, city:4, state:5, zip:6, notes:7}`.
  - `test('the checked preview shows the consent outcome')`: `?attested=true` → `consent { attested: 870, express: 0, unchanged: 10, optedOutKept: 20 }`.
  - `test('changing the mapping changes the preview')`: PATCH without `phone` → `skippedBy { noName: 15, noContact: 985, badPhone: 0, duplicate: 0 }`.
  - `test('start queues one job, even when clicked twice')`: first → 202, second → 409; `t.jobs.sent.length === 1`; the import is `queued`.
  - `test('the consent statement must match')` → 400 field `consentText`.
  - `test('office and reps cannot import; company B cannot see it')` → 403, 403, 404.
  - `test('too big, wrong type, too many rows')`: 10 MB + 1 byte → 413 with the message; `x.pdf` → 400 "Please upload a .csv or .xlsx file."; 20,001 rows → 400 with the 20,000 message.
  - `test('an Excel file uploads too')`: an exceljs workbook built in the test → 201 with its headers.
  - `test('skipped rows only after it finishes')` → 409.
- `skipped-csv.test.ts`: `=SUM(A1)` → `'=SUM(A1)`; `+1 402` → `'+1 402`; a cell `Lee, "Ann"` → `"Lee, ""Ann"""`; the first line is `Row,Reason,Name,Phone`; lines end in CRLF.

**Verify notes:**
- api suite needs Docker (none here): locally `npm run typecheck && npm run lint` (the boundary rule must pass for `routes/imports.ts`); prove with `ops/bin/ci-check`.
- Commit: `feat(import): upload, map, preview with consent counts, start once, skipped-rows download`.
