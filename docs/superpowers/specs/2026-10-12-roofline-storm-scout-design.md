# Roofline SaaS — Sub-project 4: Storm Scout

- **Date:** 2026-10-12
- **Status:** written by Architect 2 under the owner's standing rule ("just build, take the recommended option"). Every choice not already made in the master spec is recorded as **Decision: … (recommended because …)**; provider choices name their cost.
- **Parent:** [Master design](2026-10-10-roofline-saas-design.md) §1 feature 1, §3.1 (hail data, homes in path, storm ads, text consent), §3.2 ("likely damaged" ≥ 1", Meta limits), §5.3 (R2), §6 (hail worker), §8 row 4, §9, §13 (MESH, Google, Meta, TCPA research), §14 (Storm Scout questions). Builds on Foundation F1–F3, [Core CRM](2026-10-12-roofline-core-crm-design.md) C1 and [Estimator](2026-10-12-roofline-estimator-design.md) E1.
- **Delivery:** one milestone, **S1**, one plan (`docs/superpowers/plans/2026-10-12-roofline-storm-scout.md`).

---

## 1. Goal

The owner's feature 1: **know where hail fell, tell the roofer at once, and reach the homes in the path** — customers by text and email, every home by door-knock routes, and the area by Google and Meta ads — as **one storm plan** the owner approves in two clicks (F2's R2 flow).

