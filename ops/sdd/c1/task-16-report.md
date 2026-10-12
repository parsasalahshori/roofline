# Task 16: C1 Quote PDF report

Built: B1 apps/api/src/quotes/pdf.ts (pdfkit layout, footer lifts bottom margin to avoid blank page); B2 GET /:id/pdf in apps/api/src/routes/quotes.ts (one withTenant, 404 on any missing link, render before headers set); B3 apps/api/test/quote-pdf-render.test.ts (4 pure tests, decodes TJ hex) and quote-pdf.test.ts (5 route tests).

Review round 1: verify passed, 0 findings.

Minors: pure render test cannot run via the root vitest config without Docker (globalSetup); proven via scratch config / CI.

Verify: typecheck and lint clean. Commit 183ea12. ci-check run 38204531747 PASSED.
