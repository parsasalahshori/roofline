# Roofline SaaS — Sub-project 3: Estimator and homeowner page

- **Date:** 2026-10-12
- **Status:** written by Architect 2 under the owner's standing rule ("just build, take the recommended option"). Every choice not already made in the master spec is recorded as **Decision: … (recommended because …)**. Provider choices name their cost.
- **Parent:** [Master design](2026-10-10-roofline-saas-design.md) §1 feature 2, §3.1 (measuring, homeowner page), §3.2 (financing, e-sign), §8 row 3, §9.1–9.2, §12 (v1 ports), §14 (Estimator questions). Builds on [Foundation](2026-10-10-roofline-foundation-design.md) F1–F3 and [Core CRM](2026-10-12-roofline-core-crm-design.md) C1.
- **Delivery:** one milestone, **E1**, one plan (`docs/superpowers/plans/2026-10-12-roofline-estimator.md`).

---

## 1. Goal

The owner's feature 2, **Aerial Measure → Proposal**: from a typed address to a Good/Better/Best proposal on the homeowner's phone, signed, with the job moved to Won.

1. **Measure from above.** The address is geocoded, the building's **outline** is found from building-footprint data and shown on satellite imagery, the rep confirms or adjusts it, and an **instant estimate** of the roof (area, pitch, edges, ridges) is computed.
2. **Exact measurements on demand.** "Get exact report" orders an **EagleView** report on Roofline's account (owner approves the spend), re-bills it, and re-prices the proposal when it arrives.
3. **Multi-tier proposal.** Three options from the company's **tier templates** (set up once), each priced with the C1 pricebook and the ported v1 engine, with a monthly-payment estimate.
4. **Auto-drafted text, one-click send.** The Estimator agent drafts the text with a private link; the R2 review approves it; it goes out through the F1 send gate.
5. **Homeowner page.** A phone-first public page at a private link: compare the options, see the payment estimate, **e-sign** — built in, with a tamper-evident signed PDF.
6. **Job automation.** Sending moves the job to Proposal; signing moves it to Won with the chosen option's value.

**Click budget (master §2):** from a typed address to "sent to homeowner" in **3 clicks or fewer**, asserted by Playwright.

**Not in E1:**
- Payments or deposits (master §4 out).
- Real lender sign-ups (financing is an estimate only, master §3.2).
- AI-measured roof facets from imagery (master §4 out; Decision 3 explains how the "extract the roof from aerial imagery" wish is met).
- Storm-triggered proposals (Storm Scout feeds jobs; proposals start from a job or an address).
- AI-written message wording (Decision 14).

## 2. What exists already (from F1–F3 and C1)

