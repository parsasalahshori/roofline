### Task 24: Import job: creating customers, homes and jobs

**Base:** the Task 23 branch after review (or `f3-setup` once T23 is merged; T7 and T9 are then in). From T23 (`packages/db/src/repos/imports.ts`): `ImportRow`, `getImport`, `importCells`, `existingIndexFor`, `skippedImportRows`, and the routes that start/retry the job. From T7: `normalizeRow`, `NormalizedRow`, `RowSkip`, `planImport`, `ExistingCustomer` (`apps/api/src/imports/{normalize,plan}.ts`), shared `consentAttestationText`. From T9: stub `apps/api/src/imports/run.ts` (`runImport(deps, companyId, importId, meta)`, wired in `JOB_HANDLERS['import-customers']`), `JobMeta`, `deps.geocoder` (`TestApp.geocoder` = `FakeGeocoder` with `batches`; `/outage/i` gives `null` per item in a batch), `deps.jobs` (`InlineJobs.drain`, `errors`). From T1: placeholder `packages/db/src/repos/import-apply.ts` (in the barrel). `normalizeAddressKey` in `@roofline/shared`.

**Split:**
- Builder 1: `packages/db/src/repos/import-apply.ts`.
- Builder 2: `apps/api/src/imports/run.ts`.
- Builder 3: `apps/api/test/import-run.test.ts`.

**Files:**
- Modify: `packages/db/src/repos/import-apply.ts`, `apps/api/src/imports/run.ts`
- Test: `apps/api/test/import-run.test.ts`
- Do not touch: `repos/imports.ts`, `routes/imports.ts` (T23), T7's files, `repos/customers.ts`/`properties.ts`/`jobs.ts`.

**Interfaces:**
```ts
// repos/import-apply.ts
export const IMPORT_CHUNK = 250;
export async function claimImport(tx: Tx, ctx: TenantContext, id: string, now: Date): Promise<ImportRow | null>;     // queued → processing (started_at kept); processing stays (a resumed run); else null
export async function hasPlannedSkips(tx: Tx, ctx: TenantContext, id: string): Promise<boolean>;
export async function writePlannedSkips(tx: Tx, ctx: TenantContext, id: string, skips: readonly { row: number; reason: string }[]): Promise<void>;   // outcome 'skipped', reason
export async function nextImportChunk(tx: Tx, ctx: TenantContext, id: string, size: number): Promise<{ rowNumber: number; cells: string[] }[]>;   // outcome null, row order
export type ChunkWrite = { rows: { rowNumber: number; normalized: NormalizedRow; match: ExistingCustomer | null; consent: ConsentStatus; consentChanged: boolean;
  geo: GeocodeResult | null }[]; createJobs: boolean; fileName: string; attested: { userId: string; text: string } | null; importId: string; createdByUserId: string | null };
export async function applyImportChunk(tx: Tx, ctx: TenantContext, w: ChunkWrite, now: Date): Promise<{ created: number; updated: number; jobs: number; located: number; notLocated: number }>;
export async function saveImportProgress(tx: Tx, ctx: TenantContext, id: string, counts: ImportCounts, now: Date): Promise<void>;
export async function finishImport(tx: Tx, ctx: TenantContext, id: string, counts: ImportCounts, now: Date): Promise<void>;
export async function failImport(tx: Tx, ctx: TenantContext, id: string, errorPlain: string, now: Date): Promise<void>;
// imports/run.ts
export async function runImport(deps: AppDeps, companyId: string, importId: string, meta: JobMeta): Promise<void>;
```
- **Layer note:** `packages/db` cannot import from `apps/api`. Declare `NormalizedRow`, `ExistingCustomer` and `GeocodeResult`-shaped local types in `import-apply.ts` (structurally identical; TS checks the call in `run.ts`), or move only the type declarations — do not move T7's functions.
- **`runImport`** (ctx = `systemContext(companyId)`):
  1. `claimImport`; null → return.
  2. First claim (no planned skips yet: `hasPlannedSkips` false): plan the whole file — `importCells`, `normalizeRow` per row with the stored mapping, `planImport` against `existingIndexFor`, `attested` = `consent_attested` — and `writePlannedSkips` for every `skip`; store the plan's counts (`saveImportProgress`). On a resumed claim, reuse the stored counts.
  3. Loop until `nextImportChunk(IMPORT_CHUNK)` (short transaction) is empty:
     - normalize the chunk's rows; geocode the new addresses with `deps.geocoder.geocodeMany(addressTexts)` **outside any transaction** (`"line, city, ST zip"`); a thrown batch → no geo for the chunk (all counted not located); skip geocoding when `deps.geocoder.configured === false`.
     - `applyImportChunk` in one transaction. It re-takes the chunk's rows with `SELECT … FOR UPDATE SKIP LOCKED where outcome is null` (a second runner cannot write them), and re-matches each row against the database with `existingIndexFor` (customers added meanwhile are updated, not duplicated), recomputing consent with `importConsent`.
     - add the chunk's numbers to `counts` (`processed`, `new`→created, `updated`, `jobs`, `located`, `notLocated`) and `saveImportProgress`.
  4. `finishImport`: `status 'done'`, `finished_at`, `counts`, `error_file_url = /api/imports/<id>/skipped.csv` when `counts.skipped > 0`, audit `import.finished { importId, counts }`.
  5. A throw: when `meta.lastAttempt` → `failImport` with "We couldn't finish this import. Rows already imported are saved. Try again from Setup." (status `failed`, `error_plain`); in every case rethrow.
