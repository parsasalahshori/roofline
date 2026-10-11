### Task 6: Import files: parsing and column auto-mapping

**Base:** `f3-setup` after F3 Task 1 is merged (or stacked on `f3-t1`). From Task 1 it needs: `csv-parse` and `exceljs` in `apps/api/package.json` + lockfile (do **not** install anything), and `packages/shared/src/imports.ts` with `IMPORT_STATUSES`/`ImportStatus` and `IMPORT_ROW_OUTCOMES` (keep them). `JobStage` and `ConsentStatus` come from `packages/shared/src/enums.ts`. No F2 dependency. `apps/api/src/imports/` is a new folder (Task 9 later adds `run.ts` there; no overlap).

**Split:**
- Builder 1: `apps/api/src/imports/parse.ts` (CSV and XLSX).
- Builder 2: `apps/api/src/imports/mapping.ts`, plus the shared import types in `packages/shared/src/imports.ts`.
- Builder 3: `apps/api/test/import-parse.test.ts` (with the XLSX built inside the test) and `apps/api/test/import-mapping.test.ts`.

**Files:**
- Create: `apps/api/src/imports/parse.ts`, `apps/api/src/imports/mapping.ts`
- Modify: `packages/shared/src/imports.ts` (append; keep Task 1's constants)
- Test: `apps/api/test/import-parse.test.ts`, `apps/api/test/import-mapping.test.ts`
- Do not touch: `package-lock.json`, any barrel, `apps/api/src/index.ts`.

**Interfaces:**
- **Shared (`imports.ts`):**
```ts
export const IMPORT_FIELDS = ['name','firstName','lastName','phone','phone2','email','street','city','state','zip','notes','stage'] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
export type ImportMapping = Partial<Record<ImportField, number>>;     // column index
export const SKIP_KEYS = ['noName', 'noContact', 'badPhone', 'duplicate'] as const; export type SkipKey = (typeof SKIP_KEYS)[number];
export type ImportCounts = { total: number; new: number; updated: number; skipped: number; skippedBy: Record<SkipKey, number>;
  consent: { attested: number; express: number; unchanged: number; optedOutKept: number };
  jobs: number; processed: number; located: number; notLocated: number };
export type ImportPreviewRow = { row: number; outcome: 'create' | 'update' | 'skip'; reason: string | null; name: string | null;
  phone: string | null; email: string | null; address: string | null; stage: JobStage | null; consent: ConsentStatus | null };
export type ImportView = { id: string; fileName: string; status: ImportStatus; headers: string[]; mapping: ImportMapping; rowCount: number;
  counts: ImportCounts; preview: ImportPreviewRow[]; progress: { processed: number; total: number }; consentAttested: boolean;
  startedAt: string | null; finishedAt: string | null; errorPlain: string | null; skippedDownloadUrl: string | null };
export const MAX_IMPORT_ROWS = 20_000;
```
- **API (`parse.ts`, `mapping.ts`):**
```ts
// parse.ts
export type ParsedFile = { headers: string[]; rows: string[][] };
export class ImportFileError extends Error {}               // message is shown as is
export async function parseUpload(bytes: Buffer, fileName: string): Promise<ParsedFile>;
// mapping.ts
export function normalizeHeader(header: string): string;
export const HEADER_SYNONYMS: Record<ImportField, readonly string[]>;
export function autoMap(headers: readonly string[]): ImportMapping;
```
- **Parsing:**
  - Choose by the extension of `fileName`, case-insensitive:
    - `.csv` → `parse` from `csv-parse/sync` with `bom: true, relax_column_count: true, skip_empty_lines: true` on the decoded string
    - `.xlsx` → `exceljs` (`new ExcelJS.Workbook().xlsx.load(bytes)`), first worksheet
    - anything else → "Please upload a .csv or .xlsx file."
  - **Encoding (CSV):** `new TextDecoder('utf-8', { fatal: true })`; on a throw, `new TextDecoder('windows-1252')`.
  - **Cells:** every cell becomes a trimmed string. An XLSX number becomes its integer or plain decimal text, never exponent form (`4025550144` → `'4025550144'`; use `Number.isInteger(n) ? BigInt(n).toString() : n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 })`). An XLSX date becomes `YYYY-MM-DD` (UTC parts). Rich text → its plain text; a formula → its result; empty → `''`.
  - **Rows:** the first non-blank row is the header; data rows are padded with `''` or cut to the header length. Rows that are entirely blank (after trimming) are dropped.
  - **Headers:** a blank header becomes `Column <n>` (1-based).
  - **Limits:** 0 data rows → "This file has no rows."; more than `MAX_IMPORT_ROWS` → "This file has more than 20,000 rows. Split it into smaller files and import each one."
  - **Unreadable XLSX** (load throws, or no worksheet) → "We couldn't read this spreadsheet. Save it as .csv and try again."
  - Every refusal is `throw new ImportFileError(<message>)`.
- **`normalizeHeader`:** lowercase, every character other than `a-z0-9` becomes a space, spaces collapse, then trim (`' Customer Name '` → `customer name`, `'E-Mail'` → `e mail`).
- **`HEADER_SYNONYMS`** (normalized):
  - **name:** name, full name, customer, customer name, client, client name, contact, contact name
  - **firstName:** first, first name, firstname, fname, given name
  - **lastName:** last, last name, lastname, lname, surname, family name
  - **phone:** phone, phone number, mobile, mobile phone, cell, cell phone, cellphone, telephone, tel, primary phone, home phone
  - **phone2:** phone 2, alt phone, other phone, work phone, secondary phone
  - **email:** email, e mail, email address, mail
  - **street:** address, street, street address, address 1, address line 1, address1, property address
  - **city:** city, town
  - **state:** state, st, province
  - **zip:** zip, zip code, zipcode, postal code, postcode
  - **notes:** notes, note, comments, comment, description
  - **stage:** stage, status, pipeline stage, job stage, deal stage
- **`autoMap`:** for each field in `IMPORT_FIELDS` order, take the first column whose normalized header is one of its synonyms; each column is used at most once. When a column matches `phone` (e.g. `home phone`) while `phone` is already taken, it goes to `phone2` (if free).

**Tests:**
- `import-parse.test.ts`:
  - `it('reads a CSV with a BOM, CRLF, quoted commas and trailing blank rows')`: bytes of `﻿Name,Address\r\n"Lee, Ann","12 Elm St, Apt 2"\r\n\r\n,\r\n` → `{ headers: ['Name','Address'], rows: [['Lee, Ann','12 Elm St, Apt 2']] }`.
  - `it('reads Windows-1252 text')`: `Buffer.from([...Buffer.from('Name\r\nPe'), 0xf1, 0x61])` → rows `[['Peña']]`.
  - `it('reads an xlsx built in the test')`: an exceljs workbook with header `Phone, Zip, Date` and a row with number `4025550144`, number `2134` and `new Date(Date.UTC(2026, 9, 11))`, written with `writeBuffer()` → rows `[['4025550144','2134','2026-10-11']]`.
  - `it('names blank headers')`: `Name,Phone,,Notes` → `headers[2] === 'Column 3'`.
  - `it('refuses other files, empty files and more than 20,000 rows')`: `x.pdf` → "Please upload a .csv or .xlsx file."; a header-only CSV → "This file has no rows."; 20,001 data rows → the 20,000 message; garbage bytes as `.xlsx` → "We couldn't read this spreadsheet. Save it as .csv and try again."; each an `ImportFileError`.
- `import-mapping.test.ts`:
  - `autoMap([' Customer Name ','CELL','E-Mail','Street Address','city','ST','Zip Code','Notes'])` → `{name:0, phone:1, email:2, street:3, city:4, state:5, zip:6, notes:7}`
  - `autoMap(['First','Last','Mobile','Home Phone','Status'])` → `{firstName:0, lastName:1, phone:2, phone2:3, stage:4}`
  - `autoMap(['Favorite color','Name'])` → `{name:1}` (unknown headers stay unmapped)

**Verify notes:**
- These are pure tests, but the `@roofline/api` Vitest project's `globalSetup` starts a PostGIS container, which needs Docker; there is none here. Run `npm run typecheck && npm run lint` locally and prove the tests on CI with `ops/bin/ci-check`. Do not try to start containers.
- `npx vitest run --project @roofline/shared` (the new shared types) and `npx vitest run --project @roofline/web copy-rules` (new `as const` arrays are camelCase, expected unaffected).
- Commit: `feat(import): read CSV and Excel uploads and match their columns`.