- **Data:** `customers`, `properties` (`geom`, `footprint_id`, `year_built`), `jobs` (`value_cents`, stages and C1's stage rules), `activities`, `agent_tasks`/`agent_task_steps` (R2), `messages`, `usage_events` (`exact_report` kind), `company_settings.financing_apr_bps` and `financing_term_months` (F1, unused until now).
- **C1:** the company **pricebook** (`pricebooks`, v1 schema, Settings → Prices), single-option **quotes** with a frozen snapshot, `renderQuotePdf` (pdfkit), the job and customer windows and timeline, appointments.
- **F3 seams:** `Geocoder` (Geocodio, fakes), pg-boss job queues and `InlineJobs`, `FAKE_PROVIDERS=1`, billing (`invoiceAmountCents('exact_report', …)` = cost × (1 + markup)), the setup item `prices_and_tiers` (owned by this spec), the send gate (`informational` texts need `express`, `attested` or `written` consent; quiet hours; registration and billing rules).
- **v1 code** (`v1/server/`): `providers.ts` (EagleView Legacy WebServices: `PriceOrder`, `PlaceOrder`, `GetReport`, `normalizeEagleView`), `eagleview-sandbox.ts` (EagleView **Property Data v2**: OAuth client credentials, `request` → `result`, `normalizePropertyData` → per-structure 3D roof area and predominant pitch), `jobs.ts` (price → confirm max → claim before ordering → poll → draft quote, never auto-retry an uncertain order), `pdf.ts`, and Google Static Maps satellite (not reused, Decision 2).

## 3. Measuring

### 3.1 The outline (building footprint)

- **Decision 1: footprints come from Microsoft's US Building Footprints, loaded into our own PostGIS table one state at a time** (recommended because it is **free** (ODbL, attribution required), covers ~130 million US buildings, needs no per-lookup vendor call, and Storm Scout needs the same table for "every home in the path" (master §3.1)). Cost: database storage only, roughly 0.3 KB per building — about 0.3 GB for Nebraska, ~3 GB for Texas.
  - **Global table `building_footprints`** (not tenant data): `id bigserial`, `state char(2)`, `geom geometry(Polygon,4326)` (GIST), `area_sq_ft numeric`, `source text` (`ms-usbuildings-v2`), `source_ref text`.
  - **`building_footprint_states`:** `state`, `status (loading|ready|failed)`, `buildings`, `loaded_at`, `source_url`, `error_plain`.
  - **Loading:** a `footprints-load` background job downloads the state's zipped GeoJSON from Microsoft's public blob storage and streams it into the table in batches. It is queued automatically the first time a company's address (or a measured home) is in a state that is not `ready`; ops can also queue it. **Decision 4:** whenever no outline is available (the state is still loading, or no building is near the point), the measure view opens in **draw mode** with "Draw the roof outline on the map" rather than an error (recommended because the rep can always trace the roof on satellite in under a minute, so missing data never blocks a proposal).
  - **Attribution:** "Building outlines © Microsoft, ODbL" in the measure view.
- **Picking the building:** the footprint containing the home's geocoded point; else the nearest within 30 m; other footprints touching the parcel area (within 40 m) are offered as extra structures (garage, shed), off by default.
- **Decision 2: satellite imagery from MapTiler, as on the map home** (recommended because it is already in the stack (master §6), its terms allow showing our own overlays, and Google Static Maps — v1's choice — may not be shown with non-Google data). Cost: within the MapTiler plan's map-load quota.
- **Adjusting:** the rep can **drag corners, add a corner on an edge, and delete a corner** on the satellite view, or **draw a new outline** (click corners, double-click to finish). The saved outline is what the numbers use.
  - **Decision 5: a small custom vertex editor on MapLibre, no draw library** (recommended because the common draw plugin targets Mapbox GL and needs patches for MapLibre, and the three edits needed are a few hundred lines).

### 3.2 The instant estimate

- **Decision 3: the instant estimate is outline × pitch, with an optional paid aerial measure behind a switch** (recommended because outline × pitch is free and instant — the master spec's chosen method — while EagleView's **Property Data** API (v1 already has a client) returns a machine-measured 3D roof area and predominant pitch from aerial imagery, which is exactly "extract the roof from aerial imagery"; its per-call price is commercial and not public, so it ships **off** and the owner turns it on per company once priced).
  - **Free path (default):**
    - `footprint_sq_ft` from the outline (geodesic area).
    - **Overhang:** the outline is the wall line, so the roof plan area adds `perimeter × overhang` (default 1 ft, company setting 0–3 ft).
    - **Pitch:** **Decision 6:** the company's default pitch (default **6/12**), changeable per measurement with a pitch picker showing simple slope diagrams (4/12 … 12/12) (recommended over regional or year-built tables because no reliable free per-roof pitch source exists, region and age predict pitch poorly, and a rep standing at the curb knows better; lidar (USGS 3DEP) is deferred — coverage gaps and point-cloud processing cost more than E1 can carry).
    - **Surface area** = plan area × √(1 + (pitch/12)²) (v1's `toSurfaceArea`).
    - **Edges** (eaves + rakes) ≈ the overhang-offset perimeter. **Ridge + hip** ≈ the long side of the outline's minimum rotated rectangle (one ridge; the estimate notes "allowance"). **Valleys** 0 unless the rep enters them.
  - **Aerial path (when the company's `aerial_measure` setting is on and the provider is configured):** EagleView Property Data v2 for the address (async, usually under a minute): per structure, 3D roof area and predominant pitch; the main structure's values replace the free path's area and pitch; edges and ridge stay outline-derived. Labeled "Estimate (aerial)". Cost: EagleView's per-request price (owner to negotiate); it is **not** billed to the roofer in E1 (no new usage kind) — Roofline absorbs it while piloting.
  - **Labels (master §9.2):** every instant number says **"Estimate"** until an exact report replaces it.

### 3.3 Exact report (EagleView)

- **Decision 7: EagleView Measurement Orders on Roofline's account, product "Premium Residential" by default** (recommended because the master spec fixes EagleView and re-billing, and Premium includes ridge, hip, valley, eave and rake lengths the proposal needs; QuickSquares (area and pitch only) is cheaper but leaves the accessory lines as guesses). Cost: about **$18–105 per report** (master §13), re-billed as usage `exact_report` at cost × (1 + markup) through F3 billing. Delivery: hours to 3 business days.
- **Flow** (v1's safe-ordering pattern, on pg-boss):
  1. "Get exact report" on a measurement asks EagleView for a **price** (`PriceOrder`), then drafts an Estimator task with one **spend** step `order_exact_report` showing "Exact roof report · up to $62" (the max price plus markup, `max_spend_cents`). Spend steps need the owner (or a delegated office user) — R2.
  2. On approval, the handler **claims the order before calling** (`exact_report_orders.status = ordering`), places it with Roofline's reference id as `ReferenceId`, and stores the report id. An uncertain result (timeout) is **never auto-retried**: the order shows "Needs attention — check before ordering again" (v1 rule).
  3. A schedule polls `waiting` orders every 10 minutes (`GetReport`); a completed report is normalized (`normalizeEagleView`, ported) into an **exact** measurement; the usage event is recorded once (ref = the report id); the proposal re-prices (§4.4).
  4. Costs in the card: "Exact roof report — 812 Oak St" on the next invoice.
- **Sandbox:** `EAGLEVIEW_ENV=sandbox` uses EagleView's integration hosts with their documented Omaha test addresses (v1's `sandbox-properties.ts` list moves to test fixtures); production needs the partner agreement (owner to-do).

### 3.4 Measurements table

- **`measurements`** (tenant): `property_id`, `job_id` (nullable), `kind (estimate|exact)`, `method (outline|aerial|eagleview|manual)`, `outline geometry(MultiPolygon,4326)` (nullable for manual), `structures jsonb` (which footprints, included flags), `footprint_sq_ft`, `overhang_ft`, `pitch_x12 numeric`, `surface_sq_ft`, `edge_ft`, `ridge_ft`, `valley_ft`, `facets int`, `provider_ref text`, `notes`, `created_by_user_id`, timestamps. **Decision 8:** a measurement is immutable once a proposal has been sent from it; edits create a new measurement (recommended because a sent price must stay explainable).
- **Decision 9:** the property's `footprint_id` is set to the chosen main footprint (recommended because Storm Scout and later re-measures start from the same building).

## 4. Proposals

### 4.1 Tier templates (master §14)

- **Table `tier_templates`** (tenant, three rows per company: `good`, `better`, `best`): `name` (shown to homeowners, e.g. "Good — Architectural shingles"), `material` (`architectural|premium|metal`), `waste_percent`, `markup_percent` (nullable → pricebook default), `add_ons jsonb` (`[{name, unit: per_square|per_edge_ft|per_ridge_ft|per_valley_ft|per_job, rateCents, taxable}]`), `highlights text[]` (≤ 4 short bullets for the homeowner, e.g. "Lifetime shingle warranty"), `enabled bool`.
- **Decision 10: default templates** (recommended because a roofer must be able to send a sensible proposal on day one; every value is editable in Settings → Prices):
  - **Good — "Architectural shingles":** architectural, waste 12%, no add-ons; highlights "Architectural shingles", "Synthetic underlayment", "Tear-off and cleanup".
  - **Better — "Architectural + protection":** architectural, waste 12%; add-ons ice & water shield per edge ft ($2.50), ridge vent per ridge ft ($6.00); highlights + "Ice & water shield at the edges", "Ridge ventilation".
  - **Best — "Designer shingles":** premium, waste 12%; the Better add-ons plus "Extended workmanship warranty" per job ($450); highlights + "Designer shingles", "Extended warranty".
- **Pricing a tier:** v1's `calculateQuote(scope, pricebook)` once per tier (master §12) plus the tier's add-on lines (quantities from the measurement), with markup and tax applied the same way as v1 (add-ons taxable per flag). The add-on lines append to the quote lines.
- **Setup:** `prices_and_tiers` is **done** when the company has saved its pricebook and its tier templates at least once.

### 4.2 Financing estimate (master §3.2)

- `monthly = P × r / (1 − (1 + r)^−n)` with `r = APR/12`, `n = term months`, `P` = the option total; 0% APR → `P / n`. Shown as **"About $212/mo · 9.99% for 120 months · estimate, subject to approval"** — hidden when the company hasn't set APR and term (Settings → Prices → Financing). Never a lender name.

### 4.3 Tables

- **`proposals`** (tenant): `job_id`, `customer_id`, `property_id`, `measurement_id`, `number` (`P-0001` per company, counter table), `status (draft|ready|sent|viewed|signed|declined|expired|replaced)`, `valid_until date`, `link_token_hash bytea unique`, `link_token_encrypted bytea` (so the same link can be re-sent), `sent_at`, `first_viewed_at`, `last_viewed_at`, `view_count`, `signed_at`, `declined_at`, `decline_reason`, `replaced_by_id`, `message_body text` (as sent), `estimate_basis (estimate|exact)`, `created_by_user_id`, timestamps.
- **`proposal_options`** (tenant): `proposal_id`, `tier (good|better|best)`, `position`, `name`, `highlights text[]`, `scope jsonb`, `prices jsonb`, `add_ons jsonb`, `calculation jsonb` (frozen), `total_cents`, `monthly_estimate_cents` (nullable), `enabled bool`.
- **`proposal_signatures`** (tenant, at most one per proposal): §5.3.
- **`proposal_events`** (tenant): `kind (sent|viewed|option_viewed|signed|declined|link_resent)`, `data jsonb`, `ip_hash`, `user_agent`, `at` — the homeowner side of the timeline (also mirrored as job activities).
- **`stored_files`** (tenant): `kind (signed_proposal_pdf)`, `object_key`, `sha256`, `bytes`, `content_type`, `created_at`.

### 4.4 Building and re-pricing

- **From the job window** ("New proposal") or the **Estimator window** (type an address → existing customer/home or a new one), a proposal is created from the latest measurement of the home: three options from the enabled templates, frozen like C1 quotes, `valid_until` = today + the company's `proposal_valid_days` (default 30).
- **Editing before sending:** turn an option off, rename it, change its material, waste, add-ons or markup; numbers update live (the engine runs in the browser too) and are recomputed on the server.
- **Decision 11: an exact report re-prices a draft in place; a sent proposal gets a revised draft** (status `replaced` on the old one when the new one is sent, link moved to the new one) (recommended because the homeowner's link must never show prices different from what was approved for sending, and the owner sees what changed).
- **C1 quotes stay** as the single-option tool; "Make a proposal from this quote" copies its scope into the Better option.

### 4.5 Sending (the Estimator agent)

- **Agent task:** agent `estimator`, kind `proposal_send`, title "Proposal for Maria Lopez — 812 Oak St", subject = the job; one **message** step `send_proposal` (owner or office approves) whose preview shows the text, the recipient, the three totals and "Estimate" or "Exact measurements".
- **Text (Decision 14):** a template, editable in the R2 step's Edit: `Hi Maria, it's Acme Roofing. Here's your roof proposal for 812 Oak St: {link} Reply STOP to opt out.` (recommended because a template is instant, free and passes the send gate's content rules every time; AI-written wording can come later without changing the flow). `{link}` is required; the edit is refused without it.
- **Consent:** a proposal the customer asked for is **informational** (master §9.1) and needs `express` or better. When the rep creates the customer during the proposal flow, a checkbox "They asked for this proposal by text" records `express` with source `manual`, the user and time. With no consent, sending is blocked by the gate with its plain reason, and the job window offers "Copy link" instead.
- **On send:** the handler mints (once) the link token, renders the body, and sends through the gate (quiet hours apply: an evening approval may send at 8:00 the next morning — the review shows "Sends now" or "Sends 8:00 AM · quiet hours respected"). The job moves to **Proposal** (C1 rules) if it was Lead or Inspection.
- **Click budget:** Estimator window → type the address → **"Make proposal"** (1; measure, price, draft — the outline found automatically) → the review opens → **Approve** (2). With an outline to adjust or a new customer's phone to type, still ≤ 3.
- **Decision 12: always one approval click, never fully automatic** (recommended because the master spec's rule is "agents draft, owner approves" (only Front Desk's four live actions skip it), and one click keeps the owner's 3-click target; a company switch for zero-click sending would need the owner's explicit policy change and the lawyer's view).
- **Copy link:** owner and office can copy the private link to send it themselves (logged as an event).

## 5. The homeowner page

### 5.1 Link and hosting

- **URL:** `https://<app-domain>/p/<token>` — **Decision 13:** on the app domain until the branded short-link domain exists, then `PROPOSAL_LINK_BASE_URL` switches it with no code change (recommended because carriers filter public shorteners (master §10) and our own domain is trusted; the short domain is an owner purchase).
- **Token:** 32 random bytes, base64url (43 characters); only its SHA-256 is used for lookup; the plain token is stored encrypted for re-sending. Valid until `valid_until` + 30 days for viewing a signed copy; signing closes at `valid_until`.
- **Served** by the same web app at a public route outside the shell (no map, no login), phone-first, S1 look with the roofer's name (and logo once logos ship).
- **Public API** (no session; rate-limited per IP and token; under `apps/api/src/public/`, which may use `app_system` to resolve the token to a company, then everything runs in that company's `app_tenant` transaction): `GET /api/public/proposals/:token`, `POST …/view`, `POST …/sign`, `POST …/decline`, `GET …/signed.pdf`.
- **Privacy:** the page shows the homeowner's first name, the address, the options and the roofer's contact. No other customer data. `noindex`, no third-party scripts, `Referrer-Policy: no-referrer`.

### 5.2 Page content

- Header: roofer name, "Your roof proposal", address, "Valid through Nov 11".
- **Options:** up to three cards side by side (stacked on phone): name, highlights, total, the monthly estimate, "Estimate" / "Based on exact measurements"; a "Most popular" ribbon on Better.
- "What's included" (line names without unit prices — **Decision 15:** homeowners see totals and inclusions, not the roofer's unit prices (recommended because unit prices invite line-by-line haggling and expose the roofer's pricebook)).
- **Accept:** choose an option → "Accept and sign".
- **Not now:** an optional reason → declined; the roofer is told on the timeline.
- Contact: "Questions? Text us" (`sms:` the company's number) and "Call us".
- Events recorded: viewed (first and each later visit, counted), option viewed, signed, declined.

### 5.3 E-sign (master §14 record format)

- **Decision 16: typed name plus an optional drawn signature, with an explicit ESIGN consent step** (recommended because ESIGN/UETA require intent and consent to do business electronically, a typed name with a checkbox is a valid and accessible signature, and a drawn signature is reassuring to homeowners but must not be required for keyboard and screen-reader users).
- **Steps:** (1) the consent text "I agree to sign electronically and to receive this agreement electronically. I can ask for a paper copy." with a checkbox; (2) "Type your full name" (must match 2+ characters; compared case-insensitively with the customer's name only to warn, never to block); (3) optional signature pad; (4) "Sign and accept $14,250".
- **Estimate clause (Decision 17):** when the chosen option is based on an estimate, the signed agreement includes: "This price is based on an estimate of your roof's size. If the measured size differs, we'll show you the updated price and ask you to confirm before work starts." (recommended because it lets the 3-click flow end in a signature without binding the homeowner to a guessed size; **the wording goes to the owner's lawyer**).
- **Signature record** (`proposal_signatures`): `option_id`, `signer_name`, `typed_signature`, `drawn_signature_png_sha256` (the image itself goes into the signed PDF, not the table), `consent_text`, `consent_version`, `document_sha256` (SHA-256 of the canonical JSON of the proposal and the chosen option as shown), `total_cents`, `ip`, `user_agent`, `signed_at`, `viewed_first_at`, `pdf_file_id`, `pdf_sha256`.
- **Signed PDF:** C1's PDF renderer extended (master §12: "three options, signature page"): the proposal, the chosen option's inclusions and total, the estimate clause when applicable, and an **audit page** (signer, time with zone, IP, the consent text, the document hash, the signature image). Its SHA-256 is stored; the file goes to object storage; the homeowner gets a download link on the thank-you page and, when an email is on file, an email copy (Postmark).
- **Tamper evidence:** the stored `document_sha256` and `pdf_sha256` let anyone check that neither the proposal data nor the PDF changed; any later change to the job does not touch the signed record.

### 5.4 After signing

- The proposal → `signed`; other open proposals for the job → `replaced`; the job → **Won** with `value_cents` = the chosen total (C1 rule 2 satisfied); activities: "Maria signed the Better option · $14,250"; the owner's Today window and the Estimator window show it; the Estimator dock badge counts proposals waiting for an OK, not signatures.

### 5.5 Object storage

- **Decision 18: Cloudflare R2 for signed PDFs, behind an `ObjectStore` seam with a fake** (recommended because the master spec chose R2 (S3-compatible, no egress fees) and signed agreements must be kept immutable outside the database; ~$0.015/GB-month — pennies). Objects are private; downloads go through `GET …/signed.pdf`, which streams after checking the token (no public bucket URLs). Keys: `companies/<id>/proposals/<proposal-id>/signed-<sha256>.pdf`.
- New config: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`. Unset outside production → an in-database fake store (dev/test only; refused in production like `FAKE_PROVIDERS`).

## 6. Screens (web)

- **Estimator window `/estimator`** (dock app; no longer "coming soon"): an address box at the top ("Type an address to make a proposal"), then proposals grouped: Waiting for your OK (R2 drafts), Sent (with viewed / not viewed), Signed, Declined and Expired. Search by name or address.
- **Measure view `/estimator/measure/:measurementId`:** satellite map (MapTiler satellite, zoom ≈ 20) with the outline, structure toggles, the vertex editor, the pitch picker, overhang, the numbers (area, squares, pitch, edges, ridge), "Estimate" label, "Get exact report" (owner/office), and "Make proposal".
- **Proposal view `/estimator/proposals/:proposalId`:** the three option cards (editable while draft), the message preview, status and events ("Opened 3 times · last today 7:12 PM"), "Send" (creates the R2 draft and opens it), "Copy link", "Download PDF", "Make a revised proposal".
- **Job window:** a Proposals section (status chips, links) and "New proposal".
- **Settings → Prices:** C1's pricebook plus **Good / Better / Best** (the three templates) and **Financing** (APR, term) and **Estimates** (default pitch, overhang, proposal valid days, aerial measure switch — the switch only shows when the provider is configured).
- **Homeowner page `/p/:token`:** §5.
- **Phone:** everything at 375×812 with no horizontal scroll; the measure view's editor works with touch (drag a corner; long-press to delete).

## 7. API (tenant-scoped, role rules as F1 §3.2; reps work on jobs they can see)

- **Measurements:** `POST /api/measurements { propertyId | address, jobId? }` (finds the outline, computes the estimate; 201 with `MeasurementView`), `GET /api/measurements/:id`, `PATCH /api/measurements/:id { outline?, includedStructures?, pitchX12?, overhangFt?, valleyFt? }` (refused after a proposal was sent from it → 409 "Make a new measurement to change a sent proposal."), `POST /api/measurements/:id/aerial` (when enabled), `POST /api/measurements/:id/exact-report` (prices and drafts the spend task; 201 `{ taskId }`).
- **Tier templates:** `GET/PUT /api/tier-templates` (owner edits; office reads).
- **Proposals:** `POST /api/proposals { measurementId, jobId?, customer? }`, `GET /api/proposals?status=&q=`, `GET /api/proposals/:id`, `PATCH /api/proposals/:id` (options, message, while draft), `POST /api/proposals/:id/send` (creates the `proposal_send` task → `{ taskId }`), `POST /api/proposals/:id/revise`, `GET /api/proposals/:id/link` (owner/office), `GET /api/proposals/:id/pdf`.
- **Public:** §5.1.
- **Estimator settings:** `GET/PUT /api/estimator/settings` (`defaultPitchX12`, `overhangFt`, `proposalValidDays`, `aerialMeasure`, financing APR and term).

## 8. Data changes (one migration pair)

- **Global:** `building_footprints`, `building_footprint_states` (app_system owns writes; `app_tenant` gets `SELECT` on `building_footprints` — public data, no tenant column, no RLS — so measuring runs in the tenant transaction).
- **Tenant:** `measurements`, `tier_templates`, `proposals`, `proposal_counters`, `proposal_options`, `proposal_signatures`, `proposal_events`, `exact_report_orders` (`measurement_id`, `status (priced|ordering|waiting|complete|attention|canceled)`, `price_min_cents`, `price_max_cents`, `price_expires_at`, `provider_product_id`, `provider_report_id`, `reference_id`, `task_id`, `last_polled_at`, `error_plain`), `stored_files`. Standard RLS, composite FKs, grants.
- **`company_settings` gains** `default_pitch_x12 numeric(4,2) default 6`, `overhang_ft numeric(3,1) default 1`, `proposal_valid_days int default 30` (1–180), `aerial_measure bool default false`, `estimate_change_clause bool default true`.
- **Shared enums** (snake_case values banned in copy): measurement kinds and methods, proposal statuses, tiers, add-on units, event kinds; step types `send_proposal` (message) and `order_exact_report` (spend).

## 9. Errors and reliability

- As Foundation §6. Additions:
  - Footprint state not loaded or no building found → the measure view opens in "draw the outline" mode, never an error page.
  - Aerial provider failure → fall back to the free path with a note ("Aerial measure isn't available right now; this uses the outline").
  - EagleView: price expired → re-price; uncertain order → "Needs attention", never re-ordered automatically; report failed → the order and the task need attention with EagleView's status mapped to plain words.
  - Object store failure during signing → the signature is saved first (the legal record), the PDF job retries; the homeowner sees "Signed. Your copy will be ready in a minute."
  - Public page: unknown or expired token → a plain page "This proposal link has expired. Contact <company>." with the company's phone (only when the token was valid once).

## 10. Testing

- **Unit:** geodesic area and perimeter (fixtures with known areas), overhang offset, pitch factor, minimum rotated rectangle, instant estimate end to end on fixture outlines; tier pricing (each template on v1's default scope; add-on quantities); financing math (0% APR, rounding); canonical JSON and hashes; token generation and lookup.
- **Integration:** footprint loading from a small fixture GeoJSON zip; measurement creation (inside, nearest, none → draw mode); proposal build and re-price; the send step through the send gate (consent blocked, quiet hours scheduled, sent with the link); the public API (view counts, sign, decline, expired, rate limit, another company's token never resolves); signing moves the job to Won with the value; the EagleView adapters against recorded responses (price, order, uncertain order, poll pending → complete, normalization); exact report usage event once; object store fake; cross-tenant 404s.
- **Browser (Playwright):** typed address → sent in ≤ 3 clicks (desktop); the homeowner signs on phone (375×812) with the keyboard only (no drawing); the signed PDF downloads; axe on the Estimator window, the measure view, the proposal view and the homeowner page.
- **Manual smoke:** EagleView sandbox order and Property Data on a documented Omaha address; R2 upload and download; one real text with a real link on a test phone.

## 11. Acceptance criteria (E1)

- **Measure:** a seeded home with a fixture footprint gets an outline and an instant estimate whose surface area matches the formula; adjusting a corner or the pitch updates the numbers; a home with no footprint opens draw mode; the property's `footprint_id` is set.
- **Exact report:** price → spend step (owner only) → order → poll → exact measurement → draft re-priced (sent proposal → revised draft) → one `exact_report` usage event at cost; an uncertain order needs attention and is not re-ordered.
- **Proposal:** three options from the default templates, prices equal the engine's; turning an option off and editing add-ons re-prices; the financing line appears only with APR and term set.
- **Send:** the 3-click Playwright run passes; the text goes through the send gate with the link; no consent → blocked with the plain reason; the job moves to Proposal.
- **Homeowner page:** opens on phone without login; view events counted; sign with typed name (keyboard only) → signed record with both hashes, the signed PDF stored and downloadable, the job Won with the chosen value; decline records the reason; an expired link shows the plain page.
- **Settings:** templates, financing and estimate settings save; `prices_and_tiers` turns done.
- **UI rules:** copy-rules, 12px and axe tests pass; "Estimate" appears on every instant price; no vendor names outside the allowed copy files (the footprint attribution lives in `copy/legal.ts`).

## 12. Providers and costs (summary)

| Need | Provider | Cost | Status in E1 |
|---|---|---|---|
| Building outlines | Microsoft US Building Footprints (ODbL) in our PostGIS | free; DB storage ~0.3 KB/building | on |
| Satellite imagery | MapTiler (existing) | within plan quota | on |
| Geocoding | Geocodio (F3) | existing | on |
| Aerial 3D estimate | EagleView Property Data v2 | per request, commercial (not public) | built, **off** until priced |
| Exact report | EagleView Measurement Orders (Premium Residential) | ~$18–105 per report, re-billed with markup | built; production needs the partner agreement |
| Signed PDF storage | Cloudflare R2 | ~$0.015/GB-month | built; production needs the account |
| Proposal texts | Twilio via the send gate (F3) | per segment, metered (F3) | on |
| Email copy | Postmark (F1) | existing | on |

## 13. Owner to-dos

- **EagleView:** the partner/integration agreement (master §10) — production credentials for Measurement Orders, the product id and price list, and a quote for Property Data per-request pricing if the aerial switch is wanted.
- **Cloudflare R2:** create an account and a private bucket; give the four `R2_*` values.
- **Lawyer:** the e-sign consent text, the estimate-change clause, and the signed-agreement layout.
- **Domains:** the branded short-link domain for proposal links (`PROPOSAL_LINK_BASE_URL`), when bought.
- **Decide later (no build impact):** whether to bill roofers for aerial measures, and whether any company may send proposals without the one approval click.

## 14. Decisions index

1 Microsoft footprints in PostGIS · 2 MapTiler satellite · 3 outline × pitch, aerial optional · 4 draw mode when no outline · 5 custom vertex editor · 6 company default pitch · 7 EagleView Premium on Roofline's account · 8 sent measurements immutable · 9 property footprint id · 10 default tier templates · 11 re-price drafts, revise sent · 12 one approval click · 13 app-domain links until the short domain · 14 template text · 15 no unit prices to homeowners · 16 typed + optional drawn signature · 17 estimate-change clause · 18 R2 for signed PDFs.