- **`applyImportChunk`** — bulk writes, **not** `createCustomer`/`createProperty`/`createJob` (those write a per-customer audit row; the plan wants none):
  - **New customers:** `display_name`, `first_name`, `last_name`, `phones` = `[{ e164, primary: i === 0 }]`, `emails`, `source 'import'`, `created_by_user_id null`. Consent per the plan: `attested` → status `attested`, source `import`, by = `attested.userId`, at now, evidence `{ import_id, text }`; `express` → source `import`, by = `createdByUserId`, at now, evidence `{ import_id }`; `none` → nothing set.
  - **Matched customers:** append missing phones and emails; set `first_name`/`last_name` only when empty; raise consent only when `consentChanged` (same source/by/at/evidence rules). Never touch `do_not_contact`.
  - **Properties:** `address_key = normalizeAddressKey(line, zip)`; `insert … on conflict (company_id, address_key) do nothing`; an existing address with `customer_id is null` is claimed for this customer; one of another customer is left alone. Geo writes `geom`, `geocode_source` (`result.source`), `geocode_accuracy` (`String(accuracy)`), `timezone` (only when `isTimeZone`); counts `located`/`notLocated` for rows with an address.
  - **Jobs:** only when `createJobs` (a `stage` column is mapped), the row has a stage and a property, and that property has no open job (`stage in ('lead','inspection','proposal','won')`, not archived): `stage`, `source 'import'`, `customer_id`, `property_id`.
  - **Timeline:** activity `customer.imported`, summary `Imported from ${fileName}`; activity `customer.note` with the note (first 500 characters) when there is one. (`addActivity` per row is acceptable; a multi-row insert into `activities` is better.)
  - **Row outcomes:** `import_rows.outcome` `created`/`updated`, `customer_id`.
  - Returns the chunk's numbers.

**Tests (`import-run.test.ts`)** — upload and start through T23's routes, then `await t.jobs.drain(t.deps)`:
- `test('the 1,000-row file gives the right new, updated and skipped counts')`: seed the 50 existing customers (`buildImportFixture().existing`), upload, start attested → `imports.status 'done'`; counts `new 850, updated 50, skipped 100`; 900 customers; 900 properties; 0 jobs.
- `test('attested customers have a full consent record')`: a new one → `attested`, source `import`, by the owner, at clock now, evidence `{ import_id, text: consentAttestationText('Acme Roofing') }`.
- `test('matched customers who were revoked, written or do-not-contact keep that status')`: the 10 / 10 / 10 unchanged; `do_not_contact` still true.
- `test('an unchecked import gives express only')`.
- `test('jobs only when a stage column is mapped')`: a 5-row file with Stage `Lead, Sold, Inspection, weird, ''` → 4 jobs (`lead`, `won`, `inspection`, `lead`), all `source 'import'`; the same file with Stage unmapped (PATCH) → 0 jobs.
- `test('addresses are placed on the map in batches')`: after the 1,000-row import every `t.geocoder.batches` entry has ≤ 250 addresses; a separate 3-row file with one `12 Outage Ave, Omaha, NE 68102` → that home has no `geom`; `counts.notLocated 1`, `counts.located 2`.
- `test('a crash halfway resumes without duplicates')`: the owner client adds a trigger on `import_rows` that raises once (a one-row flag table) when a row numbered above 252 gets its outcome (the second chunk's write) → after `drain` the job ran twice; 900 customers; `t.jobs.errors.length === 1`. Drop the trigger in `finally`.
- `test('running it again does nothing')`: a second `runImport` on a `done` import changes nothing.
- `test('the skipped-rows file lists every skipped row')`: `GET /api/imports/<id>/skipped.csv` → 101 non-empty lines (the header plus 100 skipped rows); the line for row 902 starts `902,Duplicate of row 2,`.
- `test('the audit has the import and the consent confirmation')`: `import.started`, `import.consent_attested`, `import.finished`.
- `test('the last failed attempt marks it failed with a plain reason')`: a geocoder that throws a non-Unavailable error in `applyImportChunk` path (or a trigger that always raises) → after 5 attempts `status 'failed'`, `error_plain` the message.

**Verify notes:**
- api suite needs Docker (none here): locally `npm run typecheck && npm run lint`; prove with `ops/bin/ci-check`.
- Commit: `feat(import): background import with geocoded homes, consent rules and resumable chunks`.
