# Roofline Storm Scout (S1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. In this repo the team script runs each task with one Sonnet lead and up to three Haiku builders on the **Split** packages.

**Goal:** Radar hail swaths on the map every 30 minutes; a storm over a roofer's service area at or above their threshold becomes a company storm with customers and homes counted, an email and in-app alert, and — once it settles — one `storm_scout` plan of five steps (texts through the F1/F3 send gate, CAN-SPAM emails, door-knock routes, a Google Search campaign and a Meta Traffic campaign on the swath, the two ad steps owner-approved spend) approved in two clicks, with leads from YES replies, doors and the storm landing page landing as storm-tagged Lead jobs and live results in the Storm window.

**Architecture:**
- **A separate Python 3.12 + GDAL hail service** (`services/hail/`) owns MESH download, contouring and storm grouping, writing four global tables as the least-privilege `app_hail` role. Paid hail vendors sit behind its `HailSource` protocol (not built). The Node API never decodes radar.
- **Skeletons first:** Task 1 (schema, migrations, roles, npm dependencies, placeholders, barrels), Task 7 (API seams with fakes — `AdsGoogle`, `AdsMeta`, `BroadcastMailer`, `Geocoder.reverseMany`, `AdImageRenderer` — config, job names, schedules, step handler registration, route stubs and mounts, public routes), Task 22 (web routes, Storm window slots, Settings sections, copy files).
- **Pure logic in `@roofline/shared`** (`storm.ts`: templates, yes-words, budgets, circle radii; `door-routes.ts`: k-means + 2-opt) and **`@roofline/send-gate`** (`decideEmail`). Geometry that needs PostGIS (contains, hex grids, intersections) lives in repos.
- **Every paid or external call behind a seam with a deterministic fake** (F3 Ruling 29); real Google Ads and Meta adapters use plain `fetch` (no SDKs) and are tested against recorded JSON.

**Tech Stack:** as C1/E1. New npm (`apps/api`): `@resvg/resvg-js` (the branded ad card, SVG → PNG). New service: Python 3.12, GDAL 3.8+ (`osgeo` bindings via the `ghcr.io/osgeo/gdal:ubuntu-small-3.8.*` image), `psycopg[binary]` 3, `shapely` 2, `boto3`-free anonymous HTTPS to the NOAA bucket (`httpx`), `pytest`.

**Spec:** `docs/superpowers/specs/2026-10-12-roofline-storm-scout-design.md` (decisions numbered there). Parents: master §1, §3.1–3.2, §6, §9, §13–14; Foundation F1–F3; C1 (customers, jobs, appointments, Today follow-ups); E1 (`building_footprints`, the R2 `ObjectStore`, `stored_files`).

**Branch:** integration branch `s1-storm` from `e1-estimator` once E1 is merged; task branches `s1-t<N>`.

---

## Global Constraints

- **Everything in C1's and E1's Global Constraints applies** (TypeScript/ESM, `enumCheck`, tenant tables with forced RLS and composite FKs, `app_system` column grants plus `app_system_all`, no raw queries from routes, `{error, field?}` errors with module-constant messages, secrets only from `config.ts`, copy rules, hooks in `features/<feature>/api.ts`, no third-party UI library, 12px / AA / 40px / 375px, company time zone, integer cents).
- **Global hail tables** (`hail_runs`, `storms`, `storm_contours`, `spotter_reports`) carry no tenant data: `app_tenant` SELECT only; `app_hail` writes the first three; `app_system` writes `spotter_reports`.
- **`@roofline/db/system`** is allowed in `apps/api/src/jobs/scheduler/**` (storm-match and ad-spend-sync fan-outs) and `apps/api/src/public/**` (landing page code → company; unsubscribe token → company).
- **"Radar-estimated"** labels every hail size in the app, the alert email, the plan preview and the map legend (master §9.2). Customer texts and emails say "Radar shows hail up to …".
- **No owner names** for non-customer homes anywhere (master §3.1); route stops show an address and nothing else.
- **Every outbound customer text goes through `send_sms_batch` and the F1 gate; every storm email through `decideEmail`.** Nothing calls an adapter directly.
- **Ad spend:** nothing creates or enables a campaign except the `create_ad_campaign` step after an approval that satisfies its `spend` class; the platform budget (daily × days, with end date) is ≤ the approved `maxSpendCents`; the 95% pause is a second guard.
- **Provider text** (Google, Meta, Postmark, NOAA) is never shown; store status codes and our own plain messages. Google/Meta policy-rejection reasons map to a short plain list (`policy`, `payment`, `access`, `targeting`, `other`).
- **Lockfile:** only Task 1 edits `package-lock.json`. **Migrations:** only Task 1 (`0016` generated, `0017` custom) — E1 used 0014/0015. The Python service never runs migrations.
- **Python:** `ruff` + `pytest` in CI only (a new `hail` job in `.github/workflows/ci.yml`, GDAL image); nothing Python runs on the build box.

## Review Focus

1. **No money moves without the owner.** Ad steps are `spend`; the handler re-checks the step's approval and the account's `active` status; a retried create first searches by the name tag `Roofline storm <companyStormId> <platform>`; budget × days ≤ the approved max; the 95% pause fires and is retried. (Tasks 6, 19)
2. **Consent and law.** Storm texts are marketing (attested/written only, STOP text, dedupe per storm, weekly cap, FL/OK/MD); emails carry the postal address and a working one-click unsubscribe, honour `email_opt_outs` before every send; landing-page consent is opt-in and recorded with evidence. (Tasks 6, 12, 13, 20)
3. **One company's storm data stays theirs.** Global hail and footprints are shared; hits, routes, campaigns, pages and requests are tenant tables; the landing page and unsubscribe resolve exactly one company. (Tasks 1, 9, 20)
4. **No double-texting.** Re-drafting replaces a draft, never a running or approved plan; dedupe `storm:<companyStormId>`; YES replies attach to the newest storm text only once. (Tasks 10, 11, 21)
5. **Hail correctness.** Contour levels, mm→in, convective-day boundaries, storm ids stable across runs, provisional → final, "data is behind" banner. (Tasks 2, 3, 8)

---

## Parallel lanes

| Task | Depends on (S1) | Notes |
|---|---|---|
| 1 Schema, migrations, roles, dependency, skeleton | — | only lockfile and migration edits |
| 2 Hail service: MESH fetch and contours | 1 | `services/hail/` |
| 3 Hail service: storms, writer, Docker, Render, CI | 2 | only `ci.yml`/`render.yaml` edits |
| 4 Shared storm logic: templates, yes-words, budgets, circle radii | 1 | `shared/storm.ts` |
| 5 Shared door routes: k-means and 2-opt | 1 | `shared/door-routes.ts` |
| 6 Step types and the email gate | 1 | `shared/steps.ts`, `send-gate/email.ts` |
| 7 API skeleton: seams, fakes, config, jobs, schedules, mounts | 1, 6 | only `app.ts`/`config.ts`/`deps.ts`/`test/helpers.ts`/`jobs/*`/`tasks/handlers.ts` edits |
| 8 Spotter reports and the map storm layer API | 7 | |
| 9 Storm match: company storms and hits | 7 | |
| 10 Alerts and the settle trigger | 9 | |
| 11 Storm plan drafting | 4, 6, 10 | |
| 12 `send_email_batch` handler and the email send path | 6, 7 | |
| 13 Postmark broadcast adapter and unsubscribe | 7 | |
| 14 `build_routes` handler | 5, 7, 9 | |
| 15 Door outcomes API and leads from doors | 14 | |
| 16 Ad accounts: linking Google and Meta | 7 | `shared/setup.ts` + `repos/setup.ts` |
| 17 Google Ads adapter | 7 | |
| 18 Meta Marketing adapter | 7 | |
| 19 `create_ad_campaign` handler, creative card, spend sync | 16, 17, 18 | |
| 20 Storm landing page and requests | 7, 9 | `apps/api/src/public/storm*.ts` |
| 21 YES replies, results and storm API | 9, 11 | `hooks/twilio.ts` one call added |
| 22 Web skeleton | 6 | only `router.tsx`/`apps.ts`/`SettingsPage`/`ConnectionsSection` slots |
| 23 Web: Storm window and storm detail | 22 | |
| 24 Web: map storm layer | 22 | `shell/map/*` |
| 25 Web: plan review previews and Edit for the new steps | 22 | `features/approvals/steps/*` |
| 26 Web: phone routes | 22 | |
| 27 Web: Settings → Storm and ad connections | 22 | |
| 28 End-to-end, acceptance map, docs | 8–27 | |
| 29 Manual smoke: real MESH, Google and Meta test accounts, a broadcast email | 3, 17, 18, 13 | |

**Waves (proposed team groups of three):**
- **Wave 1:** T1.
- **Wave 2:** G1 = T4, T5, T6 · T2 (Python, its own lane).
- **Wave 3:** G2 = T7, T3, T22.
- **Wave 4:** G3 = T8, T9, T13 · G4 = T16, T17, T18 · G5 = T23, T24, T27.
- **Wave 5:** G6 = T10, T12, T14 · G7 = T20, T25, T26.
- **Wave 6:** G8 = T11, T15, T19 · then T21.
- **Wave 7:** T28; T29 by hand.

