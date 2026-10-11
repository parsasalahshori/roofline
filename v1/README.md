# Roofline

A working, single-company roofing estimating application for US residential contractors. React frontend, Express backend, SQLite database, PDF proposals, measurement connectors and a real BuildCLI command plugin.

## Run locally

For this configured copy, double-click **Start Roofline.command**. It opens http://127.0.0.1:4311 and starts the server when needed. Keep the terminal running. Your credentials are already in `.env`; do not replace that file with the example.

Requires **Node.js 22.13+** (tested with 22.23.2).

```bash
npm ci
cp .env.example .env
npm run build
npm start
```

Open **http://127.0.0.1:4311** and select **Explore demo workspace**. The demo includes three fictional properties and proposals. It binds to loopback only. No paid API key is needed to explore it.

For frontend development, run `npm run dev` and open http://127.0.0.1:5173. API requests are proxied to port 4311. Run commands from this project directory.

## What works

- A map-based Today workspace inspired by the supplied roofing dashboard reel, with searchable Omaha test properties, distinct saved-property pins, fit-to-properties controls and an expanded desktop explorer.
- Selected-property cards show roof surface area and pitch from completed reports; satellite and directions links open Google Maps.
- A proposal board with stage totals, review steps, practice labels and an optional list view. Open value counts drafts, ready and sent proposals; accepted and declined proposals are excluded.
- Persistent follow-up dates and notes, with rescheduling and completion on Today. These are internal reminders; they do not send messages or create calendar events.
- Quick search for customers, proposals, saved and test properties, plus common actions. Open it from the top bar or with ⌘K / Ctrl+K.
- A guided four-step estimate: property → roof & scope → customer → review. Clear missing-detail feedback, optional price breakdown and optional technical setup.
- Public NOAA preliminary hail reports by date, plotted as report locations with source attribution and a return to the property map.
- Responsive proposal list, pricing, connections and customer history.
- Google Maps address lookup with explicit candidate selection and satellite view.
- Manual surface/footprint measurements; normalized JSON report import.
- EagleView completed-report retrieval and an **address → paid measurement order → automatic draft quote** workflow. The server checks waiting reports every 60 seconds while running.
- Optional RentCast enrichment. Living area is never used as roof area.
- Architectural shingles, designer shingles and standing seam metal; waste, bundles, pitch, stories, tear-off, edge lengths, decking and permit/disposal allowances.
- Editable company pricebook and proposal identity, persisted in SQLite.
- Draft editing; review checks; ready/sent/accepted/declined status recording with activity history.
- Immutable saved pricing snapshots, stale-price detection, PDF and JSON downloads.
- Password authentication, server-only provider keys, session revocation on restart, request validation, rate limits and cross-origin write checks.
- Node CLI with batch quoting, plus a Java command plugin generated and loaded by BuildCLI.

## Real property quoting

1. Replace sample costs in **Pricing** and company details in **Company settings**.
2. Configure a licensed measurement provider. See [CONNECTORS.md](docs/CONNECTORS.md).
3. Choose **New estimate → More options → Order a roof report** for the address-to-report workflow. Get the report price, confirm the specific property/product and authorize the order. When ready, the report creates a **draft** with the pricebook captured at the time of pricing.
4. Alternatively, retrieve an existing EagleView report, import [measurement.json](examples/measurement.json), or enter field measurements.
5. Review roof geometry, all pitches, scope, taxes and site conditions. Save the proposal and mark it ready.
6. Download its PDF and send through your own channel. Record external sending/acceptance in Roofline.

EagleView Property Data sandbox credentials are configured in this copy. A live sandbox request returned two roofs for 4220 Barker Ave; the selected 1,668.94 sq ft roof produced a saved draft. Paid measurement ordering and production customer addresses have not been exercised. A valid provider key does not guarantee compatible API entitlement, coverage or pricing.

## Important boundaries

This is a complete local single-company workflow, not a deployed multi-tenant SaaS service. It does not include public customer accounts, electronic signatures, email sending, payment processing, CRM sync, field scheduling or photo-based damage diagnosis. The report importer accepts the documented Roofline JSON schema; it is not a generic PDF parser. The roof graphic in demo mode is explicitly illustrative.

