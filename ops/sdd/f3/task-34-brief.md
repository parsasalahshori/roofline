### Task 34: Web: the import wizard

**Base:** `f3-setup` after Tasks 29 and 30 are merged (T6, T7 are in; T23/T24 give the real API, though the unit tests stub `fetch`). From T30: placeholder `features/imports/ImportWizard.tsx` (routed at `/settings/setup/import` and `/settings/setup/import/:importId`, inside the Settings window with the Setup tab current), empty `features/imports/api.ts`, `copy/import.ts` (`importCopy`). From T29: `FilePicker`, `Checkbox`, `ProgressBar`. From T6/T7 (`@roofline/shared`): `ImportView`, `ImportMapping`, `IMPORT_FIELDS`, `ImportField`, `ImportCounts`, `SkipKey`, `consentAttestationText`. API (T23): `POST /api/imports?fileName=` (raw body) → 201 `ImportView`; `PATCH /api/imports/:id { mapping }`; `GET /api/imports/:id?attested=`; `POST /api/imports/:id/start { consentAttested, consentText? }` → 202 (409 when already started); `POST /api/imports/:id/retry`; `GET /api/imports/:id/skipped.csv`. From F2: `apiFetch`, `ApiError` (`api/client.ts`), `useCompany` (company name for the consent text).

**Split:**
- Builder 1: `UploadStep.tsx`, `MappingStep.tsx`.
- Builder 2: `PreviewStep.tsx`, `ConsentStep.tsx`.
- Builder 3: `ProgressStep.tsx` (progress and summary), `ImportWizard.tsx`, `features/imports/api.ts`, `copy/import.ts`, `apps/web/test/import-wizard.test.tsx`.

**Files:**
- Create: `apps/web/src/features/imports/{UploadStep,MappingStep,PreviewStep,ConsentStep,ProgressStep}.tsx` (+ one `ImportWizard.module.css`)
- Modify: `apps/web/src/features/imports/{ImportWizard.tsx,api.ts}`, `apps/web/src/copy/import.ts`
- Test: `apps/web/test/import-wizard.test.tsx`
- Do not touch: `api/client.ts` (export nothing new from it; map errors locally), `router.tsx`.

**Interfaces:**
- **Hooks (`features/imports/api.ts`):**
  - `uploadImport(file: File): Promise<ImportView>`: `fetch('/api/imports?fileName=' + encodeURIComponent(file.name), { method: 'POST', body: file, credentials: 'same-origin', headers: { Accept: 'application/json', 'Content-Type': 'application/octet-stream' } })` — **always octet-stream** (proposed Ruling AJ: a JSON or form content type would meet the server's global parsers; T23 reads any type raw). Non-2xx → `throw new ApiError(...)` built the way `apiFetch` builds it (status, `error`, `field`); a network failure → the F2 network message (`copy/errors.ts`).
  - `useUploadImport()` (mutation wrapping it).
  - `useImport(id, attested: boolean)`: query `['import', id, attested]`, `refetchInterval` 2000 while `status` is `queued` or `processing`, else false.
  - `useSetMapping(id)`, `useStartImport(id)` (sets `['import', id, *]` data to the answer), `useRetryImport(id)`.
- **`ImportWizard`:** no `:importId` → `UploadStep`. With an id: status `uploaded` → local step state `mapping` → `preview` → `consent` (Back/Next ghost/primary buttons); `queued`/`processing` → `ProgressStep` (progress); `done`/`failed` → `ProgressStep` (summary).
  - **Upload:** `FilePicker` (`label` "Customer spreadsheet", `buttonLabel` "Choose a file", `dropLabel` "or drop it here", `accept=".csv,.xlsx"`, `help` "CSV or Excel, up to 20,000 rows.", `busy`, `error` = the server message). Success → `navigate(view.id)` (relative, so `/settings/setup/import/<id>`).
  - **Mapping:** one `Select` per `IMPORT_FIELDS` entry (labels: Name, First name, Last name, Phone, Second phone, Email, Street, City, State, ZIP, Notes, Stage), options = the file's headers (value = column index) plus "Don't import" (value `''`); initial = `view.mapping`; Next → `PATCH` then preview. A 400 field `mapping` shows above the selects.
  - **Preview:** a table of `view.preview` (row, name, phone, email, address, stage, outcome/reason) inside a box with `overflow-x: auto` (the page never scrolls sideways at 375px); count lines `${n} new customers`, `${n} already in Roofline (we'll fill in what's missing)`, `${n} will be skipped`, and under it each non-zero skip reason (`No name: n`, `No phone and no email: n`, `Bad phone number: n`, `Duplicate rows: n`).
  - **Consent:** `Checkbox` unchecked by default, label `consentAttestationText(company.name)`; unchecked note "Without this, imported customers only get texts about their own jobs, like appointment reminders. Storm check-ins and offers won't go to them."; the counts refetch with `?attested=<checked>`; `importCopy.optedOutKept(n)` → `1 customer previously opted out, and their texting stays off` / `${n} customers previously opted out, and their texting stays off` (shown when n > 0); the "Import" primary sends `{ consentAttested: false }` or `{ consentAttested: true, consentText }` and is `busy` while pending; a second click is ignored (`isPending` guard); a 409 just refetches.
  - **Progress:** `ProgressBar value=processed max=total label="Importing your customers"`.
  - **Summary:** the counts (new, updated, skipped, jobs, not placed on the map); "Download skipped rows" as an `<a href={skippedDownloadUrl} download>` styled link, shown when `skippedDownloadUrl`; `failed` → `errorPlain` and "Try again" (`useRetryImport`).
- **Copy:** every string above in `copy/import.ts` (`importCopy`; camelCase keys; no snake_case values in text; no vendor names). Drop T30's `comingSoon` key if unused.

**Tests (`import-wizard.test.tsx`)** — stubbed `fetch` (the upload goes through the same stub), app router, `MapView` mocked, `useCompany` answered with `name: 'Acme Roofing'`:
- `it('uploads, maps, previews and imports')`: upload → `/settings/setup/import/i1`; Next through mapping (PATCH body `{ mapping }`) and preview; Import → the start body is exactly `{ consentAttested: false }`; the upload request had `Content-Type: application/octet-stream`.
- `it('the consent box is unchecked and sends the exact text when checked')`: body `{ consentAttested: true, consentText: consentAttestationText('Acme Roofing') }`.
- `it('shows how many opted-out customers stay off')`: `counts.consent.optedOutKept: 12` → "12 customers previously opted out, and their texting stays off".
- `it('shows progress, then the summary with the download link')`: `processing` → progressbar; then `done` with `skippedDownloadUrl` → a link with `download` and that `href`.
- `it('a double click starts one import')`: `api.count('POST /api/imports/i1/start') === 1`.
- `it('shows the server message for a bad file')`: 400 `{ error: 'Please upload a .csv or .xlsx file.', field: 'file' }` → shown on the picker.

**Verify notes:**
- Web only: `npx vitest run --project @roofline/web import-wizard && npm run lint && npm run lint:css && npm run typecheck && npm run build:web`.
- Commit: `feat(web): customer import wizard with the consent confirmation`.
