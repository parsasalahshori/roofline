### Task 26: Web: quote editor and PDF link

**Base:** `c1-crm` after Task 18 is merged (T15/T16 for the real API). From T18: placeholders `features/quotes/{QuoteWindow,api}`, `copy/quotes.ts`, the route `jobs/:jobId/quotes/:quoteId`. From F1 `pricing.ts`: `calculateQuote`, `Scope`, `money`. From T4: `QuoteView`.

Read first: `ops/sdd/c1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-core-crm-design.md`.

**Split:** Builder 1 `QuoteEditor.tsx` (measurement and scope inputs, live price); Builder 2 `QuoteLines.tsx`, `QuoteTotals.tsx`; Builder 3 `QuoteWindow.tsx` actions (save, mark final, copy, download PDF), `copy/quotes.ts`, `features/quotes/api.ts`, tests.

**Files:**
- Create: `apps/web/src/features/quotes/{QuoteEditor,QuoteLines,QuoteTotals}.tsx` (+ CSS Module)
- Modify: `apps/web/src/features/quotes/{QuoteWindow.tsx,api.ts}`, `apps/web/src/copy/quotes.ts`
- Test: `apps/web/test/quote-editor.test.tsx`

**Interfaces:**
- **Hooks:** `useQuote(id)`, `useSaveQuote(id)` (PATCH), `useFinalizeQuote(id)`, `useCopyQuote(id)`.
- **Editor:** area (sq ft) with a surface/footprint `Select`, pitch (x/12), material, waste %, stories, layers, ridge/edge/valley feet, decking sheets, markup %, tax %, notes; every change recomputes with `calculateQuote(scope, quote.prices)` in the browser (the frozen snapshot, not the live pricebook); "Save" PATCHes; unsaved changes warn on close.
- **Display:** `quotes.estimateLabel` "Estimate" on the total (master §9.2); line table (name, quantity + unit, rate, amount — two-decimal money); totals (direct cost, overhead & profit with the markup %, tax, total).
- **Final:** "Mark final" (confirm) → read-only view with "Copy to a new quote"; `finalizedAt` shown. "Download PDF" is an anchor to `/api/quotes/:id/pdf` (always available).
- Window: inside the job's `AppWindow` (title stays "Jobs"; the stat strip shows `Q-0001`, status, total).

**Tests:**
- the live total equals `calculateQuote` for v1's default scope; save body; final makes inputs read-only and shows Copy; copy navigates to the new quote; the PDF link href.

**Carries and rulings:**
- Prices in the editor come from the quote's frozen `prices` snapshot, never the live pricebook.

**Verify notes:**
- web suite, lint, typecheck, build.
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); still confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(web): job quote editor with live pricing and the PDF download`