Quotes are preliminary until reviewed. Initial prices are **example values**, not researched rates. Linear items use supplied lengths; absent lengths stay zero and exclude those allowances. Single-pitch footprint conversion is unsuitable for mixed-pitch roofs; use measured surface area. Manufacturer-specific material takeoffs and detailed flashing/ventilation scopes require estimator input. Markup is a cost markup, not a profit margin. Tax applies only to marked-up lines labeled materials; the contractor must review the applicable treatment.

Google Solar is deliberately excluded from roof-only quoting because its current standard terms limit use to energy-system workflows. Zillow listing/living area does not provide roof geometry. Research and repository findings are in [RESEARCH.md](docs/RESEARCH.md).

## Authentication and deployment

For real company data, set `DEMO_MODE=false`, `ADMIN_EMAIL`, and a unique `ADMIN_PASSWORD` with at least 12 characters. Set a separate random `API_TOKEN` of at least 32 characters if you need CLI access. Never put API keys in client files or version control. Use a new database path to keep real work separate from demo records.

Every server restart revokes browser sessions. Saved proposals and jobs remain. Authentication is for one company owner; there are no per-user roles or tenant boundaries. Run **one API process per database**; the job worker and login limiter are designed for that deployment. SQLite uses WAL. Back up through SQLite's online backup mechanism, or stop the server before copying its database files. Protect backups and `.env` as customer data/secrets.

For a remote deployment, use HTTPS at a reverse proxy, `NODE_ENV=production`, `DEMO_MODE=false`, `HOST=0.0.0.0`, and set real credentials. Secure cookies require HTTPS. Configure rate limiting at the proxy as well; the app intentionally does not trust arbitrary forwarded client IP headers. Restrict network access to your operator team. Before public use of Google Maps, publish your own required terms/privacy notices and confirm provider licensing. See [DEPLOYMENT.md](docs/DEPLOYMENT.md).

## CLI

The Node CLI works without Java:

```bash
export ROOFLINE_URL=http://127.0.0.1:4311
export ROOFLINE_TOKEN='your-server-API_TOKEN'
node cli/roofline.mjs health
node cli/roofline.mjs import examples/measurement.json
node cli/roofline.mjs estimate examples/quote-request.json
```

For BuildCLI, install JDK 21+ and Maven, then:

```bash
./scripts/build-cli.sh
./scripts/buildcli roof --help
./scripts/buildcli roof health
./scripts/buildcli roof estimate --file examples/quote-request.json
```

Detailed quote, batch and export examples: [CLI.md](docs/CLI.md). BuildCLI is pinned to commit `471f8e7d9d02a42154f26a6aa423858c19720ca8`, MIT license. The plugin scaffolding was generated by its `plugin init` command; its actual PF4J loader registers the finished `roof` command. The launcher preserves nonzero failures and avoids upstream auto-update prompts.

## Verify

```bash
npm test
npm run build
npx playwright install chromium --only-shell
npm run test:e2e
```

Tests exercise pricing, quote persistence and price snapshots, auth/restart behavior, provider errors and normalization, idempotent automatic order-to-quote conversion, both CLIs (BuildCLI when built), desktop/mobile workflow, PDF downloads and paid-order consent. Browser tests run an isolated in-memory server on port 4321. See [VERIFICATION.md](docs/VERIFICATION.md) for the delivered run results.

Source layout: `client/` UI, `server/` API/storage/providers/jobs/PDF, `shared/` validated domain/pricing, `cli/` CLI source, `tests/` regression suite, `examples/` import/request formats. API reference: [API.md](docs/API.md).

## EagleView Property Data sandbox

The new **New estimate → Try a test property** flow supports the official 100 Omaha test addresses with server-side OAuth, asynchronous results, per-structure selection, and test-only draft quotes. Set `EAGLEVIEW_CLIENT_ID` and `EAGLEVIEW_CLIENT_SECRET` in `.env` using credentials from a sandbox app in EagleView Developer → My Apps. Restart the server and reload. No Google key is needed. See [connector setup](docs/CONNECTORS.md#property-data-v2-sandbox-new).

Verification of the redesigned copy: production frontend build and 28 backend/provider/pricing/CLI and business-rule tests passed. Desktop and mobile behavior was checked in Chrome, including map expansion, search, job-board filtering and reminder creation, rescheduling and completion. The historical NOAA feed returned 305 reports for May 26, 2024. The live EagleView sandbox result was used to save and preview a proposal. The existing Playwright suite has updated labels and list-view selection for the new interface; see the verification record for which checks were executed.
