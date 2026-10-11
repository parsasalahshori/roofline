
# F3 Task 23 report: Import API (upload, mapping, preview, start, skipped rows)

Commit 1301ab3 on f3-t23 (base 1dc46e0).

## Built
- packages/shared: ExistingCustomer, ExistingIndex, NormalizedRow, RowSkip moved type-only into imports.ts (ruling AC); api normalize.ts/plan.ts re-export them.
- packages/db (A): repos/imports.ts bodies (createImport, insertImportRows, getImport, setImportMapping, startImport, retryImport, importCells, existingIndexFor, skippedImportRows, listImports).
- apps/api (B): imports/preview.ts (buildImportView), imports/skipped-csv.ts (formula-safe CSV, CRLF), test/skipped-csv.test.ts.
- apps/api (C): routes/imports.ts (upload, PATCH mapping, start 202, retry, list, get, skipped CSV), test/imports-api.test.ts.

## Review rounds
- Round 1: verify passed, 0 findings.

## Minors / judgment calls
- existingIndexFor optedOut is true if any of the customer's phones is opted out (needs ruling for secondary phones).
- Email matching is case-sensitive against stored (assumed lowercase) values.
- PATCH rejects one column mapped to two fields; start stores planned counts before startImport.
- T6 hard-coded '20,000' message left unchanged.

## Verify
- Local: typecheck and lint pass (no output errors).
- CI run 38183142794: lint, lint:css, typecheck pass; v1 job passes. Platform tests: 3044 passed, 1 failed.
  The one failure is apps/api/test/pgboss.test.ts "it schedules expire-drafts ... sweep-queued and dispatch-messages": the worker registers 8 schedules
  (bill-monthly-fees, end-trials, poll-texting, provision-texting, report-usage added by other F3 tasks) but the test expects 3. Not touched by this task;
  stale expectation from the base. imports-api.test.ts and skipped-csv.test.ts passed.
