### Task 7: Import rows: normalizing, consent and the import plan

**Base:** `f3-setup` after F3 Tasks 1, **5** and 6 are merged (or stacked on the Task 6 branch with Task 5 merged in). From Task 6: `ImportMapping`, `SkipKey`, `ImportCounts`, `ImportPreviewRow` in `packages/shared/src/imports.ts`. From Task 5: `toUsStateCode` in `packages/shared/src/address.ts` (proposed Ruling S; the plan lists only Task 6 — if Task 5 is not merged yet, the controller decides, see the report). From Task 1: the placeholder `packages/shared/src/consent.ts` (`export {};`, in the barrel). `toE164` is in `packages/shared/src/phone.ts`; `ConsentStatus`, `JobStage` in `enums.ts`. No F2 dependency.

**Split:**
- Builder 1: `apps/api/src/imports/normalize.ts`.
- Builder 2: `packages/shared/src/consent.ts` and `apps/api/src/imports/plan.ts`.
- Builder 3: `apps/api/test/fixtures/import-1000.ts` and the two test files.

**Files:**
- Create: `apps/api/src/imports/normalize.ts`, `apps/api/src/imports/plan.ts`, `apps/api/test/fixtures/import-1000.ts`
- Modify: `packages/shared/src/consent.ts` (replace the placeholder)
- Test: `apps/api/test/import-plan.test.ts`, `packages/shared/test/consent.test.ts`
- Do not touch: Task 6's `parse.ts`/`mapping.ts` (import from them only), any barrel.

**Interfaces:**
- **Shared consent:**
```ts
export function consentAttestationText(companyName: string): string;
// `These customers agreed to receive text messages from ${companyName}. I understand ${companyName} is responsible for having their consent.`
export type ExistingConsent = { status: ConsentStatus; doNotContact: boolean; optedOut: boolean };
export function importConsent(existing: ExistingConsent | null, hasPhone: boolean, attested: boolean): ConsentStatus;
```
  - **New customer** (`existing === null`): no phone → `none`; attested → `attested`; else `express`.
  - **Existing customer:** `revoked`, `doNotContact` or `optedOut` → its status unchanged; `written` or `attested` → unchanged; `none` → `attested`/`express` (by `attested`); `express` → `attested` when attested, else `express`.
- **API:**
```ts
// normalize.ts
export type NormalizedRow = { displayName: string; firstName: string | null; lastName: string | null; phones: string[]; emails: string[];
  address: { addressLine: string; city: string; state: string; zip: string } | null; notes: string | null; stage: JobStage | null };
export type RowSkip = { skip: Exclude<SkipKey, 'duplicate'> };
export function normalizeRow(cells: readonly string[], mapping: ImportMapping): NormalizedRow | RowSkip;
export function normalizeState(value: string): string | null;     // 'Nebraska'|'ne'|'NE.' → 'NE' (delegates to toUsStateCode)
export function normalizeZip(value: string): string | null;       // '2134' → '02134', '68102-1234' → '68102'
export function normalizeStage(value: string): JobStage | null;   // '' → null
// plan.ts
export type ExistingCustomer = ExistingConsent & { id: string };
export type ExistingIndex = { byPhone: ReadonlyMap<string, ExistingCustomer>; byEmail: ReadonlyMap<string, ExistingCustomer> };
export type PlannedRow = { row: number; outcome: 'create' | 'update' | 'skip'; skipKey: SkipKey | null; reason: string | null;
  matchId: string | null; consent: ConsentStatus | null; consentChanged: boolean; normalized: NormalizedRow | null };
export type ImportPlan = { rows: PlannedRow[]; counts: ImportCounts };
export function planImport(rows: readonly (NormalizedRow | RowSkip)[], existing: ExistingIndex, attested: boolean): ImportPlan;
export function previewRows(plan: ImportPlan, limit = 20): ImportPreviewRow[];
```
- **Normalizing:**
  - **Name:** `displayName` is the name column, else `first + ' ' + last`, trimmed. With only a name, `firstName` is its first word and `lastName` the rest (null when one word).
  - **Phones:** the `phone` then `phone2` cells, each through `toE164`; invalid ones dropped; duplicates removed.
  - **Emails:** lowercase, trimmed. One without `@` and a dot after it is dropped.
  - **Skips, in this order:** a blank name → `noName`; a filled phone cell that is invalid while no other phone parses (and regardless of email, Ruling 16) → `badPhone`; no valid phone and no email → `noContact`.
  - **Address:** kept only when there is a street and either a ZIP or both city and state. `state` via `normalizeState` (unknown → `''`), `zip` via `normalizeZip` (bad → `''`), `city` trimmed.
  - **`normalizeZip`:** digits of the first 5-digit group; a 3- or 4-digit number is left-padded to 5 (`'2134'` → `'02134'`, `'501'` → `'00501'`); anything else → null.
  - **Stage synonyms** (case-insensitive, trimmed): lead / new / prospect → `lead`; inspection / inspected / appointment → `inspection`; proposal / estimate / quote / quoted / bid → `proposal`; won / sold / signed / closed won → `won`; installed / complete / completed / done → `installed`; lost / closed lost / dead → `lost`; any other filled value → `lead`; `''` → null.
  - **Notes:** trimmed, `''` → null.