**Shared files:** barrels get every S1 line in Task 1; `shared/steps.ts` only in Task 6; `send-gate/src/index.ts` only in Task 6; `shared/setup.ts` and `repos/setup.ts` only in Task 16 (`connect_ads`); `hooks/twilio.ts` only in Task 21 (one call); `messaging/send-batch.ts` only in Task 11 and only if it lacks a per-customer render hook (Ruling 6); `features/storm/StormWindow.tsx` (F2) is replaced in Task 23 only; `shell/map/layers.ts` only in Task 24.

---

## File structure

```
services/hail/ pyproject.toml Dockerfile README.md                                      T2, T3
services/hail/hail/ mesh.py contours.py source.py (HailSource) units.py               T2
services/hail/hail/ storms.py writer.py run.py main.py                                T3
services/hail/tests/ fixtures/mesh-<date>.grib2.gz test_{mesh,contours,storms,writer}.py T2, T3
packages/db/migrations/0016_storm_schema.sql 0017_storm_grants_rls.sql                T1
packages/db/src/schema/{global,tenant,enums}.ts                                       T1
packages/db/src/repos/ storm-layer.ts (T8) company-storms.ts storm-hits.ts (T9) storm-plans.ts (T11)
                       email-sends.ts email-opt-outs.ts (T12, T13) door-routes.ts (T14, T15)
                       ad-accounts.ts (T16) ad-campaigns.ts storm-geo.ts (T19) storm-pages.ts (T20) storm-results.ts (T21)
packages/db/src/system/ spotter.ts (T8) storm-match-fanout.ts (T9) ad-sync-fanout.ts (T19) storm-page-lookup.ts (T20) unsubscribe-lookup.ts (T13)
packages/shared/src/ storm.ts (T4) door-routes.ts (T5) steps.ts (T6 edits)
packages/send-gate/src/ email.ts (T6)
apps/api/src/providers/ ads-google.ts ads-meta.ts broadcast.ts ad-image.ts fakes/{ads-google,ads-meta,broadcast,ad-image}.ts (T7)
                        google-ads/{http,link,campaigns,report}.ts (T17) meta/{http,link,campaigns,report}.ts (T18)
                        postmark-broadcast.ts (T13) resvg-card.ts (T19) geocodio.ts (T7: reverseMany)
apps/api/src/storm/ spotter.ts (T8) match.ts (T9) alerts.ts settle.ts (T10) plan.ts (T11) email-batch.ts (T12)
                    routes-build.ts (T14) doors.ts (T15) ad-accounts.ts (T16) ad-campaign.ts ad-sync.ts creative.ts (T19)
                    landing.ts (T20) replies.ts results.ts (T21)
apps/api/src/routes/ storms.ts (T21) door-routes.ts (T15) storm-settings.ts (T27 API half: T16) ads.ts (T16)
apps/api/src/public/ storm-page.ts storm-requests.ts (T20) unsubscribe.ts (T13)
apps/api/src/jobs/scheduler/ spotter-sync.ts (T8) storm-match.ts (T9) ad-spend-sync.ts (T19) hail-health.ts (T10)
apps/web/src/features/storm/ (T23) storm/routes/ (T26) settings/{StormTab,AdConnections}.tsx (T27)
apps/web/src/features/approvals/steps/{EmailBatch,BuildRoutes,AdCampaign}Preview.tsx (T25)
apps/web/src/shell/map/{stormLayer.ts,HailLegend.tsx} (T24)
apps/web/src/copy/ storm.ts doors.ts ads.ts (new) connections.ts (Google Ads / Meta names)
apps/web/e2e/ storm.spec.ts doors.spec.ts (T28)
docs/superpowers/ s1-acceptance.md s1-manual-smoke.md (T28, T29)
```

---

### Task 1: Dependency, S1 schema, roles and the module skeleton

**Split:** Builder 1 schema TS + `0016`; Builder 2 `0017` (the `app_hail` role, grants, RLS) + `rls.test.ts`/`migrations.test.ts`; Builder 3 the npm dependency, placeholders, barrels, shared enum constants.

**Files:**
- Modify: `packages/db/src/schema/{global,tenant,enums}.ts`, `packages/db/src/{index,system/index}.ts`, `packages/shared/src/{index,enums}.ts`, `apps/api/package.json`, `package-lock.json`, `ops/db/roles.sql` (or wherever F1 creates `app_tenant`/`app_system` — the same file gains `app_hail` with a `HAIL_DATABASE_URL` password note)
- Create: `packages/db/migrations/0016_storm_schema.sql` (generated), `0017_storm_grants_rls.sql` (custom), meta; placeholders (`export {};`) for every repo, system module and shared file in the file structure
- Test: `packages/db/test/{migrations,rls}.test.ts` (extend)