1. **Hail map:** radar-estimated hail swaths (NOAA MRMS MESH), refreshed every 30 minutes, on the map home and in the Storm window, with NOAA spotter reports as dots (ported from v1).
2. **Detection:** a storm that reaches the company's threshold (default 1", master §3.2) inside its service area becomes a **company storm** with counts: customers hit, homes hit, the largest hail.
3. **Alerts:** the owner and office get an email and an in-app alert ("Hail up to 1.75" hit 212 homes near Omaha, 31 of them your customers").
4. **Storm plan draft** (agent `storm_scout`, expires 48 hours): texts to customers in the path who may get marketing texts, emails to customers in the path, door-knock routes for the reps, and Google and Meta ads on the swath — each a step with its own preview, switch and Edit; ad steps are **spend** steps (owner only).
5. **Run and results:** sent, delivered, replies, emails, doors knocked, ad clicks and landing-page requests, and inspections booked — live in the same window.
6. **Leads in:** a YES reply, a door marked "Talked — wants a check", and a request from the storm's landing page each create or advance a **Lead** job with source `storm` and the storm's id, and show on Today.

**Not in S1:** paid hail vendors (behind a seam only, Decision 2), AI-written ad creative and AI images (Decision 16), ZIP-code targeting (Google and Meta housing rules, master §13), Front Desk's automatic booking of YES replies (Front Desk), owner names or mailing lists (master §4 out).

## 2. What exists already

- **F2:** the Storm dock app and window (`features/storm/StormWindow.tsx`: "coming soon" plus the newest storm plan card with "Approve storm plan"), the map's empty `storm-swath` source and `storm-swath-fill` layer (`shell/map/layers.ts`), the Storm dock badge counting storm plan drafts, R2 review with spend steps, partial approval and `awaiting_owner`.
- **F1/F3:** `agent_tasks`/`agent_task_steps`, the `send_sms_batch` step (marketing texts need `attested`/`written`, the company name and "Reply STOP to opt out"; dedupe prefix `storm:<id>`; weekly cap; quiet hours; FL/OK/MD), `jobs.storm_id`, `company_settings.hail_threshold_in` (1.00), the hosted pages on `<slug>.<POLICY_PAGES_DOMAIN>` (F3 T17), the Geocoder (Geocodio), pg-boss and schedules, Postmark mailer, `integrations` (encrypted, company-level), setup item `connect_ads` (owned here).
- **C1:** customers/jobs windows, timeline, appointments (inspections booked count as results), Today follow-ups.
- **E1:** `building_footprints` (global, Microsoft, by state, Decision E1-1) — the "every home" source; R2 object storage.
- **v1:** `server/storms.ts` — NOAA SPC daily hail reports CSV (`https://www.spc.noaa.gov/climo/reports/<yymmdd>_rpts_hail.csv`), parsed to time, size, location, county, state, lat/lon.

## 3. Hail data

### 3.1 Source

- **Decision 1: NOAA MRMS MESH (Maximum Estimated Size of Hail), the 24-hour maximum product, from NOAA's public bucket on AWS, as the only swath source in S1** (recommended because it is **free** (AWS Open Data, no request or egress charges), national, about 1 km resolution, updated every 30 minutes (master §6, §13), and is what the master spec chose). It is calibrated to the 75th percentile of observed sizes and can underestimate, so it is always labeled **"radar-estimated"** (master §9.2).
- **Decision 2: paid hail vendors stay behind a `HailSource` seam, not built** (recommended because HailTrace, Interactive Hail Maps or CoreLogic cost hundreds to thousands of dollars a month and need contracts; the seam lets one be added if MESH proves too coarse for a market).
- **Spotter reports:** NOAA SPC daily hail reports (free), ported from v1, fetched every 30 minutes for the current convective day and the day before, stored as points, shown as small dots with size and time ("Spotter: 1.75" · 4:12 PM"). They never decide anything; they reassure.

### 3.2 The hail worker (master §6)

- **Decision 3: a Python 3.12 + GDAL service in `services/hail/`, deployed as a second Render background worker from a Docker image** (recommended because MESH arrives as gzipped GRIB2 and GDAL is the dependable reader and contourer; Node has no maintained GRIB2 decoder). Cost: one more Render worker (about **$7–25/month**, the starter-to-standard instance).
- **Every 30 minutes** (at :05 and :35, after NOAA's typical latency):
  1. List the newest `MESH_Max_1440min_00.50_<YYYYMMDD>-<HHMMSS>.grib2.gz` under `s3://noaa-mrms-pds/CONUS/MESH_Max_1440min_00.50/<YYYYMMDD>/` (anonymous HTTPS), skip one already processed (`hail_runs.source_key` unique).
  2. Decompress, read with GDAL, convert millimeters to inches.
  3. Contour at **0.75, 1.00, 1.25, 1.50, 1.75, 2.00, 2.50, 3.00 inches** (`gdal_contour -p`), simplify to ~30 m, drop rings under 0.1 km².
  4. Group the ≥ 0.75" polygons into **storms**: connected areas within the **convective day** (12:00 UTC to 12:00 UTC); a component that overlaps a storm already seen today keeps that storm's id and grows it.
  5. Write in one transaction: `hail_runs`, the storms' new geometry and per-threshold contours (replacing the previous run's), `status provisional` until the 12:00 UTC run closes the day (`final`).
- **Database role:** **Decision 4: a new `app_hail` role with INSERT/UPDATE/SELECT on the hail tables only** (recommended because the worker is a separate service and should hold no access to tenant data; same pattern as `app_tenant`/`app_system`).
- **Tests:** pytest with a stored MESH file from a real past storm (master §11): expected contour areas within 2% and fixture points inside/outside.

### 3.3 Hail tables (global, not tenant data)

- `hail_runs`: `source_key` unique, `valid_at`, `convective_day date`, `status (processed|failed)`, `max_in`, `processed_at`, `error_plain`.
- `storms`: `id`, `convective_day`, `status (provisional|final)`, `max_in`, `geom_075 geometry(MultiPolygon,4326)` (the ≥ 0.75" footprint), `bbox`, `centroid`, `place_name` ("Omaha, NE", from a reverse geocode of the centroid, cached), `first_seen_at`, `updated_at`, `final_at`.
- `storm_contours`: `storm_id`, `threshold_in`, `geom` — the latest per threshold.
- `spotter_reports`: `report_date`, `time_utc`, `size_in`, `location`, `county`, `state`, `geom point`, unique `(report_date, time_utc, geom)`.
- Read by `app_tenant` (SELECT; public weather data) and `app_system`; written only by `app_hail` (and the API's spotter job via `app_system`).

### 3.4 Size at a home

- **Decision 5: a home's hail size is the highest contour it falls inside** (0.25" steps from 0.75" to 3.00") (recommended because it needs no raster sampling in the API, is reproducible from stored polygons, and 0.25" is finer than MESH's own accuracy). Shown as "Up to 1.75" (radar-estimated)".

## 4. Detection and alerts

### 4.1 Company storms

- **`storm-match` schedule** (every 10 minutes, `app_system` fan-out, then each company in its own `app_tenant` transaction): storms of today and yesterday whose `geom_075` intersects the company's `service_area`, and whose highest contour inside the service area is ≥ the company's `hail_threshold_in`, upsert a **`company_storms`** row (tenant): `storm_id`, `status (new|planned|dismissed)`, `max_in` (inside the area), `customers_hit`, `homes_hit`, `alerted_at`, `plan_task_id`, `last_matched_at`.
- **Hits:**
  - **`storm_hits`** (tenant): one row per company **property** inside the threshold contour: `property_id`, `customer_id`, `hail_in`. Refreshed each match while the storm is provisional.
  - **Homes:** a count of `building_footprints` inside the threshold contour ∩ service area (global table, E1). The homes themselves are listed only when a route is built (§5.3).
- **Storm window badge:** the F2 badge already counts storm plan drafts; `new` company storms without a plan also count.

### 4.2 Alerts to the team

- **Decision 6: alerts go to owner and office by email and in-app; SMS alerts to the team wait for Roofline's own texting brand** (recommended because the company's 10DLC campaign is registered for customer messages, not staff alerts, and Roofline's platform brand — master §10 — is the right sender; email reaches everyone today). Settings → Team → "Storm alerts" lets each member turn email alerts off.
- **When:** at the first match ("Hail is hitting your area now — up to 1.25" so far near Omaha, NE. We'll draft a plan when it settles.") and when the plan is drafted ("Your storm plan is ready: 31 customers, 212 homes, ads up to $270."). At most one "now" alert per storm per company.
- **In-app:** the Storm window's list, the map's swath layer, Today ("Hail near Omaha yesterday · plan waiting for your OK").

### 4.3 When the plan is drafted

- **Decision 7: the plan is drafted when the storm settles** — the convective day's final run, or 90 minutes after the storm last grew, whichever is first — and **re-drafted** if it grows while still a draft (recommended because texting the first slice of a storm and then the rest would double-text neighbors and waste the weekly cap; texts can't go out before 8 AM local anyway, and 90 minutes after the last radar growth the swath is nearly always complete).

## 5. The storm plan (agent `storm_scout`, kind `storm_plan`)

- **Title:** "Storm plan for hail near Omaha, NE (up to 1.75")"; expires 48 hours after drafting (F1 expiry; "Expired — run again?" re-drafts from current data).
- **Steps** (each on by default when it can run; off with a plain reason when it can't — "No ad account connected", "Texting isn't approved yet"):

### 5.1 Text customers in the path — `send_sms_batch` (message)

- Recipients: customers with a property in `storm_hits`, not archived, with marketing consent (`attested`/`written`), not do-not-contact, not opted out — the F1 gate decides each one again at send time.
- **Decision 8: the default text** — `Hi {first_name}, it's {company}. Radar shows hail up to {hail_size} hit near your home on {street} {day}. Want a free roof check this week? Reply YES to book. Reply STOP to opt out.` (recommended because it states the observation as radar-estimated, makes one clear offer and passes the gate's content rule; Edit changes it). Per-recipient fields (`{hail_size}`, `{street}`) come from their own hit. `dedupePrefix: storm:<stormId>` so the same storm never texts a person twice (master §9.1).
- Preview: count, sample, "Sends 8:00 AM · quiet hours respected" when outside hours.

### 5.2 Email customers in the path — `send_email_batch` (message, new)

- **Decision 9: storm emails go to customers in the path with an email address who aren't do-not-contact or email-unsubscribed, regardless of texting consent** (recommended because US commercial email is opt-out (CAN-SPAM): an existing customer may be emailed with a working unsubscribe link and the sender's postal address; email reaches the many imported customers who never gave texting consent).
- **Email gate** (in `packages/send-gate`, beside `decide`): rules in order — billing; contact (an email on file; do-not-contact; the address in `email_opt_outs`); content (the company name, the company's postal address, and the `{unsubscribe}` link present); dedupe (`storm:<id>` per email address); weekly cap (2 marketing emails per person per 7 days, separate from texts); quiet hours (8 AM–9 PM local, as texts). Decisions are recorded on `messages` (`channel email`).
- **Sending:** Postmark's **broadcast** message stream (separate from login emails, as Postmark requires), from `"<Company> via Roofline" <storms@<mail domain>>` with Reply-To the company's email; `List-Unsubscribe` and one-click unsubscribe headers; the `{unsubscribe}` link opens `https://<app-domain>/u/<token>` which records an opt-out and shows "You won't get these emails from Acme Roofing anymore."
- Default subject "Hail near your home on {street}"; body in plain text and a simple HTML version (S1 tokens, no images).

### 5.3 Door-knock routes — `build_routes` (internal, new; master §14)

- **Homes:** every building footprint inside the threshold contour ∩ service area, excluding homes of customers who are do-not-contact, capped at 1,500 doors per plan (largest hail first).
- **Decision 10: routes by k-means clustering of the homes into one area per selected rep, each ordered by nearest neighbor then 2-opt, at most 150 doors per route (extra areas become extra routes)** (recommended because it gives each rep one compact walkable area without a routing vendor; roads are ignored, which is fine at walking scale inside a swath).
- **Rep assignment:** the plan's step lists the active reps (all by default); the owner switches reps off in Edit; routes are split evenly by door count. Routes appear in each rep's **Storm → My routes** on the phone.
- **Addresses:** **Decision 11: route stops get street addresses by Geocodio batch reverse geocoding when the route is built** (recommended because footprints carry no addresses, reps need an address on the door, and Geocodio charges about **$0.50 per 1,000** lookups after 2,500 free per day — ~$0.75 for a 1,500-door plan). Customers' homes use their saved address.
- **Door outcomes** (rep taps on the phone): Not home · Talked — wants a check · Talked — not interested · Already has a roofer · Do not knock. "Wants a check" opens a quick form (name, phone, "OK to text about this" checkbox → `express` consent) and creates the customer, home and a **Lead** job (source `storm`, `storm_id`) assigned to that rep; "Do not knock" marks the footprint for the company (`door_exclusions`) so future routes skip it.
- Preview: "4 routes · 600 doors · Sam 150, Pat 150, …".

### 5.4 Ads on the swath — `create_ad_campaign` (spend, new), one step per platform

- **Accounts (master §3.1, setup item `connect_ads`):**
  - **Google:** the roofer types their Google Ads customer ID; Roofline's **manager (MCC) account** sends a link invitation through the API; the roofer accepts it in Google Ads ("Accept" in Access and security); Roofline sees it active and manages the account with its one developer token.
  - **Meta:** the roofer adds **Roofline's Business portfolio as a partner** on their ad account (Business Settings → Partners → share the ad account) and types the ad account ID; Roofline's system user verifies access.
  - Stored in **`ad_accounts`** (tenant): `platform (google|meta)`, `external_account_id`, `status (pending|active|error|revoked)`, `name`, `currency`, `linked_at`, `last_error_plain`. `connect_ads` is done when one platform is active.
- **Where the ads point:** **Decision 12: a Roofline-hosted storm landing page per company storm** at `https://<slug>.<POLICY_PAGES_DOMAIN>/storm/<code>` ("Hail hit near Omaha on Tuesday — get a free roof check", the company's name, phone and a short form: name, phone, address, an unchecked "OK to text me about my request" box, and the Submit) (recommended because it captures the lead into Roofline with its consent record and storm attribution, works the same for both platforms, and avoids Meta lead-form webhooks and Google lead-form downloads; the hosted-page domain already exists from F3). A request creates the customer (consent `express` with source `web_form` when the box is checked, evidence = the page's text and time), home, a Lead job (source `storm`, `storm_id`, `web`), an activity, and a Today follow-up.
- **Google (Decision 13):** a **Search** campaign with keywords from a template list ("roof repair", "hail damage roof", "roof inspection", "roofer near me", "storm damage roof repair"), one responsive search ad (headlines and descriptions from templates with the company name, the city and "Free roof inspection"), and **proximity targets covering the swath** (recommended because search intent after a storm is the highest-converting Google ad type and needs no images). **Covering the swath (master §14):** a hexagonal grid of circles over (threshold contour ∩ service area), radius starting at 1 km (Google's minimum), doubled until the circles number ≤ 50; keep circles that touch the area. Daily budget = max spend ÷ days (default 7 days), end date set, so the platform can't exceed the max.
- **Meta (Decision 14):** a **Traffic** campaign to the landing page with `custom_locations` circles over the swath (radius ≥ 1 mile, Meta's minimum is 0.63; doubled until ≤ 50 circles), **not** declared as a Housing special ad category (roofing repair is home improvement, not housing sales, rentals, home insurance or mortgages) — **if Meta rejects or flags the campaign as Housing, it is recreated once as Housing with a single 15-mile circle around the swath's center** (master §3.2 fallback) and the step says so. Creative: **Decision 15:** one image — the roofer's own photo from Settings → Storm (up to 5, stored in R2) or, when none, a branded card rendered on the server (company name, "Free roof check after the hail", S1 colors) (recommended because stock photos need licensing and generated imagery is out of S1); primary text and headline from templates.
- **Decision 16: ad copy is template-based, editable in the step's Edit; no AI-written copy in S1** (recommended because templates pass both platforms' policies predictably; AI copy can be added inside the same step later).
- **Spend (master §9.1, §5.3):**
  - Each platform step's preview shows the area (circle count and a map thumbnail), budget per day, days, and **"Up to $270"**; it is a **spend** step: owner only (or office with delegation); approving creates the campaign **paused**, sets its total cap by daily budget × days and end date, then enables it.
  - **`ad-spend-sync`** (hourly) reads spend, impressions, clicks for active campaigns; at **95% of the approved max** Roofline pauses the campaign itself (a second guard beyond the platform's budget) and the step result says "Paused at the approved maximum".
  - Ad spend is billed by Google and Meta to the roofer's own card; **Roofline adds no charge for ads in S1** (no new usage kind).
- **`ad_campaigns`** (tenant, master §7): `company_storm_id`, `step_id`, `platform`, `external_campaign_id`, `status (creating|paused|active|ended|failed)`, `daily_budget_cents`, `days`, `max_spend_cents`, `spend_cents`, `impressions`, `clicks`, `landing_requests`, `targets jsonb` (circles), `creative jsonb`, `housing_fallback bool`, `last_synced_at`, `error_plain`.
- **Default spend:** **Decision 17: $270 over 7 days split $150 Google / $120 Meta, a company setting** (recommended because it matches the reel's example ("up to $270"), is small enough for a first storm, and the owner sees and edits it on every plan).

### 5.5 Results (same window, master §5.3)

- Texts: sent, delivered, replies, "YES" replies (from the F1 inbound path: an inbound text from a customer with an unexpired storm text, matching yes-words, creates or advances their Lead job with the storm id and adds a Today follow-up "Maria replied YES to the storm text").
- Emails: sent, unsubscribes.
- Routes: doors knocked, wants a check.
- Ads: spend so far / max, clicks, landing-page requests.
- **Inspections booked:** C1 appointments of kind inspection on jobs with this `storm_id` created after the plan ran.
- `minutes_saved` per step type (F1 config): texts 1.5 min per recipient (capped), emails 0.5 min per recipient, routes 2 hours per route, ads 45 minutes per platform.

## 6. Screens

- **Storm window `/storm`:** list of company storms (newest first): place, day, "Up to 1.75" (radar-estimated)", customers and homes hit, plan status, and "Approve storm plan" (F2's 2-click path) / "See plan". A small map of the swath with contour colors (`--hail-1`…`--hail-5`), spotter dots, and customer pins inside.
- **Storm detail `/storm/:companyStormId`:** the swath map, counts, the plan (links to R2 review `/storm/plans/:taskId`), results, "Dismiss this storm" (owner/office).
- **Map home:** the swath layer slot (F2) shows storms of the last 7 days (master §5.1) with the hail colors, spotter dots, a legend "Radar-estimated hail".
- **Phone — My routes `/storm/routes`** and **route `/storm/routes/:routeId`:** the stops on a map with the rep's location (browser geolocation, only while the page is open), a list ordered by route, big outcome buttons per door (40px+), "Navigate" (opens the phone's maps app).
- **Settings → Storm:** threshold (0.75–2.00), default ad budget and days and the Google/Meta split, alert emails on/off per member, ad photos, the text and email templates (defaults shown).
- **Settings → Connections:** Google Ads and Meta ad account linking (instructions with Roofline's manager ID and Business ID, an ID field, status).

## 7. API (tenant-scoped; roles as F1)

- `GET /api/storms?since=` (company storms), `GET /api/storms/:id` (detail with swath GeoJSON simplified for display, counts, plan, results), `POST /api/storms/:id/dismiss`, `POST /api/storms/:id/plan` (re-draft now).
- `GET /api/map/storm-layer?days=7` (swaths and spotter reports in the company's view; GeoJSON, simplified).
- `GET /api/routes/mine`, `GET /api/routes/:id`, `POST /api/routes/:id/stops/:stopId/outcome { outcome, lead? }`.
- `GET/PUT /api/storm/settings`, `POST /api/storm/photos` (multipart to R2), `DELETE /api/storm/photos/:id`.
- `GET /api/ads/accounts`, `POST /api/ads/accounts/google { customerId }`, `POST /api/ads/accounts/meta { adAccountId }`, `POST /api/ads/accounts/:id/check`, `DELETE /api/ads/accounts/:id`.
- **Public (no session):** `GET /storm/:code` on the company host (landing page HTML, served like F3's policy pages), `POST /api/public/storm-requests/:code` (rate-limited; honeypot field; one request per phone per storm), `GET/POST /u/:token` (email unsubscribe).

## 8. Data changes (one migration pair)

- **Global:** `hail_runs`, `storms`, `storm_contours`, `spotter_reports` (with the `app_hail` role and its grants).
- **Tenant:** `company_storms`, `storm_hits`, `door_routes` (`company_storm_id`, `user_id`, `name`, `status (ready|in_progress|done)`, `stops`), `door_stops` (`route_id`, `position`, `footprint_id` (nullable), `property_id` (nullable), `point`, `address`, `hail_in`, `outcome`, `outcome_at`, `outcome_by`, `created_customer_id`, `created_job_id`), `door_exclusions` (`footprint_id`, `reason`), `ad_accounts`, `ad_campaigns`, `storm_pages` (`company_storm_id`, `code` unique, `active_until`), `storm_requests` (the landing-page submissions, linked to the created records), `email_opt_outs` (`email` citext, `source`, `at`), `storm_photos` (`stored_file_id`).
- **`company_settings` gains** `storm_ad_budget_cents` (27000), `storm_ad_days` (7), `storm_ad_google_share_pct` (55), `storm_email_enabled bool` (true), `storm_sms_template text`, `storm_email_subject text`, `storm_email_template text` (nullable → defaults).
- **`memberships` gains** `storm_alert_email bool default true` (global table; written through the team routes).
- **Shared:** step types `send_email_batch` (message), `build_routes` (internal), `create_ad_campaign` (spend); message channel `email` is already in F1's `MESSAGE_CHANNELS`.

## 9. Providers and costs

| Need | Provider | Cost | S1 |
|---|---|---|---|
| Hail swaths | NOAA MRMS MESH (AWS Open Data) | free | on |
| Spotter reports | NOAA SPC | free | on |
| Paid hail data | HailTrace / IHM / CoreLogic | $100s–$1,000s/month, contracts | seam only |
| Hail worker host | Render background worker (Docker) | ~$7–25/month | on |
| Homes in path | Microsoft footprints (E1) | storage only | on |
| Stop addresses | Geocodio reverse batch | ~$0.50 per 1,000 after 2,500/day free | on |
| Storm emails | Postmark broadcast stream | ~$1.25 per 1,000 emails beyond the plan (Postmark pricing) | on |
| Storm texts | Twilio via the send gate (F3) | per segment, metered to the roofer (F3) | on |
| Google ads | Google Ads API (free) via Roofline's manager account; spend on the roofer's card | API free; spend by roofer | built; needs Basic developer-token access |
| Meta ads | Marketing API (free) via Roofline's Business portfolio; spend on the roofer's card | API free; spend by roofer | built; needs App Review (Advanced Access) |
| Ad images | roofer's photos in R2, or a server-rendered card | pennies | on |

## 10. Errors and reliability

- As Foundation §6. Additions:
  - **Hail worker:** a failed run is recorded and retried at the next tick; three failures in a row email ops (`OPS_ALERT_EMAIL`); the Storm window shows "Hail data is a little behind (last update 2:05 PM)" when the newest run is over 90 minutes old.
  - **Ads:** a platform error on create → the step needs attention with a plain reason (account not linked, payment problem on the ad account, policy rejection); nothing retries a create that may have succeeded without first searching for the campaign by its name tag (`Roofline storm <id>`); spend sync failures retry; the 95% pause is retried every 10 minutes until confirmed.
  - **Idempotency:** each step's idempotency key is the job id (F1); routes and campaigns are keyed by `company_storm_id` + step so a retry finds the existing one.

## 11. Testing

- **Python worker:** pytest on the stored MESH fixture (contour areas, storm grouping across two runs, convective-day boundary, provisional → final).
- **Unit (TypeScript):** circle covering (count ≤ 50, all area covered, 1 km minimum), k-means + 2-opt routes (deterministic seed, ≤ 150 per route, every home once), the email gate rules, template rendering (`{hail_size}`, `{street}`, `{unsubscribe}`), YES-word matching, Meta housing fallback decision.
- **Integration:** storm match with fixture storms against seeded service areas (threshold edges, two companies, provisional growth, settle timing), plan drafting and re-drafting, the steps through fakes (SMS fake, email fake, Geocodio fake, Google and Meta fakes with recorded responses), the 95% pause, landing-page requests and unsubscribe, YES replies, cross-tenant isolation on every new route and table.
- **Browser (Playwright):** the 2-click storm plan approval from the Storm window with all five steps on (fakes), the phone route view marking a door "wants a check" (creates the lead), the landing page on phone, axe on the Storm window, detail and route view.
- **Manual smoke:** the worker on the latest real MESH file; one Google Ads test account linked to Roofline's test manager account and a paused test campaign; one Meta test ad account shared with Roofline's test Business and a paused campaign; a real broadcast email with unsubscribe.

## 12. Acceptance criteria (S1)

- **Hail:** the worker turns the fixture MESH file into contours and storms with the expected areas; runs every 30 minutes; the map shows swaths of the last 7 days and spotter dots, labeled radar-estimated.
- **Detection:** a fixture storm over Acme's service area creates a company storm with the right customers and homes hit, emails owner and office once, and drafts the plan when it settles; growth re-drafts an unapproved plan; a storm below the threshold or outside the area does nothing.
- **Plan:** five steps with previews; turning steps off works; an office user approves texts, email and routes while the two ad steps wait for the owner (partial approval); the owner approves them; 2 clicks from the Storm window with one plan.
- **Run:** texts go only to marketing-consented customers (the gate's counts), each person once per storm; emails carry the unsubscribe link and address and respect opt-outs; routes cover every home once with ≤ 150 each and addresses filled; Google and Meta campaigns are created with circles covering the area, budgets capping spend, and the Meta housing fallback when flagged; spend sync pauses at 95%.
- **Leads:** a YES reply, a door "wants a check" and a landing-page request each give a Lead job with the storm id and a Today follow-up; inspections booked count in results.
- **Accounts:** Google and Meta linking flows reach `active` with the fakes; `connect_ads` turns done.
- **UI rules:** copy-rules (vendor names only in `copy/connections.ts`/`setup.ts`), 12px, axe; no horizontal scroll at 375px on the route view and landing page.

## 13. Owner to-dos (lead time; master §10)

- **Google Ads:** a manager (MCC) account for Roofline and a developer token with **Basic access** (about 2 business days after applying; test-only until approved).
- **Meta:** a developer app with **Business Verification** and **Advanced Access for `ads_management` and `ads_read`** (days to ~2 weeks), Roofline's Business portfolio and a system user.
- **Postmark:** a **broadcast** message stream and the mail sending domain's DNS (SPF/DKIM/Return-Path) for storm emails.
- **Render:** a second background worker for the Python hail service (~$7–25/month).
- **Ops alert email** for the hail worker (`OPS_ALERT_EMAIL`).
- **Roofline's own texting brand** (master §10) before SMS team alerts can be added.
- **Lawyer:** the storm text and email wording, the landing-page consent checkbox text, and ad copy claims ("free roof check").

## 14. Decisions index

1 MESH from AWS Open Data · 2 paid hail behind a seam · 3 Python + GDAL worker on Render · 4 `app_hail` role · 5 highest contour = home's size · 6 team alerts by email and in-app · 7 draft when the storm settles · 8 default storm text · 9 storm emails under CAN-SPAM · 10 k-means + 2-opt routes, ≤ 150 doors · 11 Geocodio reverse for stops · 12 hosted storm landing page · 13 Google Search with proximity circles · 14 Meta Traffic with circles and the Housing fallback · 15 roofer photo or a rendered card · 16 template ad copy · 17 $270 over 7 days default.