- **Planning:**
  - `row` is the spreadsheet row number: the data index + 2.
  - **Duplicates:** a non-skipped row whose phone or email matches an earlier non-skipped row of the same file → `skip`, `duplicate`, reason `Duplicate of row ${n}` (n = the earlier row's `row`).
  - **Matching:** a phone match (any phone, against `existing.byPhone`) beats an email match → `update` with `matchId`; otherwise `create`.
  - **Consent:** `consent = importConsent(match ?? null, phones.length > 0, attested)`; `consentChanged` is true when a matched row's status changes (always true for a new row with a phone).
  - **Reasons:** `noName` → "No name"; `noContact` → "No phone and no email"; `badPhone` → "Bad phone number".
  - **Counts:** `total` = all rows; `new`, `updated`, `skipped`, `skippedBy`; consent: `attested` and `express` count the rows set to that status (new rows, or raised); `unchanged` counts matched rows whose status stays as it is, minus the opted-out ones; `optedOutKept` counts matched rows that are `revoked`, `doNotContact` or `optedOut`. `jobs` = planned non-skipped rows with a stage (an estimate; Task 24 applies the open-job rule); `processed`, `located`, `notLocated` = 0.
  - **`previewRows`:** the first `limit` planned rows as `ImportPreviewRow` (`name` = displayName, `phone`/`email` = first, `address` = `"line, city, ST zip"` or null, `stage`, `consent`).
- **`buildImportFixture(): { csv: string; existing: { name: string; phone: string; consent: ConsentStatus; doNotContact: boolean; optedOut: boolean }[] }`**
  - Headers: `' Customer Name ','CELL','E-Mail','Street Address','city','ST','Zip Code','Notes'`.
  - 1,000 data rows, each with the address `${1000+i} Pine St, Omaha, NE 68102`:
    - rows 1–850: new, phones `(402) 555-${1000+i}`
    - rows 851–900: phones of the 50 `existing` customers (`+1402555` + 2000…2049), whose states are: 10 `revoked` (with an opt-out), 10 `written`, 10 do-not-contact (`express`), 10 `none`, 10 `express`
    - rows 901–940: the phones of rows 1–40, written as `402.555.${1000+i}`
    - rows 941–970: named, with phones `555-0144`, `12` or `call me`, and no email
    - rows 971–985: a blank name with a valid fresh phone
    - rows 986–1000: a name with no phone and no email
    - no row has an email, so `E-Mail` is mapped but empty throughout
  - The test builds `ExistingIndex.byPhone` from `existing` (ids `ex-<n>`, `optedOut` true for the 10 revoked).

**Tests:**
- `consent.test.ts`: every row of the rules table, including `importConsent({status:'express', doNotContact:true, optedOut:false}, true, true) === 'express'`, `importConsent(null, false, true) === 'none'`, `importConsent({status:'none', doNotContact:false, optedOut:false}, true, false) === 'express'`; `consentAttestationText('Acme Roofing')` equals the verbatim sentence.
- `import-plan.test.ts` (parse the fixture CSV with Task 6's `parseUpload(Buffer.from(csv), 'f.csv')` and `autoMap`):
  - `it('the 1,000-row fixture plans exactly')`: attested → counts `new 850, updated 50, skipped 100`; `skippedBy {noName:15, noContact:15, badPhone:30, duplicate:40}`; `consent {attested:870, express:0, unchanged:10, optedOutKept:20}`. Unchecked → `consent {attested:0, express:860, unchanged:20, optedOutKept:20}`. Row 902 → reason `Duplicate of row 2`.
  - `it('fills names and phones from Excel quirks')`: cells `['Ann Lee','4025550144','','12 Elm St','Boston','Massachusetts','2134','','']` with the fixture's mapping plus `stage: 8` → phones `['+14025550144']`, state `MA`, zip `02134`, `firstName 'Ann'`, `lastName 'Lee'`.
  - `it('maps stage words')`: `Sold` → `won`, `weird` → `lead`, `''` → `null`.
  - `it('matches by email when no phone matches, and a phone match beats an email match')`: a row with only `Ann@Example.com` matches the existing customer keyed `ann@example.com`; a row whose phone matches X and email matches Y → `matchId` X.
  - `it('preview is the first 20 rows as saved')` → length 20, first `row: 2`.

**Verify notes:**
- `npx vitest run --project @roofline/shared` runs `consent.test.ts` locally. `import-plan.test.ts` is in the `@roofline/api` project, whose `globalSetup` starts PostGIS (no Docker here): prove it on CI with `ops/bin/ci-check`; locally `npm run typecheck && npm run lint`.
- Commit: `feat(import): normalize rows, apply the consent rules and plan an import`.
