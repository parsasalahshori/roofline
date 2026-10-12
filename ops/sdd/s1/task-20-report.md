# Task 20 report: storm landing page and requests

## Built
- P1-page (apps/api): public/storm-page.ts (company-host landing, exact host match like policyPages, next() for other hosts), public/storm-page-html.ts, packages/db system/storm-page-lookup.ts, tests storm-page-html and storm-page (company host, cross-company 404, app-host /storm/<uuid>, /storm/routes, /storm/plans reach web app).
- P2-requests (apps/api): public/storm-requests.ts (router plus stormRequestOriginGuard, own Origin check against the company host), storm/landing.ts, storm/landing-copy.ts, app.ts mounts, tests storm-landing and storm-requests (company-host Origin accepted, foreign rejected).
- P3-repos (packages/db): repos/storm-pages.ts (ensureStormPage, code generator), repos/storm-requests.ts (createStormRequest, countStormRequestsSince), db tests.

## Lead fix
- app.ts: moved stormPage(deps) above policyPages(deps) (builder 1 blocker: policyPages 404s every non-policy GET on a company host).

## Review rounds
- Review 1: 1 finding, contact check amend (applied before finalize).
- Review 2: 1 finding, contact check amend (applied before finalize).
- Review 3: 0 findings.

## Minors
- When an address already belongs to another customer, the phone customer is a bare record with no job.
- countStormRequestsSince ignores ctx.
- submitStormRequest takes a findPage callback because @roofline/db/system is importable only under public/**.

## Verify
typecheck and lint clean; @roofline/shared 28 files / 659 tests passed. DB suites run on CI only.