**Interfaces:**
- **npm (`apps/api`):** `@resvg/resvg-js`.
- **Shared constants** (`packages/shared/src/storm.ts` now; Task 4 adds the logic): `HAIL_LEVELS_IN = [0.75,1,1.25,1.5,1.75,2,2.5,3] as const`, `STORM_STATUSES = ['provisional','final'] as const`, `HAIL_RUN_STATUSES = ['processed','failed'] as const`, `COMPANY_STORM_STATUSES = ['new','planned','dismissed'] as const`, `DOOR_ROUTE_STATUSES = ['ready','in_progress','done'] as const`, `DOOR_OUTCOMES = ['not_home','wants_check','not_interested','has_roofer','do_not_knock'] as const`, `AD_PLATFORMS = ['google','meta'] as const`, `AD_ACCOUNT_STATUSES = ['pending','active','error','revoked'] as const`, `AD_CAMPAIGN_STATUSES = ['creating','paused','active','ended','failed'] as const`, `AD_ERROR_KINDS = ['policy','payment','access','targeting','other'] as const`, `EMAIL_OPT_OUT_SOURCES = ['link','one_click','complaint','manual'] as const`; `JOB_SOURCES` gains `'storm'` if absent (check C1's list; add in `enums.ts`); `STORED_FILE_KINDS` gains `'storm_photo'`, `'ad_image'`.
- **Global tables** (spec §3.3): `hail_runs` (`id bigserial`, `source_key text unique`, `valid_at`, `convective_day date`, `status` CHECK, `max_in numeric(4,2)`, `processed_at`, `error_plain`); `storms` (`id uuid pk default gen_random_uuid()`, `convective_day date`, `status`, `max_in numeric(4,2)`, `geom_075 geometry(MultiPolygon,4326)` GIST, `bbox geometry(Polygon,4326)`, `centroid geometry(Point,4326)`, `place_name text`, `first_seen_at`, `updated_at`, `last_grew_at`, `final_at`; index `(convective_day)`); `storm_contours` (`storm_id` FK, `threshold_in numeric(4,2)`, `geom geometry(MultiPolygon,4326)` GIST, pk `(storm_id, threshold_in)`); `spotter_reports` (`id bigserial`, `report_date date`, `time_utc time`, `size_in numeric(4,2)`, `location`, `county`, `state char(2)`, `geom geometry(Point,4326)` GIST, unique `(report_date, time_utc, geom)`).
- **Tenant tables** (company_id, timestamps, `unique (company_id, id)`, composite FKs, in `TENANT_TABLES`) — columns exactly as spec §4.1, §5, §8: `company_storms` (unique `(company_id, storm_id)`; `storm_id` → `storms.id` plain FK), `storm_hits` (unique `(company_storm_id, property_id)`), `door_routes`, `door_stops` (unique `(route_id, position)`; `footprint_id bigint` → `building_footprints.id`), `door_exclusions` (unique `(company_id, footprint_id)`), `ad_accounts` (unique `(company_id, platform)`), `ad_campaigns` (unique `(company_id, step_id)`, unique `(platform, external_campaign_id)` where not null), `storm_pages` (unique `code` globally), `storm_requests` (unique `(storm_page_id, phone_e164)`), `email_opt_outs` (unique `(company_id, email)`), `storm_photos`.
- **`messages` gains** `to_email citext` and `subject text` (both nullable; CHECK `channel <> 'email' OR to_email IS NOT NULL`).
- **`company_settings` gains** spec §8's seven columns with CHECKs (`storm_ad_budget_cents` 0–1,000,000; `storm_ad_days` 1–30; `storm_ad_google_share_pct` 0–100); **`memberships` gains** `storm_alert_email boolean not null default true`.
- **`0017`:** `CREATE ROLE app_hail NOLOGIN` guarded (`DO $$ … IF NOT EXISTS`), login granted by ops; `GRANT SELECT, INSERT, UPDATE ON hail_runs, storms, storm_contours TO app_hail` (+ sequences, `DELETE` on `storm_contours` only); `GRANT SELECT ON hail_runs, storms, storm_contours, spotter_reports TO app_tenant`; `GRANT ALL ON spotter_reports TO app_system` + SELECT/UPDATE (`place_name`) on `storms` to `app_system`; tenant grants on the eleven tables (no DELETE except `door_exclusions` and `storm_photos`); `app_system` column grants + `app_system_all` on `company_storms (id, company_id, storm_id, status, plan_task_id, last_matched_at)`, `ad_campaigns (id, company_id, status, external_campaign_id, platform)`, `storm_pages (id, company_id, code, active_until, company_storm_id)`, `email_opt_outs` (INSERT for the public unsubscribe); tenant UPDATE grants on the new settings/membership columns (membership through the existing team path).
- [ ] **Tests:** the eleven are tenant tables with RLS forced; `app_hail` can write `storms` and cannot SELECT `customers` (42501); `app_tenant` reads `storms` under any `app.company_id` and can't write it; `storm_pages.code` unique across companies; the messages email CHECK; extended grant lists.
- [ ] **Verify:** db suite on CI (`ops/bin/ci-check`); typecheck, lint locally.
- [ ] **Commit:** `feat(db): S1 schema (hail, company storms, routes, ads, storm pages, email opt-outs) and the app_hail role`

---

### Task 2: Hail service — MESH fetch and contours

**Split:** Builder 1 `source.py` (`HailSource` protocol, `MeshSource`) + `mesh.py` (list/download/decompress); Builder 2 `contours.py` + `units.py`; Builder 3 `pyproject.toml`, fixture capture script note, `tests/test_{mesh,contours}.py`.

**Files:** Create `services/hail/{pyproject.toml,README.md}`, `services/hail/hail/{__init__,source,mesh,contours,units}.py`, `services/hail/tests/{conftest,test_mesh,test_contours}.py`, `services/hail/tests/fixtures/` (one real MESH_Max_1440min file from a known past storm, ≤ 2 MB gz, plus `expected.json` with areas per level — captured by the lead once, documented in README).

**Interfaces:**
```python
# source.py
class HailGrid(NamedTuple): valid_at: datetime; key: str; path: Path   # decompressed GRIB2 on disk
class HailSource(Protocol):
    name: str
    def latest(self, after_key: str | None) -> HailGrid | None: ...   # None = nothing new
class MeshSource:  # https://noaa-mrms-pds.s3.amazonaws.com/?list-type=2&prefix=CONUS/MESH_Max_1440min_00.50/<YYYYMMDD>/
    def __init__(self, http: httpx.Client, workdir: Path, base_url: str = "https://noaa-mrms-pds.s3.amazonaws.com"): ...
# mesh.py
def list_keys(http, base_url, day: date) -> list[str]            # sorted, parses the ListBucketResult XML
def parse_valid_at(key: str) -> datetime                         # MESH_Max_1440min_00.50_YYYYMMDD-HHMMSS.grib2.gz → UTC
def download(http, base_url, key, workdir) -> Path               # streams, gunzips, returns .grib2 path
# contours.py
class Contour(NamedTuple): threshold_in: float; geom: shapely.MultiPolygon   # EPSG:4326
def contour_grid(path: Path, levels_in=HAIL_LEVELS_IN, simplify_m=30, min_area_km2=0.1) -> list[Contour]
# units.py
MM_PER_IN = 25.4 ; HAIL_LEVELS_IN = (0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0)   # must equal @roofline/shared HAIL_LEVELS_IN (a test reads shared/src/storm.ts)
def convective_day(t: datetime) -> date                           # 12Z–12Z: t < 12:00Z → previous day
```
- `contour_grid`: open with GDAL, treat ≤ 0 and the product's missing values (-1, -3) as nodata, levels in mm (`level_in * 25.4`), `gdal.ContourGenerateEx` with `FIXED_LEVELS` and `POLYGONIZE=YES`, reproject nothing (MRMS grids are lat/lon), simplify in a local equal-area projection (EPSG:5070) then back; each level's polygon is "≥ level" (union of higher bands).
- [ ] **Tests:** `parse_valid_at`/`convective_day` boundaries (11:59Z, 12:00Z); `list_keys` with a recorded XML; the fixture's per-level areas within 2% of `expected.json`; nested levels (each higher level within the lower one); a point list inside/outside per `expected.json`; levels match the shared constant.
- [ ] **Verify:** CI `hail` job only (`ruff check`, `pytest`).
- [ ] **Commit:** `feat(hail): fetch NOAA MRMS MESH and contour it into hail levels`

---

### Task 3: Hail service — storms, writer, Docker, Render, CI

**Split:** Builder 1 `storms.py` (grouping and stable ids); Builder 2 `writer.py` + `run.py` + `main.py`; Builder 3 `Dockerfile`, `render.yaml` worker, the CI `hail` job (with a PostGIS service for the writer test), README.

**Files:** Create `services/hail/hail/{storms,writer,run,main}.py`, `services/hail/Dockerfile`, `services/hail/tests/{test_storms,test_writer}.py`; Modify `render.yaml` (new `worker` service `roofline-hail`, Docker, `HAIL_DATABASE_URL` secret, `OPS_ALERT_EMAIL`, `POSTMARK_SERVER_TOKEN` reused), `.github/workflows/ci.yml` (job `hail`: `ghcr.io/osgeo/gdal:ubuntu-small-3.8.5` container, `pip install -e services/hail[dev]`, migrations applied by the existing db step, `pytest`).

**Interfaces:**
```python
# storms.py
class StormShape(NamedTuple): footprint: MultiPolygon; contours: dict[float, MultiPolygon]; max_in: float
def split_storms(contours: list[Contour]) -> list[StormShape]       # connected components of the 0.75 level; higher levels clipped to each
def match_existing(shapes, existing: list[tuple[UUID, MultiPolygon]]) -> list[tuple[UUID | None, StormShape]]
    # a shape overlapping one existing storm of the same convective day keeps its id; overlapping two → the larger overlap wins, the other is left (never merged in S1, Ruling 3); none → None (new)
# writer.py
def write_run(conn, grid: HailGrid, day: date, matched, final: bool) -> RunSummary   # one transaction; insert hail_runs; upsert storms (status final when final=True, last_grew_at when area grew > 1%); replace storm_contours
def record_failure(conn, key: str, err: Exception) -> int          # returns consecutive failure count
# run.py
def tick(source: HailSource, conn_factory, now: datetime) -> RunSummary | None
    # final = the grid's valid_at hour is 12Z (closes the day before)
# main.py — loop: tick at :05 and :35; on 3 consecutive failures email OPS_ALERT_EMAIL through Postmark's API (plain fetch via httpx); SIGTERM-safe
```
- [ ] **Tests:** two consecutive fixture runs keep storm ids; a new disjoint cell gets a new id; the 12Z run sets `final`; writer against PostGIS (CI service) writes rows readable by `app_tenant`; failure counter resets on success.
- [ ] **Verify:** CI `hail` job; `docker build services/hail` in CI only.
- [ ] **Commit:** `feat(hail): group hail into storms, write them as app_hail, and run every 30 minutes on Render`

---

### Task 4: Shared storm logic

**Split:** Builder 1 templates and rendering; Builder 2 yes-words, budgets, circle radius math, labels; Builder 3 tests.

**Files:** Modify `packages/shared/src/storm.ts`; Test `packages/shared/test/storm.test.ts`.

**Interfaces:**
```ts
export const DEFAULT_STORM_SMS = 'Hi {first_name}, it\'s {company}. Radar shows hail up to {hail_size} hit near your home on {street} {day}. Want a free roof check this week? Reply YES to book. Reply STOP to opt out.';
export const DEFAULT_STORM_EMAIL_SUBJECT = 'Hail near your home on {street}';
export const DEFAULT_STORM_EMAIL_BODY: string;   // plain text; must include {company}, {company_address}, {unsubscribe}
export type StormFields = { first_name: string; company: string; hail_size: string; street: string; day: string; company_address?: string; unsubscribe?: string };
export function renderStormTemplate(tpl: string, f: StormFields): string;           // unknown tokens left as-is → the gate's content rule catches them
export function missingStormTokens(tpl: string, channel: 'sms' | 'email'): string[]; // sms needs {company} + "Reply STOP"; email needs {company},{company_address},{unsubscribe}
export function hailLabel(inches: number): string;          // 1.75 → '1.75"'; 1 → '1"'
export function stormDayLabel(convectiveDay: string, now: Date, tz: string): string; // 'today' | 'yesterday' | 'on Tuesday'
export function isYesReply(body: string): boolean;          // yes, y, yeah, yep, sure, ok, okay, please, book, 👍 — whole-message, case/punct-insensitive; 'yes stop' → false
export function splitAdBudget(totalCents: number, googleSharePct: number): { google: number; meta: number };
export function dailyBudgetCents(maxCents: number, days: number): number;          // floor; daily × days ≤ max
export function nextCircleRadiusM(prevM: number): number;                           // ×2; first 1000 (Google min); Meta min 1609
export function hexCenterSpacingM(radiusM: number): number;                         // radius × √3 so circles cover the hex grid
export function stormTitle(placeName: string | null, maxIn: number): string;       // 'Storm plan for hail near Omaha, NE (up to 1.75")'
```
- [ ] **Tests:** rendering and missing tokens; `isYesReply` table (20 cases); budget split sums to total; `dailyBudgetCents(27000, 7) * 7 <= 27000`; day labels across a midnight in the company time zone.
- [ ] **Commit:** `feat(shared): storm templates, yes replies, ad budgets and hail labels`

---

### Task 5: Shared door routes — k-means and 2-opt

**Split:** Builder 1 seeded k-means with balanced sizes; Builder 2 nearest neighbour + 2-opt; Builder 3 `splitIntoRoutes` and tests.

**Files:** Modify `packages/shared/src/door-routes.ts`; Test `packages/shared/test/door-routes.test.ts`.

**Interfaces:**
```ts
export type Door = { key: string; lat: number; lng: number; hailIn: number };
export type PlannedRoute = { repIndex: number; doors: Door[]; walkMeters: number };
export const MAX_DOORS_PER_ROUTE = 150; export const MAX_DOORS_PER_PLAN = 1500;
export function pickDoors(all: Door[], max = MAX_DOORS_PER_PLAN): Door[];          // largest hail first, then key
export function clusterDoors(doors: Door[], k: number, seed: string): Door[][];       // k-means++ with a seeded PRNG (mulberry32 of a string hash), ≤ 25 iterations, equirectangular metres
export function orderRoute(doors: Door[]): { doors: Door[]; walkMeters: number };     // nearest neighbour from the door nearest the cluster's north-west corner, then 2-opt until no gain (cap 50 passes)
export function splitIntoRoutes(doors: Door[], reps: number, seed: string): PlannedRoute[];
    // k = max(reps, ceil(n / 150)); clusters over 150 are split by orderRoute halves; routes assigned to reps round-robin by door count (largest to the rep with fewest doors)
```
- [ ] **Tests:** deterministic for a seed; every door exactly once; ≤ 150 each; 2-opt never longer than nearest neighbour; 1 rep with 400 doors → 3 routes on rep 0; empty input → `[]`; 1,500 doors in < 1 s (timed loosely).
- [ ] **Commit:** `feat(shared): door-knock routes by clustering and 2-opt`

---

### Task 6: Step types and the email gate

**Split:** Builder 1 `send_email_batch`, `build_routes`, `create_ad_campaign` in `steps.ts`, plus the `fields` extension to `send_sms_batch`; Builder 2 `packages/send-gate/src/email.ts` (`decideEmail`); Builder 3 tests. Step validation uses only constants from `storm.ts` written in Task 1 (no Task 4 logic), so Tasks 4 and 6 run side by side.

**Files:** Modify `packages/shared/src/steps.ts`, `packages/send-gate/src/index.ts`; Create `packages/send-gate/src/email.ts`; Test `packages/shared/test/steps-storm.test.ts`, `packages/send-gate/test/email.test.ts`.

**Interfaces:**
```ts
// send_sms_batch gains an optional per-recipient field map (backward compatible):
//   fields?: Record<customerId, Record<string, string>>  (≤ 5000 keys; values ≤ 60 chars) — rendered by renderStormTemplate before the gate; send-batch.ts already renders per customer, Task 11 passes the map through its existing render hook (if send-batch has no hook, Task 12 adds a one-line `renderFor(customerId)` option — Ruling 6)
send_email_batch: { approvalClass: 'message'; payload: { purpose: 'marketing'; subject: string; body: string; customerIds: string[] /* ≤ 5000 */; fields?: Record<string, Record<string,string>>; dedupePrefix?: string; companyStormId?: string } ; preview → { title: 'Email {n} customers', lines, messageSample, recipientCount, sendTime } ; minutesSaved: min(0.5 × n, 120) }
build_routes: { approvalClass: 'internal'; payload: { companyStormId: string; repUserIds: string[] /* ≥ 1 */; maxDoors: number /* ≤ 1500 */ } ; preview → { title: '{routes} door-knock routes · {doors} doors', lines: per rep } ; minutesSaved: 120 × routes }
create_ad_campaign: { approvalClass: 'spend'; payload: { companyStormId: string; platform: 'google' | 'meta'; maxSpendCents: number /* 500–1,000,000 */; days: number /* 1–30 */; headline: string; description: string; keywords?: string[] /* google */; primaryText?: string /* meta */; photoId?: string | null } ; preview → { title: 'Google ads on the hail area' | 'Facebook and Instagram ads on the hail area', lines: [circles, '$X a day for N days'], maxSpendCents } ; minutesSaved: 45 }
// send-gate/email.ts
export type EmailGateRequest = { purpose: 'marketing' | 'informational'; billingOk: boolean; email: string | null; doNotContact: boolean; optedOut: boolean;
  subject: string; body: string; companyName: string; companyAddress: string | null; dedupeHit: boolean; sentLast7Days: number; now: Date; timeZone: string };
export type EmailGateDecision = { ok: true; sendAt: Date } | { ok: false; rule: GateRule; reason: string };
export function decideEmail(r: EmailGateRequest): EmailGateDecision;   // rule order and messages: spec §5.2; reuses GATE_RULES names (billing, contact, content, dedupe, frequency, quiet_hours); 'Email is paused until billing is sorted out.', 'No email address on file.', 'They unsubscribed from emails.', 'Emails need the company name, mailing address and unsubscribe link.', 'Already emailed about this.', 'Already got 2 emails this week.'; quiet hours → ok with a later sendAt (nextAllowedTime)
```
- [ ] **Tests:** each step validates (counts, ranges, Google needs keywords, Meta needs primaryText); previews read as specified; `create_ad_campaign` preview carries `maxSpendCents`; `decideEmail` rule order table; marketing email without a postal address → `content`.
- [ ] **Commit:** `feat(shared,send-gate): storm step types and the email gate`

---

### Task 7: API skeleton — seams, fakes, config, jobs, schedules, mounts

**Split:** Builder 1 config, deps, test helpers, env docs; Builder 2 the five seams and fakes + `storm-fakes.test.ts`; Builder 3 job names, schedules, step handler stubs, route stubs and mounts, public routes on the company host.

**Files:**
- Create: `apps/api/src/providers/{ads-google,ads-meta,broadcast,ad-image}.ts`, `apps/api/src/providers/fakes/{ads-google,ads-meta,broadcast,ad-image}.ts`, stubs `providers/google-ads/index.ts` (`googleAdsFor(config): AdsGoogle | null` → null), `providers/meta/index.ts` (`metaAdsFor` → null), `providers/postmark-broadcast.ts` (`postmarkBroadcastFor` → null), `providers/resvg-card.ts` (`resvgCardFor` → a stub throwing), all `apps/api/src/storm/*.ts` stubs, `apps/api/src/routes/{storms,door-routes,storm-settings,ads}.ts`, `apps/api/src/public/{storm-page,storm-requests,unsubscribe}.ts`, `apps/api/src/jobs/scheduler/{spotter-sync,storm-match,ad-spend-sync,hail-health}.ts`, `apps/api/test/storm-fakes.test.ts`
- Modify: `apps/api/src/{config,deps,app,index}.ts`, `apps/api/src/providers/{geocoder,geocodio}.ts` + `fakes/geocoder.ts` (`reverseMany`), `apps/api/src/auth/middleware.ts` (public paths `/u/`), `apps/api/src/jobs/{queue,handlers,worker}.ts`, `apps/api/src/tasks/handlers.ts` (register `send_email_batch`, `build_routes`, `create_ad_campaign` stubs that throw "not yet"), `apps/api/src/web.ts` (company-host routes `/storm/:code` beside F3's policy pages), `apps/api/test/helpers.ts`, `.env.example`, `README.md`

**Interfaces:**
```ts
// providers/ads-google.ts
export type Circle = { lat: number; lng: number; radiusM: number };
export type AdCreate = { accountId: string; nameTag: string; dailyBudgetCents: number; startDate: string; endDate: string; circles: Circle[];
  landingUrl: string; headline: string; description: string; companyName: string; city: string; keywords: string[] };
export type AdStats = { spendCents: number; impressions: number; clicks: number; status: 'paused' | 'active' | 'ended' | 'removed' };
export class AdPlatformError extends Error { constructor(readonly kind: AdErrorKind, readonly status?: number) }
export interface AdsGoogle { readonly configured: boolean; managerId: string;
  invite(customerId: string): Promise<void>; linkStatus(customerId: string): Promise<'pending' | 'active' | 'refused' | 'none'>;
  accountInfo(customerId: string): Promise<{ name: string; currency: string }>;
  findCampaign(customerId: string, nameTag: string): Promise<string | null>;
  createCampaign(c: AdCreate): Promise<{ campaignId: string }>;        // created PAUSED
  setStatus(customerId: string, campaignId: string, s: 'active' | 'paused'): Promise<void>;
  stats(customerId: string, campaignId: string): Promise<AdStats> }
// providers/ads-meta.ts
export type MetaCreate = Omit<AdCreate, 'keywords'> & { primaryText: string; imagePng: Uint8Array; housing: boolean };
export interface AdsMeta { readonly configured: boolean; businessId: string;
  verifyAccess(adAccountId: string): Promise<{ ok: true; name: string; currency: string } | { ok: false; reason: 'not_shared' | 'not_assigned' | 'disabled' }>;
  findCampaign(adAccountId: string, nameTag: string): Promise<string | null>;
  createCampaign(c: MetaCreate): Promise<{ campaignId: string }>;      // created PAUSED; throws AdPlatformError('targeting') when Meta requires Housing
  setStatus(adAccountId: string, campaignId: string, s: 'active' | 'paused'): Promise<void>;
  stats(adAccountId: string, campaignId: string): Promise<AdStats> }
// providers/broadcast.ts
export type BroadcastMail = { to: string; from: string; replyTo: string | null; subject: string; text: string; html: string; unsubscribeUrl: string; tag: string };
export interface BroadcastMailer { readonly configured: boolean; send(m: BroadcastMail): Promise<{ messageId: string }> }   // List-Unsubscribe + List-Unsubscribe-Post headers
// providers/ad-image.ts
export interface AdImageRenderer { card(i: { companyName: string; line: string; colorHex: string }): Promise<Uint8Array> }   // 1080×1080 PNG
// providers/geocoder.ts gains
reverseMany(points: { lat: number; lng: number }[]): Promise<({ street: string; city: string; state: string; zip: string } | null)[]>   // Geocodio batch reverse (POST /v1.7/reverse, ≤ 1000 per call, chunks)
```
- **Fakes:** `FakeAdsGoogle` (invite → `linkStatus` pending until `accept(customerId)`; campaigns `g-<n>` stored with their inputs; `stats` from `setSpend(id, cents)`; `failNext(kind)`), `FakeAdsMeta` (`share(adAccountId)` makes `verifyAccess` ok; `requireHousingNext()` makes the next non-housing create throw `targeting`; `m-<n>`), `FakeBroadcastMailer` (records `sent`), `FakeAdImageRenderer` (returns an 8-byte PNG signature), `FakeGeocoder.reverseMany` (`<n> Fake St`, null for points with lat < 0). Each records `calls`.
- **Config:** `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_MANAGER_ID`, `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN` (all or none), `GOOGLE_ADS_API_VERSION` (default `v21`, Ruling 7); `META_APP_ID`, `META_APP_SECRET`, `META_SYSTEM_USER_TOKEN`, `META_BUSINESS_ID` (all or none), `META_GRAPH_VERSION` (default `v24.0`, Ruling 7); `POSTMARK_BROADCAST_STREAM` (default `broadcast`), `STORM_MAIL_FROM` (email; default `storms@` + the mail domain); `HAIL_STALE_MINUTES` (default 90).
- **`AppDeps` gains** `adsGoogle`, `adsMeta`, `broadcast`, `adImage`; `TestApp` gains the fakes.
- **Jobs:** `JOB_NAMES` gains `'storm-match-company'` (`{ companyId }`, singletonKey companyId), `'storm-draft'` (`{ companyId, companyStormId }`), `'storm-alert'` (`{ companyId, companyStormId, kind: 'now' | 'plan' }`), `'ad-sync-company'` (`{ companyId }`).
- **Schedules:** `spotter-sync` `*/30 * * * *`, `storm-match` `*/10 * * * *`, `ad-spend-sync` `0 * * * *`, `hail-health` `*/15 * * * *`.
- **Mounts:** `/api/storms`, `/api/routes`, `/api/storm/settings`, `/api/ads`; public `/api/public/storm-requests` (the E1 public prefix and `publicRateLimit`); `/u/:token` on the app host (GET page, POST one-click).
- [ ] **Tests:** config groups; fakes' documented behaviour; `/api/public/storm-requests/x` reachable without a session (404 stub); `/u/x` without a session; `SCHEDULES` and `JOB_NAMES` gain the names; the three step stubs registered.
- [ ] **Commit:** `feat(api): S1 skeleton — ads, broadcast email and reverse-geocode seams with fakes; storm jobs and public routes`

---

### Task 8: Spotter reports and the map storm layer API

**Split:** Builder 1 port v1's SPC parser to `storm/spotter.ts` + `system/spotter.ts` upsert; Builder 2 `repos/storm-layer.ts` (swaths and spots in a bbox, simplified per zoom); Builder 3 `GET /api/map/storm-layer` in `routes/storms.ts`, tests.

**Files:** Create/fill `apps/api/src/storm/spotter.ts`, `apps/api/src/jobs/scheduler/spotter-sync.ts`, `packages/db/src/system/spotter.ts`, `packages/db/src/repos/storm-layer.ts`, `apps/api/test/fixtures/spc-hail.csv` (from v1's tests or a recorded day); Modify `apps/api/src/routes/storms.ts`; Test `apps/api/test/{spotter,storm-layer}.test.ts`.

**Interfaces:**
```ts
export function parseSpcHailCsv(csv: string, reportDate: string): SpotterReport[];   // v1 rules: exact header, size hundredths or UNK (skipped), lat/lon numbers; HHMM → time
export async function syncSpotter(deps, now: Date): Promise<{ inserted: number }>;   // today's and yesterday's convective days (UTC yymmdd), timeout 10 s, 404 → 0
storm-layer repo: stormLayer(tx, { bbox: [w,s,e,n], days: number, zoom: number }) → { swaths: FeatureCollection /* per storm, per level, ST_SimplifyPreserveTopology by zoom */, spots: FeatureCollection, newestRunAt: Date | null }
GET /api/map/storm-layer?bbox=&zoom=&days=7  → 200 { swaths, spots, newestRunAt, stale: boolean }   // stale = newestRunAt older than HAIL_STALE_MINUTES
```
- [ ] **Tests:** parser (header mismatch → [], UNK skipped, ≥ 1 row); sync upserts idempotently; layer returns only features in the bbox and of the last N days; `stale` flag; tenant isolation trivially holds (global) but the route requires a session.
- [ ] **Commit:** `feat(api): NOAA spotter reports and the storm map layer`

---

### Task 9: Storm match — company storms and hits

**Split:** Builder 1 `system/storm-match-fanout.ts` (companies with a service area and candidate storms) + the scheduler; Builder 2 `repos/{company-storms,storm-hits}.ts` (upsert, hits by contour ∩ service area, homes count from `building_footprints`); Builder 3 `storm/match.ts` and tests with fixture storms.

**Files:** Fill the listed repo/system/storm modules and `jobs/scheduler/storm-match.ts`; Create `packages/db/test/fixtures/storms.ts` (fixture storm geometries over the Omaha showcase and a second city); Test `apps/api/test/storm-match.test.ts`, `packages/db/test/storm-hits.test.ts`.

**Interfaces:**
```ts
// system/storm-match-fanout.ts
companiesWithCandidateStorms(sys, { days: string[] }) → { companyId: string }[]       // service_area intersects storms.geom_075 for those convective days
// repos
upsertCompanyStorm(tx, { stormId, maxIn, customersHit, homesHit, now }) → { companyStorm, created: boolean }
thresholdContourInArea(tx, stormId, thresholdIn) → geometry | null                 // highest contour ≥ threshold ∩ company service area (ST_Intersection), null when empty
refreshHits(tx, companyStormId, stormId, thresholdIn) → { customersHit: number }   // properties (not archived) inside the threshold contour; hail_in = highest containing contour level
countHomes(tx, stormId, thresholdIn) → number                                      // building_footprints with ST_Intersects(geom, area) (centroid-in)
// storm/match.ts
export async function matchCompany(deps, companyId: string, now: Date): Promise<{ created: string[]; grown: string[] }>
    // per candidate storm: max inside area ≥ hail_threshold_in → upsert; dismissed rows are left alone; final storms are matched once more after becoming final, then skipped
```
- [ ] **Tests:** threshold edge (0.99 vs 1.00 with threshold 1.00); outside the service area → nothing; two companies get separate rows; growth increases counts; customer hail_in from the right contour; a dismissed storm doesn't reopen; footprint count with the E1 fixture.
- [ ] **Commit:** `feat(api): match storms to service areas and count customers and homes hit`

---

### Task 10: Alerts and the settle trigger

**Split:** Builder 1 `storm/alerts.ts` (emails through `Mailer` to owner/office members with `storm_alert_email`, in-app entries); Builder 2 `storm/settle.ts` (the draft trigger: final, or 90 minutes since `last_grew_at`; re-draft on growth when the plan is still a draft) wired after `matchCompany`; Builder 3 `hail-health` schedule (stale banner data and the ops email when the newest run is > 3 hours old during April–September, > 12 hours otherwise) and tests.

**Files:** Fill `apps/api/src/storm/{alerts,settle}.ts`, `jobs/scheduler/hail-health.ts`; Modify `apps/api/src/storm/match.ts` (call `afterMatch`); Test `apps/api/test/storm-alerts.test.ts`.

**Interfaces:**
```ts
export async function alertNow(deps, companyId, companyStormId): Promise<void>;     // once per storm (company_storms.alerted_at claim)
export async function alertPlanReady(deps, companyId, companyStormId, taskId): Promise<void>;
export function shouldDraft(cs: { status; planTaskId; planStatus: 'draft' | 'other' | null }, storm: { status; lastGrewAt }, now: Date, grownSinceDraft: boolean): 'draft' | 'redraft' | 'wait' | 'skip'
// Email copy (copy constants in storm/alerts.ts): subject 'Hail near Omaha, NE — up to 1.25" (radar-estimated)'; body with counts and a link to /storm/<id>
```
- [ ] **Tests:** one "now" email per storm even across ten matches; members with alerts off get none; reps get none; settle at final; settle at 90 minutes; growth before approval → `redraft`; after approval → `skip`; health thresholds by month.
- [ ] **Commit:** `feat(api): storm alerts by email and in-app, and drafting when the storm settles`

---

### Task 11: Storm plan drafting

**Split:** Builder 1 `storm/plan.ts` building the five steps; Builder 2 `repos/storm-plans.ts` (recipients: marketing-consented SMS ids, emailable ids, per-recipient fields; replacing a draft task: cancel the old draft's steps and point `company_storms.plan_task_id` at the new one); Builder 3 tests.

**Files:** Fill `apps/api/src/storm/plan.ts`, `packages/db/src/repos/storm-plans.ts`; Test `apps/api/test/storm-plan.test.ts`.

**Interfaces:**
```ts
export async function draftStormPlan(deps, companyId: string, companyStormId: string, now: Date): Promise<{ taskId: string }>
// agent 'storm_scout', kind 'storm_plan', title stormTitle(...), expires now + 48 h, steps in order:
// 1 send_sms_batch { purpose:'marketing', body: settings.storm_sms_template ?? DEFAULT_STORM_SMS, customerIds, fields, dedupePrefix:`storm:${companyStormId}` }  — off with reason when texting isn't approved (F3 registration) or 0 recipients
// 2 send_email_batch { … DEFAULT_STORM_EMAIL_* , dedupePrefix same } — off when storm_email_enabled is false, company has no postal address ('Add your mailing address in Settings → Company'), or 0 recipients
// 3 build_routes { companyStormId, repUserIds: active reps (or owner when none), maxDoors: 1500 } — off when homesHit = 0
// 4 create_ad_campaign google { maxSpendCents: split.google, days, headline/description/keywords from templates } — off when no active google ad_account ('No Google Ads account connected') or split = 0
// 5 create_ad_campaign meta { … primaryText, photoId: newest storm photo or null } — off similarly
// marks company_storms.status 'planned'; calls alertPlanReady
```
- [ ] **Tests:** recipients exclude do-not-contact, archived, informational-only consent (SMS) and opted-out emails; fields per recipient (street and hail size); off reasons; re-draft replaces only a draft; partial approval works through the F2 review (office approves 1–3, the ad steps wait as `awaiting_owner`); expiry 48 h.
- [ ] **Commit:** `feat(api): Storm Scout drafts the storm plan — texts, emails, routes and ads`

---

### Task 12: `send_email_batch` handler and the email send path

**Split:** Builder 1 `storm/email-batch.ts` (lease loop like `send-batch.ts`: `if (!(await lease.keep())) return { status: 'running', result: {} };` first in the per-customer loop; gate per recipient; insert `messages` rows `channel 'email'`); Builder 2 `repos/email-sends.ts` (dedupe and the 7-day count by address; unsubscribe tokens); Builder 3 tests.

**Files:** Fill `apps/api/src/storm/email-batch.ts`, `packages/db/src/repos/{email-sends,email-opt-outs}.ts`; Modify `apps/api/src/tasks/handlers.ts` (swap its own stub, Ruling 2); Test `apps/api/test/email-batch.test.ts`.

**Interfaces:**
```ts
export const sendEmailBatchHandler: StepHandler<'send_email_batch'>;
// per recipient: render subject/body with fields + company_address + unsubscribe = `${APP_ORIGIN}/u/${token}` (token = a stateless HMAC of `${companyId}.${emailLower}`, Ruling 5)
// gate: decideEmail; blocked → messages row status 'blocked' with rule/reason (as SMS); quiet hours → scheduled row picked up by the F1 dispatcher's email branch (Task 12 adds `dispatchEmail` beside the SMS dispatcher, same claim pattern)
// send: deps.broadcast.send({ from: `"${company} via Roofline" <${STORM_MAIL_FROM}>`, replyTo: company email, tag: `storm:${companyStormId}` })
// result: { sent, blocked: { [rule]: n }, scheduled }
```
- [ ] **Tests:** gate counts; opted-out skipped; dedupe on re-run; lease loss returns running; scheduled emails dispatch after 8 AM local; HTML and text both carry the unsubscribe URL; a provider error marks the row failed and continues.
- [ ] **Commit:** `feat(api): storm emails through the email gate with unsubscribe links`

---

### Task 13: Postmark broadcast adapter and unsubscribe

**Split:** Builder 1 `providers/postmark-broadcast.ts` (`POST /email` with `MessageStream`, headers, recorded responses); Builder 2 `public/unsubscribe.ts` (GET page in S1 styling without the shell, POST one-click) + `system/unsubscribe-lookup.ts`; Builder 3 Postmark bounce/complaint webhook → `email_opt_outs` (`complaint`) in `hooks/postmark.ts` (new, signature by basic-auth secret `POSTMARK_WEBHOOK_SECRET`), tests.

**Files:** Fill the listed files; Create `apps/api/src/hooks/postmark.ts`; Modify `apps/api/src/app.ts` (mount `/hooks/postmark` — allowed here, Ruling 2 exception), `config.ts` (`POSTMARK_WEBHOOK_SECRET`) — **Ruling 2: Task 13 is the only post-skeleton edit to `app.ts`/`config.ts`**.
- [ ] **Tests:** headers `List-Unsubscribe: <https://…/u/…>`, `List-Unsubscribe-Post: List-Unsubscribe=One-Click`; a forged token → 404 page; a valid token records `link`/`one_click` once and shows the company's name; complaint webhook records; wrong secret → 401.
- [ ] **Commit:** `feat(api): Postmark broadcast stream, one-click unsubscribe and complaints`

---

### Task 14: `build_routes` handler

**Split:** Builder 1 `repos/door-routes.ts` (homes in the threshold area minus `door_exclusions` and do-not-contact customers' homes, with any matching property id; insert routes and stops); Builder 2 `storm/routes-build.ts` (pick, cluster, order, reverse-geocode non-customer stops in chunks, idempotent by `company_storm_id` + step); Builder 3 tests.

**Files:** Fill the listed files; Modify `apps/api/src/tasks/handlers.ts` (swap the stub); Test `apps/api/test/routes-build.test.ts`.
- **Interfaces:** `buildRoutesHandler: StepHandler<'build_routes'>` → result `{ routes: number, doors: number, byRep: { userId, doors }[] }`; route names `"Omaha · Route 1 (Sam)"`; stops with no address after geocoding show "Near 41.2565, -95.9345".
- [ ] **Tests:** with the E1 footprint fixture and a fixture storm: every door once, ≤ 150, customers' homes carry `property_id` and their saved address, exclusions skipped, re-run returns the same routes, reverse geocoding called in chunks of ≤ 1000.
- [ ] **Commit:** `feat(api): build door-knock routes for the homes in the hail path`

---

### Task 15: Door outcomes API and leads from doors

**Split:** Builder 1 `routes/door-routes.ts` (`GET /api/routes/mine`, `GET /api/routes/:id` (assignee, owner, office), `POST /api/routes/:id/stops/:stopId/outcome`); Builder 2 `storm/doors.ts` (wants_check → C1's customer/property/job creation in one transaction: consent `express` with source `door` and evidence `{ by, at, text }` when the box is ticked; job source `storm`, `storm_id`, assigned to the rep; Today follow-up; do_not_knock → exclusion); Builder 3 tests.

**Files:** Fill the listed files; Modify `packages/db/src/repos/door-routes.ts` (outcome update); Test `apps/api/test/doors.test.ts`.
- **Interfaces:** body `{ outcome: DoorOutcome; lead?: { name: string; phoneE164?: string; email?: string; okToText: boolean; note?: string } }` (zod; `lead` required for `wants_check`); 200 `{ stop, createdJobId? }`; a rep can't record on another rep's route (403 `'This route belongs to someone else.'`); route status moves to `in_progress` then `done` when every stop has an outcome. `CONSENT_SOURCES` gains `'door'` and `'web_form'` if absent (Task 1 constant; this task only uses them).
- [ ] **Tests:** each outcome; lead creation idempotent per stop; consent only when ticked; cross-tenant 404; route done.
- [ ] **Commit:** `feat(api): reps record door outcomes and create storm leads`

---

### Task 16: Ad accounts — linking Google and Meta

**Split:** Builder 1 `routes/ads.ts` + `storm/ad-accounts.ts` (connect Google: validate 10-digit id, `invite`, row pending; check: `linkStatus`/`accountInfo`; Meta: `verifyAccess`); Builder 2 `repos/ad-accounts.ts` + `connect_ads` in `shared/setup.ts`/`repos/setup.ts` (done when one account is active); Builder 3 the recheck of pending accounts folded into `ad-spend-sync`'s hourly fan-out (plus on demand through `/check`) and tests.

**Interfaces:** `POST /api/ads/accounts/google { customerId: '123-456-7890' | '1234567890' }` → 201 `{ account, instructions: { managerId } }`; `POST /api/ads/accounts/meta { adAccountId: 'act_…' | digits }` → 201 `{ account }` (status active or pending with `reason`); `POST /api/ads/accounts/:id/check`; `DELETE` → status `revoked` (Google: the manager link is ended too); owner only for all (office can view).
- [ ] **Tests:** with the fakes, Google pending → accept → active and `connect_ads` done; Meta not shared → pending with reason → share → active; revoke; office 403 on writes; a second Google account replaces the first only after revoking.
- [ ] **Commit:** `feat(api): link the roofer's Google Ads and Meta ad accounts`

---

### Task 17: Google Ads adapter

**Split:** Builder 1 `google-ads/http.ts` (OAuth refresh-token exchange cached until expiry, headers `developer-token`, `login-customer-id` = manager, `googleAds:search` and `:mutate` over REST, error mapping to `AdErrorKind`); Builder 2 `google-ads/link.ts` + `report.ts` (CustomerClientLink create/read, `customer` info, metrics by campaign id); Builder 3 `google-ads/campaigns.ts` (one `googleAds:mutate` with temp resource names: budget (`explicitly_shared false`, amount micros = daily cents × 10,000), campaign (SEARCH, Maximize Clicks with no CPC cap per Ruling 8, PAUSED, start/end dates, name tag), ad group, keywords (phrase match), responsive search ad (≥ 3 headlines, 2 descriptions from the step), proximity criteria (≤ 50, radius in km, `units KILOMETERS`), negative keywords `jobs`, `salary`, `diy`).

**Files:** Fill `apps/api/src/providers/google-ads/{http,link,campaigns,report,index}.ts`; Create `apps/api/test/fixtures/google-ads/*.json` (recorded shapes from the public docs; Task 29 replaces them with real captures); Test `apps/api/test/google-ads.test.ts`.
- [ ] **Tests:** request bodies match fixtures (snapshot of the mutate operations); micros math; error mapping (`AUTHORIZATION_ERROR`→access, `POLICY_*`→policy, `BILLING_*`→payment, `CRITERION_ERROR`→targeting); token refresh once per hour; nothing logs the developer token or refresh token.
- [ ] **Commit:** `feat(api): Google Ads adapter — manager links and proximity search campaigns`

---

### Task 18: Meta Marketing adapter

**Split:** Builder 1 `meta/http.ts` (Graph calls with the system-user token and `appsecret_proof`, error mapping incl. the special-ad-category error → `targeting`); Builder 2 `meta/link.ts` + `report.ts` (`GET /act_<id>?fields=name,currency,account_status`; assign the system user to the shared ad account `POST /act_<id>/assigned_users` with `tasks=['ADVERTISE','ANALYZE']`; insights `spend,impressions,clicks`); Builder 3 `meta/campaigns.ts` (`adimages` upload → hash; campaign `OUTCOME_TRAFFIC`, `special_ad_categories: housing ? ['HOUSING'] : []`, PAUSED; ad set with `lifetime_budget` = daily × days cents, `end_time`, `targeting.geo_locations.custom_locations` circles in miles (≥ 1; housing → one 15-mile circle at the centroid), `age_min 25`, `publisher_platforms ['facebook','instagram']`; creative `link_data` with image hash, message, headline, landing URL, CTA `LEARN_MORE`; ad PAUSED).

**Files:** Fill `apps/api/src/providers/meta/{http,link,campaigns,report,index}.ts`; fixtures `apps/api/test/fixtures/meta/*.json`; Test `apps/api/test/meta-ads.test.ts`.
- [ ] **Tests:** bodies match fixtures; housing variant; miles conversion and minimums; error mapping; `appsecret_proof` = HMAC-SHA256(token, app secret); secrets never logged.
- [ ] **Commit:** `feat(api): Meta Marketing adapter — shared ad accounts and radius traffic campaigns`

---

### Task 19: `create_ad_campaign` handler, creative card, spend sync

**Split:** Builder 1 `repos/storm-geo.ts` (`coverCircles(tx, companyStormId, minRadiusM, maxCircles)`: threshold area in EPSG:5070, `ST_HexagonGrid(spacing)` keeping hexes that intersect, radius doubling until ≤ max; returns lat/lng circles) + `storm/creative.ts` and `providers/resvg-card.ts` (SVG template with the company name and S1 colours → PNG; stored in R2 as `ad_image`); Builder 2 `storm/ad-campaign.ts` (handler: re-check approval and account active; claim `ad_campaigns` row `creating`; `findCampaign` by name tag first; create paused; Meta targeting error → one housing retry with `housing_fallback = true`; enable; status `active`); Builder 3 `storm/ad-sync.ts` + `system/ad-sync-fanout.ts` + `jobs/scheduler/ad-spend-sync.ts` (hourly stats; ≥ 95% of `max_spend_cents` → pause, retried every run until the platform says paused; past end date → `ended`; landing requests counted from `storm_requests`).

**Files:** Fill the listed files; Modify `apps/api/src/tasks/handlers.ts` (swap the stub); Test `apps/api/test/{ad-campaign,ad-sync,storm-geo}.test.ts`.
- **Result** shown in the step: `{ campaignId, circles, dailyBudgetCents, days, housingFallback }`; errors as `{ kind }` → plain text in copy (`ads.ts`): policy "Google didn't approve the ad. Edit the words and try again.", payment "The ad account has a payment problem. Fix it in Google Ads.", access "Roofline can't reach this ad account anymore. Reconnect it in Settings → Connections."
- [ ] **Tests:** circles ≤ 50 and covering the fixture area (union of circles contains ≥ 99% of the area); Google 1 km and Meta 1 mile minimums; budget × days ≤ max; retry after an uncertain create finds the campaign instead of creating a second; housing fallback; 95% pause and its retry; the handler refuses when the account is revoked; a spend step approved by office without delegation never reaches the handler (F1 guard — asserted).
- [ ] **Commit:** `feat(api): create storm ad campaigns on approval and pause them at the approved maximum`

---

### Task 20: Storm landing page and requests

**Split:** Builder 1 `public/storm-page.ts` (server-rendered HTML like F3's policy pages: company name and phone, storm line, form, consent checkbox unchecked with the exact text stored, `noindex`, no third-party scripts, ≤ 30 KB) + `system/storm-page-lookup.ts`; Builder 2 `public/storm-requests.ts` + `storm/landing.ts` (zod; honeypot; per-IP and per-page limits; one per phone per page; address geocoded; creates customer/property/Lead job with `storm_id` and source `web`, consent `express`/`web_form` with evidence when ticked, activity, Today follow-up); Builder 3 `repos/storm-pages.ts` (page created with the plan's first ad step or on first request for the link; `code` 8 chars base32; `active_until` = storm day + 30) and tests.

**Interfaces:** `GET https://<slug>.<POLICY_PAGES_DOMAIN>/storm/<code>` → 200 HTML or 404 page; `POST /api/public/storm-requests/:code { name, phone, address, okToText, website }` (website = honeypot) → 201 `{ ok: true }` / 422 `{ error, field }`; the form posts with plain HTML (no JS needed) and redirects to a thank-you state.
- [ ] **Tests:** the page shows only that company; an inactive code → 404; honeypot filled → 201 without records; duplicate phone → 201 without a second job; consent recorded only when ticked; rate limits; phone width check is in e2e.
- [ ] **Commit:** `feat(api): storm landing page that turns ad clicks into storm leads`

---

### Task 21: YES replies, results and the storms API

**Split:** Builder 1 `storm/replies.ts` + the one call in `hooks/twilio.ts` after the inbound message is stored (`await onStormReply(tx, message)` — only when not a STOP/HELP keyword): newest storm text to this customer within 14 days and `isYesReply` → create or advance (to `lead` if earlier) the customer's open job with `storm_id`, Today follow-up "Maria replied YES to the storm text", once per storm per customer; Builder 2 `repos/storm-results.ts` + `storm/results.ts` (texts sent/delivered/replies/yes from `messages` by step; emails sent/unsubscribes; doors knocked/wants check; ads spend/max/clicks/landing requests; inspections booked = C1 appointments of kind inspection on jobs with the storm id created after the plan ran); Builder 3 `routes/storms.ts` (`GET /api/storms`, `GET /api/storms/:id`, `POST /:id/dismiss`, `POST /:id/plan`) and tests.

**Interfaces:** `GET /api/storms?since=` → `{ storms: { id, placeName, day, maxIn, status, customersHit, homesHit, planTaskId, planStatus }[] }`; `GET /api/storms/:id` → `{ storm, swath: FeatureCollection, results, plan: { taskId, status } | null }`; dismiss owner/office; `POST /plan` owner/office → `{ taskId }` (re-draft only when no plan or expired).
- [ ] **Tests:** YES → job with storm id; second YES no duplicate; YES to an old storm (> 14 days) ignored; STOP never treated as YES; results numbers from seeded data; cross-tenant 404s on every route; reps can list storms but not dismiss.
- [ ] **Commit:** `feat(api): storm results, YES replies as leads, and the storms API`

---

### Task 22: Web skeleton

**Split:** Builder 1 routes (`/storm`, `/storm/:id`, `/storm/routes`, `/storm/routes/:routeId`) and dock flag (`storm` shipped, no "Coming soon"); Builder 2 placeholders and empty `api.ts` (`features/storm`, `features/storm/routes`), Settings slots (`StormTab`, `AdConnections` under F3's Connections section); Builder 3 copy files (`storm`, `doors`, `ads`; Google Ads / Meta names in `copy/connections.ts`), `test/s1-routes.test.tsx`.

**Files:** Create placeholders and copy; Modify `apps/web/src/app/router.tsx`, `apps/web/src/shell/apps.ts`, `apps/web/src/features/settings/{SettingsPage,ConnectionsSection}.tsx` (slots only).
- [ ] **Tests:** each route renders its placeholder; the dock's Storm opens `/storm`; Settings shows the Storm tab for owner/office only.
- [ ] **Commit:** `feat(web): routes and slots for Storm Scout`

---

### Task 23: Web: Storm window and storm detail

**Split:** Builder 1 `StormWindow.tsx` (replaces F2's: list of company storms, "Approve storm plan" kept as F2's 2-click path for the newest plan, "Hail data is a little behind" banner from the layer's `stale`); Builder 2 `StormDetail.tsx` (swath mini-map using the shared map component with contour colours, counts, plan link, Dismiss with confirm); Builder 3 `StormResults.tsx` (live results, refetch every 60 s while a plan runs) + `api.ts` hooks + tests.
- **Hooks:** `useStorms()`, `useStorm(id)`, `useDismissStorm()`, `useRedraftStorm()`.
- [ ] **Tests:** list from stubbed data with "radar-estimated"; the 2-click approve still works (F2 test kept green); detail counts and results; empty state "No hail in your area in the last 30 days. We check every 30 minutes."
- [ ] **Commit:** `feat(web): Storm window — storms in your area, their plans and results`

---

### Task 24: Web: map storm layer

**Split:** Builder 1 `shell/map/stormLayer.ts` (fill the F2 `storm-swath` source from `/api/map/storm-layer` on move-end, debounced; fill colours by level `--hail-1`…`--hail-5`; spotter dots layer `storm-spots`); Builder 2 `HailLegend.tsx` ("Radar-estimated hail" with the five colours and sizes) and a toggle in the map's layer menu; Builder 3 tests.

**Files:** Create the two files; Modify `apps/web/src/shell/map/{layers.ts,MapHome.tsx}` (add the spots layer constant and mount the hook), `apps/web/src/styles/tokens.css` (the five hail colours if F2 didn't define them, light and dark).
- [ ] **Tests:** the hook requests with bbox and zoom; source data set; legend visible only when swaths are present; colours meet 3:1 against the base map (documented values).
- [ ] **Commit:** `feat(web): hail swaths and spotter reports on the map`

---

### Task 25: Web: plan review previews and Edit for the new steps

**Split:** Builder 1 `EmailBatchPreview.tsx` + Edit (subject, body with missing-token warnings from `missingStormTokens`); Builder 2 `BuildRoutesPreview.tsx` + Edit (rep switches); Builder 3 `AdCampaignPreview.tsx` + Edit (max spend, days, headline/description/keywords or primary text, photo choice; a static circle thumbnail drawn as SVG from the step's circles; "Up to $150" prominent; "Only the owner can approve spending" for office) and registration in `features/approvals/steps/index.ts`.
- [ ] **Tests:** each preview from fixture payloads; Edit validates with the shared `validate`; office sees the spend notice and can't approve ad steps; the texts step shows the per-recipient sample.
- [ ] **Commit:** `feat(web): review and edit storm emails, routes and ads before approving`

---

### Task 26: Web: phone routes

**Split:** Builder 1 `MyRoutes.tsx` (list of the rep's routes with progress); Builder 2 `RouteView.tsx` (map with stops numbered, list in order, the rep's dot from geolocation when allowed, "Navigate" link `https://maps.apple.com/?daddr=` on iOS and `https://www.google.com/maps/dir/?api=1&destination=` otherwise); Builder 3 `DoorOutcome.tsx` (five 48px buttons; "Wants a check" sheet with name, phone, email, "OK to text about this" unchecked, note) + hooks + tests.
- [ ] **Tests:** outcomes post and move to the next stop; wants-check sheet validation; offline-safe message on network failure ("Not saved — try again"); 375px no horizontal scroll (unit snapshot of layout classes; e2e does the real check).
- [ ] **Commit:** `feat(web): door-knock routes on the phone`

---

### Task 27: Web: Settings → Storm and ad connections

**Split:** Builder 1 `StormTab.tsx` (threshold select 0.75–2.00, budget, days, Google share slider, email on/off, templates with defaults and missing-token warnings) + the `GET/PUT /api/storm/settings` route half in `routes/storm-settings.ts` and `POST/DELETE /api/storm/photos` (R2 via E1's `ObjectStore`, ≤ 5 photos, JPEG/PNG ≤ 5 MB); Builder 2 `AdConnections.tsx` (Google: steps with Roofline's manager ID, ID field, status chip, "Check again"; Meta: steps with Roofline's Business ID, ad account ID field, status and reason); Builder 3 Team → "Storm alerts" switch per member (owner/office) + hooks + tests.
- [ ] **Tests:** settings round-trip with validation errors; photos upload and delete; connection flows against stubbed responses; alerts switch.
- [ ] **Commit:** `feat(web,api): Storm settings, ad account connections and storm alert preferences`

---

### Task 28: End-to-end tests, acceptance map, docs

**Files:** Create `apps/web/e2e/{storm,doors}.spec.ts`, `docs/superpowers/s1-acceptance.md`; Modify `apps/web/e2e/{phone,a11y}.spec.ts`, `README.md` (hail service, Google/Meta/Postmark broadcast env, `app_hail`), and the e2e reset to seed a fixture storm over the Omaha showcase through a new `seedStormFixture(pools)` exported from `apps/api/src/index.ts` (add the export here) plus active fake ad accounts.
- **Tests:** `test('storm plan in 2 clicks')` — owner, Storm window → "Approve storm plan" → review → Approve: all five steps Done with the fakes, results show texts sent and two campaigns; `test('office approves messages, owner approves spend')`; `doors.spec.ts` (phone project) — rep opens My routes, marks a door "Wants a check", the lead appears on the owner's Today; landing page on phone submits a request; a11y on `/storm`, `/storm/:id`, the route view and the landing page; phone no-scroll on the route view and landing page.
- **`s1-acceptance.md`:** every spec §12 bullet → its tests (Python ones included).
- [ ] **Verify:** typecheck, lint, `npx playwright test --list`; CI via `ci-check`.
- [ ] **Commit:** `test(e2e): storm plan in 2 clicks, doors on a phone, S1 acceptance map`

---

### Task 29: Manual smoke: real MESH, Google and Meta test accounts, a broadcast email

**Files:** Create `apps/api/src/scripts/smoke/storm.ts`, `docs/superpowers/s1-manual-smoke.md`, `apps/api/test/smoke-storm-guards.test.ts`; Modify `apps/api/package.json` (`smoke:storm`).
- `smoke:storm --confirm-real-providers [--google <testCustomerId>] [--meta <testAdAccountId>] [--email <address>]`: Google — link status, account info and one **paused** campaign in a **test account** (refused unless the account is a Google Ads test account or `--i-understand-spend` with a $1 budget and immediate removal); Meta — verify access, upload the card image, one **paused** campaign then delete it; one broadcast email with a working unsubscribe. The hail worker runbook: run `python -m hail.main --once` against staging and compare with the NOAA MRMS viewer for the same time. Prints no secrets; the captured API responses replace Task 17/18 fixtures (scrubbed).
- [ ] **Commit:** `test(smoke): real MESH run, Google and Meta test campaigns and a broadcast email, by hand only`

---

## Rulings

1. **All S1 schema is in Task 1's migrations (0016, 0017),** including the `app_hail` role; Task 1 is the only lockfile edit (`@resvg/resvg-js`). The Python service has its own `pyproject.toml` and no lockfile in the npm workspace.
2. **Skeleton tasks own the hotspots:** Task 1 (schema, barrels, lockfile, roles), Task 7 (`app.ts`, `config.ts`, `deps.ts`, `auth/middleware.ts`, `web.ts`, `jobs/*`, `tasks/handlers.ts` stubs, `test/helpers.ts`, env docs), Task 22 (`router.tsx`, `shell/apps.ts`, Settings slots). Exceptions: Tasks 12, 14, 19 each swap their own stub in `tasks/handlers.ts` (one line each); Task 13 adds the Postmark hook mount and secret; Task 3 owns `ci.yml` and `render.yaml`.
3. **Storms never merge in S1:** two cells that grow together keep separate ids (the larger overlap keeps the id); a company may see two storms for one day. Merging needs history rewriting of hits and plans and is not worth it before real use.
4. **Hits are properties, homes are footprints:** customers hit come from `properties` (tenant), homes hit and route doors from `building_footprints` (global, E1); a customer's home is matched to a footprint only for routes (same building by `ST_Intersects`).
5. **Unsubscribe tokens are stateless HMACs** of `companyId.emailLower` under a key derived from `SESSION_SECRET` (HKDF, info `unsubscribe`), so no token table; rotating the secret invalidates old links, which then show "This link has expired — reply to the email to unsubscribe" and the reply path is handled by hand.
6. **Per-recipient text fields:** `send_sms_batch` gets an optional `fields` map (Task 6); if F3's `send-batch.ts` has no per-customer render hook, Task 11 adds a single `render(customerId)` option there — the only S1 edit to that file — keeping the lease-check line first in the loop.
7. **API versions are config** (`GOOGLE_ADS_API_VERSION`, `META_GRAPH_VERSION`) with defaults checked at Task 29; fixtures are versioned by folder; a version bump is a config change plus re-recorded fixtures.
8. **Google bidding is Maximize Clicks** with the daily budget only (no CPC cap) — the simplest strategy that spends a small budget on a new account without conversion history; conversion tracking from the landing page is a later step.
9. **Meta Housing:** campaigns start as non-special; only a Meta rejection that names special ad categories triggers the one Housing retry. The owner's ruling (owner item) can make Housing the default with one settings flag added later.
10. **Team SMS alerts are out of S1** (spec Decision 6); alerts are email and in-app only until Roofline's platform texting brand exists.
11. **E2E covers the approval, doors and landing flows with fakes;** the hail worker, storm matching timing and ad sync are proven by pytest and integration tests, since the e2e stack doesn't run Python.
