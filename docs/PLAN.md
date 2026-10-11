# Roofline Implementation Plan

**Goal:** Deliver the address-to-roofing-quote workflow as a locally running full-stack application.
**Architecture:** React/Vite client consumes an authenticated Express API. SQLite stores company settings, immutable quote snapshots, customers and status events. BuildCLI plugin and Node CLI consume the same API.
**Spec:** DESIGN.md

## Constraints and review focus
- US residential, USD, square feet; clearly marked sample prices and synthetic data.
- No real credentials are available: live adapters are contract-tested; no claimed live verification.
- Surface areas must not receive pitch correction twice; zero/negative/oversized dimensions rejected.
- Missing provider credentials, ambiguity, quota errors and absent measurements must be actionable.
- API must enforce review transitions, resist cross-origin writes and snapshot prices server-side.
- Unknown address in demo mode must never receive plausible fabricated measurements.
- PDF, browser and both CLIs must share server calculation and record IDs.

## Tasks
1. Define validated types and write failing pricing tests; implement deterministic cent-based pricing with bundles, surface/footprint conversion and explainable line items.
2. Write failing connector/API tests; implement provider clients, report normalizers, authentication, SQLite storage, quote status reviews and PDF exports.
3. Build the responsive frontend; verify demo, manual/import workflow, editable scope, live recalculation, persisted proposals, customer directory, settings and connectors.
4. Build BuildCLI from pinned upstream source, use its plugin scaffolder, implement roof commands and test them against the server. Provide Node CLI for Java-free operation.
5. Execute unit/integration/browser tests and production build, inspect desktop/mobile presentation, review code, fix material findings, document setup and limits.

## Execution record
- User authorized complete build and closest verified BuildCLI repository; scope US residential.
- Ruling: use licensed EagleView measurements rather than Google Solar for roof-only estimates, based on current provider terms.
- Ruling: ship single-company deployment; multi-tenant isolation, distributed workers and public SaaS operations are outside this local implementation.

## Completed review and decisions
- Pricing, provider and API tests passed; desktop/mobile browser workflow verified.
- Expanded EagleView integration to documented price/order endpoints and a persistent report worker; paid orders require operator consent. Completion atomically creates a draft with captured pricing.
- Independent review found three material issues: stale paid-order input, stale pricebook review, and demo-session survival after enabling live auth. Regression tests reproduced all three, then fixes were applied.
- Fix: disable address editing during PriceOrder and show the immutable priced address/customer/product in consent.
- Fix: compare previewPricebook to server pricing, reject stale creates, and reset scope review when API callers omit a preview.
- Fix: revoke all browser sessions on server startup. This intentionally trades session continuity for a simple, secure single-process deployment.
- BuildCLI source compiled from the pinned commit; its plugin generator and PF4J loader were actually used. A narrow launcher bypasses upstream auto-update and propagates failure exit codes.
- Deferred minor issues from independent review: none.
- Limits: live provider credentials, account entitlements, Docker execution and public hosting were not verified; no real measurement order was purchased.
