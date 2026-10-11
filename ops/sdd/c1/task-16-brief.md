### Task 16: Quote PDF

**Base:** `c1-crm` after Task 15 is merged. From T15: `getQuote`, the quote routes file (append only the PDF route). From T1: `pdfkit` + `@types/pdfkit` in `apps/api`. v1 reference: `v1/server/` `renderPdf` (read-only). Company fields from `companies` (`name`, `phone_e164`, `email`, `website`, address columns).

Read first: `ops/sdd/c1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-core-crm-design.md`.

**Split:** Builder 1 `quotes/pdf.ts` (layout, ported from v1); Builder 2 the route in `routes/quotes.ts` (append `GET /:id/pdf`); Builder 3 the tests.

**Files:**
- Create: `apps/api/src/quotes/pdf.ts`
- Modify: `apps/api/src/routes/quotes.ts` (the PDF route only)
- Test: `apps/api/test/quote-pdf.test.ts`

**Interfaces:**
```ts
export type QuotePdfInput = { quote: QuoteView; company: { name: string; phone: string | null; email: string | null; website: string | null; address: string | null };
  customer: { name: string; phone: string | null; email: string | null }; address: string; timeZone: string };
export function renderQuotePdf(i: QuotePdfInput): PDFKit.PDFDocument;   // caller pipes it
export const PDF_COLORS = { ink: '#2b2620', muted: '#6b6257', accent: '#f5b324', band: '#f6f1e6', line: '#eee5cf' };   // S1 tokens, as hex (pdfkit has no CSS)
```
- **Layout:** v1's `renderPdf` structure with Roofline words: company name and contact line; "Roofing estimate"; `Q-0001 · Draft — not final` (draft) or `Q-0001 · Final` · "Created Oct 12, 2026 · Valid through Nov 11, 2026"; customer and address; the scope line (material name, surface square feet, pitch, waste); "Measurement: entered by hand"; the line table (description, quantity, rate, amount); direct cost, "Overhead & profit (25% markup)", "Materials tax (0%)", the total band; "Scope & assumptions" (v1's paragraph); notes; footer `Q-0001 · Prepared with Roofline · 1 / 2`. Helvetica; 9pt minimum in the PDF (print, not the 12px screen rule).
- **Route:** `GET /api/quotes/:id/pdf` → `Content-Type: application/pdf`, `Content-Disposition: attachment; filename="Q-0001-roofing-estimate.pdf"`, streamed; visibility as the quote.

**Tests:**
- the response starts with `%PDF-`; the text (extract with a tiny `pdfkit`-compatible check: compress off in tests via `renderQuotePdf(..., { compress: false })` option, then search the buffer) contains `Q-0001`, the total formatted, and "Draft — not final" for a draft only; rep without the job → 404; company B → 404.

**Carries and rulings:**
- **Ruling CD:** `renderQuotePdf(i, opts?: { compress?: boolean })` — the plan's test needs `compress: false`; default true.

**Verify notes:**
- CI.
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint` plus focused pure tests; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(quotes): estimate PDF ported from v1`
