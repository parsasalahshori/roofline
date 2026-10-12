# Task 26: C1 Web quote editor and PDF link

Commit a99c440 on branch c1-t26. CI run 38206675177: PASSED.

## Built
- Package A: QuoteEditor.tsx/.module.css, a controlled form with local numeric text, in-range values only reach onChange, field errors, readOnly disables.
- Package B: QuoteLines (table) and QuoteTotals (dl, total with Estimate hint), CSS modules.
- Package C: QuoteWindow (load, draft, live totals, save, finalize sheet, copy, PDF link, unsaved-change guard, company-zone date), api.ts hooks, draft.ts, copy/quotes.ts additions, quote-editor.test.tsx (9 tests), c1-routes.test.tsx stub update.

## Reviews
- Review 1: verify failed, 2 findings; contact check: F1 amended, F2 amended.
- Review 2: verify passed, 0 findings.

## Minors
- Copy button shown only for final quotes with canEdit (brief silent).
- area/pitch use inputMode decimal; integer fields numeric.

## Verify tail
web vitest: 51 files, 516 tests passed; typecheck, lint, lint:css clean; build:web built OK (chunk size warning only).
