# Roofline launch runbook

Written 2026-10-12 from the branch heads below. It lists every setting, scheduled job, service and manual check that
going live needs, and the order to do them in. It holds no secret values: every example is a format or a placeholder.
Never paste a real key, token, password or phone number into this file.

- **Launch = F1-F3, C1, E1, S1, D1, A1.** G1 is the next release (roadmap). G1 items are listed so nothing is
  missed, and each is marked **G1 (next release)**.
- **Where to look:** `docs/superpowers/roadmap.md` (owner to-do list), `.env.example`, `README.md` ("Running in
  production"), `services/hail/README.md` (S1), and each track's ledger `ops/sdd/<track>/progress.md`.
- **Roadmap references** in this file name the row of the roadmap's owner to-do list, for example
  *[Roadmap: Postmark server]*. Its money and lawyer rows are named *[Money: ...]* and *[Lawyer: ...]*.

## Branch heads read

| Branch | Head | What it holds for launch |
|---|---|---|
| `f2-shell` | 015f7cb | F1 + F2; the roadmap (newest edit, 104d301) |
| `f3-setup` | 8b8400a | F3 setup, texting, billing, import |
| `c1-crm` | 5d2e3bd | C1 complete except T29 (manual calendar smoke) |
| `e1-estimator` | a8df936 | E1 complete (T1-T22 + whole-branch review) |
| `s1-storm` | fd42bc4 | S1 build tasks + `services/hail`; E1 merged only up to T13 |
| `d1-front-desk` | 1f8dc5a | D1 T1-T3, T20-T24, T26; **no D1 config or jobs yet** |
| `d1-w6a` | 6843282 | D1 stack T4-T6, T10-T18 (config, jobs, schedules); not yet in `d1-front-desk` |
| `a1-agents` | 7fd771b | A1 + E1/S1 merge-up; D1 parts only on `a1-t4`/`a1-t21` |
| `g1-agents` | f7c59d1 | G1 integration; its G1 jobs and settings are on `g1-w6` / `g1-t*` |
| `launch-integration` | 7aa860d | the cross-track merge probe (pass 11) |

---

## 1. Environment variables and secrets

### 1.1 How the settings are read

- The API and the worker read the **same** settings through one schema: `apps/api/src/config.ts` (`loadConfig`).
  Give both processes the same set. A missing or malformed required value stops the process. The error names the
  variable, never its value.
- No process reads a `.env` file. Set the values in the host (Render: each service's Environment tab). Locally:
  `set -a; . ./.env; set +a`.
- A blank value (`POSTMARK_TOKEN=`) counts as unset.
- The worker checks `WEB_DIST_DIR` too. Either build the web app on the worker as well, or leave `WEB_DIST_DIR`
  unset on the worker.
- The hail service (`services/hail`, Python) reads its own three variables. It does not use `config.ts`.
- The database scripts (`packages/db`: migrate, preflight, set-role-passwords) read their own four variables. The
  API and worker never get them.
- The web app reads two build-time variables (`VITE_*`). They are baked into the bundle at `npm run build:web`.

Service column: **api+worker** = both Node processes (one shared config). **hail** = the Python hail worker.
**db scripts** = one-off migrate and role steps. **web build** = the Vite build step.

### 1.2 Platform core (F1, F2, F3)

| Name | Service | Required | Example format | What it is for | Owner to-do | Branch |
|---|---|---|---|---|---|---|
| `NODE_ENV` | api+worker | yes | `production` | Mode. `production` also makes `HOST` default to `0.0.0.0` and turns on the production-only checks. | none | F1 (`f2-shell`) |
| `APP_ORIGIN` | api+worker | yes | `https://app.example.com` | The one origin the browser uses. Mutations from other origins are refused. In production it is the API's own URL (the API serves the app). | [Roadmap: Domains] | F1 |
| `PUBLIC_BASE_URL` | api+worker | yes | `https://app.example.com` (no trailing slash) | Links in email; Twilio and other webhook URLs. Twilio signatures are checked against it, so it must be exactly what Twilio calls. | [Roadmap: Domains] | F1 |
| `DATABASE_URL_TENANT` | api+worker | yes | `postgres://app_tenant:pass@host:5432/db` | The `app_tenant` login: all request work, under row-level security. | Postgres host (not on the roadmap; see 6) | F1 |
| `DATABASE_URL_SYSTEM` | api+worker | yes | `postgres://app_system:pass@host:5432/db` | The `app_system` login: auth, webhook routing, scheduler fan-out, pg-boss. | Postgres host | F1 |
| `ENCRYPTION_KEY` | api+worker | yes | `<base64 of 32 random bytes>` from `openssl rand -base64 32` | Encrypts secrets in the database (texting subaccount tokens, calendar refresh tokens). Never change it once data exists. D1 also derives `RELAY_TOKEN_SECRET` from it. | generate (no roadmap row) | F1 |
| `GOOGLE_CLIENT_ID` | api+worker | optional | `1234567890-abc.apps.googleusercontent.com` | Sign in with Google. Unset: those calls answer 503. Also the Google Calendar client (C1). | [Roadmap: Google Cloud OAuth verification] | F1 |
| `POSTMARK_TOKEN` | api+worker | optional (logs only when unset; warns in production) | `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` | Postmark server token for all app email (login, invites, storm email). | [Roadmap: Postmark server] | F1 |
| `MAIL_FROM` | api+worker | required when `POSTMARK_TOKEN` is set | `Roofline <hello@example.com>` | Verified From header. Its domain is also the default storm sender domain (S1). | [Roadmap: Postmark server], [Roadmap: Domains] | F1 |
| `TWILIO_AUTH_TOKEN` | api+worker | optional; required when `TWILIO_ACCOUNT_SID` is set | 32 hex characters | Master token: checks Twilio webhook signatures for companies without a subaccount token. | [Roadmap: Twilio ISV account] | F1 |
| `WEB_DIST_DIR` | api (+worker, see 1.1) | optional (set in production) | `apps/web/dist` | Where the built web app is. Set: the API serves the app too. Must contain `index.html` or start-up stops. | none | F2 |
| `NWS_USER_AGENT` | api+worker | optional | `Roofline (ops@example.com)` | How api.weather.gov is told who is asking. Unset: `Roofline (<PUBLIC_BASE_URL>)`. | none | F2 |
| `WEATHER_DISABLED` | api+worker | optional | `0` / `1` | `1` turns the weather service off (no network). | none | F2 |
| `TRUST_PROXY` | api+worker | optional (default `0`) | `1` | Proxy hops to trust for the client address (rate limits, audit log). Set it to the hops Render puts in front. | none | F1 |
| `API_RATE_LIMIT_PER_MIN` | api+worker | optional (default `600`) | `600` | Requests per minute per session on `/api/*`. | none | F1 |
| `PORT` | api | optional (default `4400`) | `10000` | Listen port. Render sets it. | none | F1 |
| `HOST` | api | optional | `0.0.0.0` | Listen address. Default `0.0.0.0` in production, `127.0.0.1` otherwise. | none | F2 |
| `STRIPE_SECRET_KEY` | api+worker | optional; unset = billing off | `sk_live_…` (`sk_test_…` for staging) | Stripe API. Must start with `sk_`. | [Roadmap: Stripe account] | F3 |
| `STRIPE_WEBHOOK_SECRET` | api+worker | required when `STRIPE_SECRET_KEY` is set | `whsec_…` | Checks Stripe webhook signatures at `/hooks/stripe`. Unset: the endpoint answers 503. | [Roadmap: Stripe account] | F3 |
| `BILLING_PLANS_FILE` | api+worker | required in production when `STRIPE_SECRET_KEY` is set | `config/billing-plans.json` | The plans JSON (prices, allowances). Outside production it defaults to `config/billing-plans.example.json`. | [Money: Plan prices and allowances] | F3 |
| `GEOCODIO_API_KEY` | api+worker | optional; unset = no address lookup | 40-ish character key | Address geocoding (F3/C1); S1 reverse geocoding. | [Roadmap: MapTiler and Geocodio] | F3 |
| `TWILIO_ACCOUNT_SID` | api+worker | optional | `AC` + 32 hex digits | Master Twilio account (ISV): texting subaccounts, registration, D1 voice. | [Roadmap: Twilio ISV account] | F3 |
| `TWILIO_PRIMARY_PROFILE_SID` | api+worker | optional (needed for texting registration) | `BU` + 32 hex digits | Roofline's primary customer profile for A2P registration. | [Roadmap: Twilio ISV account] | F3 |
| `POLICY_PAGES_DOMAIN` | api+worker | optional in the schema, **needed in practice** (see 1.9) | `roofline.app` (bare hostname) | Hosts `https://<slug>.<domain>/privacy` and `/terms` (texting registration), and S1 storm landing pages. Needs wildcard DNS. | [Roadmap: Domains], [Roadmap: Twilio ISV account] (privacy and terms URLs) | F3 |
| `FAKE_PROVIDERS` | api+worker | **must be unset in production** (refused) | `1` | Dev and test only: every outside service is a fake. | none | F3 |

### 1.3 C1 Core CRM

| Name | Service | Required | Example format | What it is for | Owner to-do | Branch |
|---|---|---|---|---|---|---|
| `GOOGLE_CLIENT_SECRET` | api+worker | optional; needs `GOOGLE_CLIENT_ID` | `GOCSPX-…` | Google Calendar connections. Unset: Google Calendar is off. | [Roadmap: Google Cloud OAuth verification] | C1 |
| `MICROSOFT_CLIENT_ID` | api+worker | optional; both or neither with the secret | a GUID | Outlook calendar connections (multi-tenant Entra app). | [Roadmap: Microsoft Entra multi-tenant app] | C1 |
| `MICROSOFT_CLIENT_SECRET` | api+worker | optional; both or neither | Entra client secret value | Outlook calendar connections. | [Roadmap: Microsoft Entra multi-tenant app] | C1 |

Register these OAuth redirect URIs: `<PUBLIC_BASE_URL>/api/calendar/oauth/google/callback` and
`<PUBLIC_BASE_URL>/api/calendar/oauth/microsoft/callback`. Until Google verifies the consent screen, add pilot users as
test users (unverified apps are capped at 100 users).

### 1.4 E1 Estimator and homeowner page

| Name | Service | Required | Example format | What it is for | Owner to-do | Branch |
|---|---|---|---|---|---|---|
| `EAGLEVIEW_CLIENT_ID` | api+worker | optional; both or neither | client id string | EagleView aerial data and exact reports. Unset: footprint and manual drawing only. | [Roadmap: EagleView partner agreement] | E1 |
| `EAGLEVIEW_CLIENT_SECRET` | api+worker | optional; both or neither | client secret string | As above. | [Roadmap: EagleView partner agreement] | E1 |
| `EAGLEVIEW_ENV` | api+worker | optional (default `sandbox`) | `sandbox` or `production` | Which EagleView environment to call. | [Roadmap: EagleView partner agreement] | E1 |
| `EAGLEVIEW_PRODUCT_ID` | api+worker | optional (default `0` = placeholder) | a positive whole number | The report product to order. `0` means "ask before ordering". | [Roadmap: EagleView partner agreement], [Money: EagleView markup] | E1 |
| `R2_ACCOUNT_ID` | api+worker | **required in production** on `e1-estimator` (all four or none) | 32 hex characters | Cloudflare R2 account. Signed proposals (E1), call recordings (D1), claim packets (G1). | [Roadmap: Cloudflare R2 bucket and keys] | E1 |
| `R2_ACCESS_KEY_ID` | api+worker | as `R2_ACCOUNT_ID` | 32 hex characters | R2 S3 access key. | [Roadmap: Cloudflare R2] | E1 |
| `R2_SECRET_ACCESS_KEY` | api+worker | as `R2_ACCOUNT_ID` | 64 hex characters | R2 S3 secret. | [Roadmap: Cloudflare R2] | E1 |
| `R2_BUCKET` | api+worker | as `R2_ACCOUNT_ID` | `roofline-prod` | The private bucket name. | [Roadmap: Cloudflare R2] | E1 |
| `PROPOSAL_LINK_BASE_URL` | api+worker | optional (default `APP_ORIGIN`) | `https://app.example.com` | Base of homeowner proposal links. Must share `APP_ORIGIN`'s origin (start-up refuses another origin on `e1-estimator`). | [Roadmap: Domains] | E1 |
| `FOOTPRINTS_BASE_URL` | api+worker | optional | default `https://usbuildingdata.blob.core.windows.net/usbuildings-v2/` | Where the Microsoft US Building Footprints files are read from (ODbL, attribution in the app). | none (public data) | E1 |

### 1.5 S1 Storm Scout (API side)

| Name | Service | Required | Example format | What it is for | Owner to-do | Branch |
|---|---|---|---|---|---|---|
| `GOOGLE_ADS_DEVELOPER_TOKEN` | api+worker | optional; all five or none | 22-character token | Google Ads API access (Basic access). Unset: Google ads off. | [Roadmap: Google Ads manager account and developer token] | S1 |
| `GOOGLE_ADS_MANAGER_ID` | api+worker | all five or none | `123-456-7890` (dashes are stripped) | The manager (MCC) account clients are linked under. | [Roadmap: Google Ads manager account] | S1 |
| `GOOGLE_ADS_CLIENT_ID` | api+worker | all five or none | `….apps.googleusercontent.com` | OAuth client for the Ads API. | [Roadmap: Google Ads] | S1 |
| `GOOGLE_ADS_CLIENT_SECRET` | api+worker | all five or none | `GOCSPX-…` | OAuth client secret for the Ads API. | [Roadmap: Google Ads] | S1 |
| `GOOGLE_ADS_REFRESH_TOKEN` | api+worker | all five or none | `1//0…` | OAuth refresh token of the manager login. | [Roadmap: Google Ads] | S1 |
| `GOOGLE_ADS_API_VERSION` | api+worker | optional (default `v21`) | `v21` | Google Ads API version. | none | S1 |
| `META_APP_ID` | api+worker | optional; all four or none | digits | Meta app. Unset: Meta ads off. | [Roadmap: Meta app: Business Verification, Advanced Access, system user] | S1 |
| `META_APP_SECRET` | api+worker | all four or none | 32 hex characters | Meta app secret. | [Roadmap: Meta app] | S1 |
| `META_SYSTEM_USER_TOKEN` | api+worker | all four or none | `EAA…` | System user token for `ads_management` / `ads_read`. | [Roadmap: Meta app] | S1 |
| `META_BUSINESS_ID` | api+worker | all four or none | digits | The business that ad accounts are shared with. | [Roadmap: Meta app] | S1 |
| `META_GRAPH_VERSION` | api+worker | optional (default `v24.0`) | `v24.0` | Graph API version. | none | S1 |
| `POSTMARK_BROADCAST_STREAM` | api+worker | optional (default `broadcast`) | `broadcast` | Postmark message stream for storm email. | [Roadmap: Postmark broadcast stream] | S1 |
| `POSTMARK_WEBHOOK_SECRET` | api+worker | optional; unset = webhook refuses every call | 16+ random characters | Basic-auth password (any user name) Postmark sends to `/hooks/postmark` (hard bounces, spam complaints opt the address out). | [Roadmap: Postmark broadcast stream] (S1 smoke row names it) | S1 |
| `STORM_MAIL_FROM` | api+worker | optional | `storms@example.com` | Plain From for storm email. Unset: `storms@` + the `MAIL_FROM` domain, else `POLICY_PAGES_DOMAIN`, else the `PUBLIC_BASE_URL` host. Must be a verified Postmark sender. | [Roadmap: Postmark server] | S1 |
| `HAIL_STALE_MINUTES` | api+worker | optional (default `90`, 1-10080) | `90` | When the storm screen shows the hail data as stale (banner only). | none | S1 |
| `OPS_ALERT_EMAIL` | api+worker **and** hail | optional (api: unset = log only); see hail | `ops@example.com` | API: the `hail-health` schedule emails it when hail data is stale. Hail: alert after 3 failed ticks. | [Roadmap: Second Render worker ... and an ops alert email] | S1 |

### 1.6 S1 hail service (`services/hail`, Python)

| Name | Service | Required | Example format | What it is for | Owner to-do | Branch |
|---|---|---|---|---|---|---|
| `HAIL_DATABASE_URL` | hail | **yes** (exits without it) | `postgres://app_hail:pass@host:5432/db` | The `app_hail` login. It writes only `hail_runs`, `storms`, `storm_contours`. | [Roadmap: Second Render worker for the hail service] | S1 |
| `OPS_ALERT_EMAIL` | hail | optional (no alert email when unset) | `ops@example.com` | Receives the "3 failed runs in a row" email. **Also used as the From address**, so it must be a verified Postmark sender. | [Roadmap: ... and an ops alert email] | S1 |
| `POSTMARK_SERVER_TOKEN` | hail | optional (no alert email when unset) | `xxxxxxxx-xxxx-…` | Postmark token for that alert. Same value as the API's `POSTMARK_TOKEN`, different name (see 1.10). | [Roadmap: Postmark server] | S1 |

### 1.7 D1 Front Desk (on `d1-w6a`; not yet on `d1-front-desk`)

| Name | Service | Required | Example format | What it is for | Owner to-do | Branch |
|---|---|---|---|---|---|---|
| `ANTHROPIC_API_KEY` | api+worker | optional; unset = Front Desk off (and G1 drafting off) | `sk-ant-…` | Claude for calls and texts. | [Roadmap: Anthropic organization, production key, rate tier and spend limits] | D1 (`d1-t4` → `d1-w6a`) |
| `FRONT_DESK_ROUTER_MODEL` | api+worker | optional (default `claude-haiku-5-5`) | model id | Routes each caller turn; summaries. | none | D1 |
| `FRONT_DESK_ANSWER_MODEL` | api+worker | optional (default `claude-opus-5-5`) | model id | Writes the answers. | none | D1 |
| `FRONT_DESK_OPUS_FAST` | api+worker | optional (default `0`) | `0` / `1` | Faster Opus output mode (about twice the price). | [Money: Opus fast mode or not] | D1 |
| `FRONT_DESK_MAX_CALLS` | api+worker | optional (default `40`, 1-1000) | `40` | Most calls answered at once, **per API process**. | none | D1 |
| `RELAY_PUBLIC_URL` | api+worker | optional; must be `wss://` in production | `wss://app.example.com/relay` | Where Twilio ConversationRelay connects. Unset: `PUBLIC_BASE_URL` with `wss` and `/relay`. | [Roadmap: Twilio voice ... ConversationRelay enabled] | D1 |
| `TWILIO_TEST_CALLER_NUMBER` | api+worker | optional (needed for forwarding tests) | `+14025550100` (E.164) | Roofline's own number; the caller for forwarding tests. | [Roadmap: Twilio voice ... and a Roofline test caller number] | D1 |
| `RELAY_TOKEN_SECRET` | api+worker | optional (default derived from `ENCRYPTION_KEY` by HKDF) | 32+ random bytes, e.g. `<base64 of 32 random bytes>` | Signs relay tokens. Ruling DP. | generate (no roadmap row) | D1 |

D1 also needs a code change before live calls: the ElevenLabs voice ids for maya, claire, daniel and marcus in
`apps/api/src/hooks/twilio-voice-common.ts` are placeholders. *[Roadmap: Voice choice for the phone front desk]*

### 1.8 G1 (next release; on `g1-w6` and `g1-t*`, not on `g1-agents` yet)

| Name | Service | Required | Example format | What it is for | Owner to-do | Branch |
|---|---|---|---|---|---|---|
| `AGENT_DRAFT_MODEL` | api+worker | optional (default `claude-opus-5-5`) | model id | Drafts customer texts (follow-up, claims). Needs `ANTHROPIC_API_KEY`. | [Roadmap: Anthropic organization] | G1 (`g1-t4` …) |
| `AGENT_EXTRACT_MODEL` | api+worker | optional (default `claude-haiku-5-5`) | model id | Extracts claim facts from a homeowner's reply. | [Roadmap: Anthropic organization] | G1 |
| `MAPTILER_SERVER_KEY` | api+worker | optional; unset = claim packets have no map | MapTiler key | Static map in claim packets (server side, separate from the web build key). | [Roadmap: MapTiler and Geocodio] (G1 static maps) | G1 (`g1-t3` …) |

### 1.9 Database scripts, web build, and smoke-only names

| Name | Service | Required | Example format | What it is for | Owner to-do | Branch |
|---|---|---|---|---|---|---|
| `DATABASE_URL_OWNER` | db scripts | required in production | `postgres://owner:pass@host:5432/db` | Migration owner (`db:migrate`, `db:preflight`, `set-role-passwords`). Never give it to the API, worker or hail. | Postgres host | F1 |
| `TENANT_DB_PASSWORD` | db scripts | required for `set-role-passwords` | long random string | Password set on `app_tenant`; must match `DATABASE_URL_TENANT`. | generate | F1 |
| `SYSTEM_DB_PASSWORD` | db scripts | required for `set-role-passwords` | long random string | Password set on `app_system`; must match `DATABASE_URL_SYSTEM`. | generate | F1 |
| `HAIL_DB_PASSWORD` | db scripts | optional; set it for S1 | long random string | Gives `app_hail` a login (it is created NOLOGIN by 0018). Build `HAIL_DATABASE_URL` from it. | [Roadmap: Second Render worker for the hail service] | S1 |
| `VITE_MAPTILER_KEY` | web build | optional; unset = no basemap | MapTiler key | Map tiles. Read at build time and shipped in the bundle (a browser key: restrict it by domain). Never commit it. | [Roadmap: MapTiler and Geocodio] | F2 |
| `VITE_MAP_TILES` | web build | optional | `osm` | `osm` draws OpenStreetMap tiles when there is no MapTiler key (dev). Leave unset in production. | none | F2 |
| `SMOKE_BRAND_JSON` | smoke only | for `smoke:texting --submit` | one JSON object (brand fields) | Roofline's own brand for the F3 texting smoke. | [Roadmap: Twilio ISV ... Roofline's own brand] | F3 |
| `SMOKE_INBOUND_URL`, `SMOKE_STATUS_CALLBACK_URL` | smoke only | optional | `https://…` | Override the texting smoke's placeholder webhook URLs. | none | F3 |
| `SMOKE_COMPANY_ID`, `SMOKE_PROPOSAL_ID`, `SMOKE_OWNER_USER_ID` | smoke only | for `smoke:estimator --sms` | UUIDs | The staging company, draft proposal and owner user for the E1 text check. | [Roadmap: Manual smoke tests] | E1 |

Test-only names (never set in production): `HAIL_TEST_DATABASE_URL` (hail pytest), `CI`, `PW_CHROMIUM_EXECUTABLE`
(Playwright).

**Counts.** API/worker config: 65 names across all branches (54 on the F1-S1 branches, 8 more from D1, 3 more from
G1). Plus 4 db-script names, 2 hail-only names (`HAIL_DATABASE_URL`, `POSTMARK_SERVER_TOKEN`; `OPS_ALERT_EMAIL` is
shared), 2 web-build names: **73 deployable names**. Plus 6 smoke-only names and 3 test-only names.

### 1.10 Conflicts and inconsistencies between branches

1. **R2 in production.** `e1-estimator` (Ruling ET) refuses to start in production without all four `R2_*`.
   `s1-storm`, `a1-agents`, `g1-agents` and `launch-integration` carry the older E1 config: R2 is optional, and the
   README says "expected in production". The launch merge must keep E1's rule. Production therefore needs R2 before
   the first deploy.
2. **`PROPOSAL_LINK_BASE_URL` origin check.** `e1-estimator` refuses a value on another origin than `APP_ORIGIN`.
   `s1-storm`, `a1-agents`, `g1-agents` only document it. Same cause as 1.
3. **Postmark token name.** The API reads `POSTMARK_TOKEN`; the hail service reads `POSTMARK_SERVER_TOKEN`. Same
   value, two names. The hail alert also uses `OPS_ALERT_EMAIL` as its From address and the `outbound` stream.
4. **`OPS_ALERT_EMAIL` is undocumented for the API.** It is in `config.ts` on `s1-storm` but missing from
   `.env.example` and the README table. The roadmap names it only for the hail worker.
5. **Two hail staleness thresholds.** `HAIL_STALE_MINUTES` (default 90) drives only the stale banner. The
   `hail-health` email uses a hard-coded 180 minutes (April-September) or 720 minutes (other months) and ignores
   the variable.
6. **D1 config is on a stale base.** `d1-w6a` branched before C1 added `GOOGLE_CLIENT_SECRET` and `MICROSOFT_*`, so
   its `config.ts`, `.env.example` and README lack them, and its `SCHEDULES` lacks `sweep-imports` and `calendar-pull`.
   This is base drift, not a removal. The D1 merge must keep C1's lines.
7. **`d1-front-desk` has no D1 settings yet.** Its `config.ts` equals `c1-crm`'s. All eight D1 variables live on the
   `d1-t4` → `d1-w6a` stack, waiting on the Task 4 merge.
8. **G1 variables are undocumented.** `AGENT_DRAFT_MODEL`, `AGENT_EXTRACT_MODEL` and `MAPTILER_SERVER_KEY` are in
   `config.ts` on `g1-w6` but not in its `.env.example` or README.
9. **`GOOGLE_CLIENT_ID` is shared.** One Google OAuth client serves Sign in with Google (F1) and Google Calendar
   (C1). The S1 Google Ads client (`GOOGLE_ADS_CLIENT_ID`) is a separate name and may be a separate client.
10. **README drift.** `a1-agents` README dropped the "Calendar connections" section. `s1-storm` README lacks E1's
    "Building footprints and proposal links" paragraph. `d1-w6a` README lacks C1's calendar rows and F3's billing
    section. Take the union at the launch merge.
11. **`POLICY_PAGES_DOMAIN` is optional in the schema but needed.** Texting registration needs the hosted privacy
    and terms URLs. S1 storm landing pages and ad campaigns stop without it (S1 I5 removed the `PUBLIC_BASE_URL`
    fallback).
12. **`HAIL_DATABASE_URL`** is only a comment in `.env.example` (`HAIL_DB_PASSWORD` likewise). That is by design
    (the API never reads it), but easy to miss.

---

## 2. Scheduled jobs and worker queues

All of these run in the **worker** process (`npm start -w @roofline/worker`) on pg-boss, in the `app_system`
database. Crons are UTC. Each schedule has its own queue, keeps at most one waiting job and does not retry (the next
tick is the retry). A schedule dropped from `SCHEDULES` is unscheduled when a worker starts. Several workers may run;
pg-boss hands each job to one of them.

### 2.1 Schedules (`apps/api/src/jobs/worker.ts`, `SCHEDULES`)

| # | Name | Cron (UTC) | What it does | Track |
|---|---|---|---|---|
| 1 | `expire-drafts` | `*/5 * * * *` | Draft plans past `expires_at` become `expired`. | F1 |
| 2 | `sweep-queued` | `* * * * *` | Re-queues approved steps stuck in `queued` or stranded. | F1 |
| 3 | `sweep-imports` | `* * * * *` | Re-sends `import-customers` for stranded imports (queued 2 min, processing 30 min). | F3 |
| 4 | `dispatch-messages` | `* * * * *` | Sends texts whose quiet-hours wait is over; finishes batch steps. | F1/F3 |
| 5 | `end-trials` | `*/5 * * * *` | Ends trials past `trial_ends_at`; one audit row each. | F3 |
| 6 | `report-usage` | `* * * * *` | Reports metered usage and invoice items to Stripe. Skipped without Stripe. | F3 |
| 7 | `provision-texting` | `* * * * *` | Creates a Twilio subaccount for each ready company (20 per tick). | F3 |
| 8 | `poll-texting` | `0 * * * *` | Polls texting registration status. | F3 |
| 9 | `bill-monthly-fees` | `0 9 1 * *` | Bills the monthly number and registration fees on the 1st. | F3 |
| 10 | `prune-early-reports` | `17 3 * * *` | Deletes unmatched early delivery reports. | F3 |
| 11 | `calendar-pull` | `*/5 * * * *` | Pulls outside calendar changes (50 due connections per tick). | C1 |
| 12 | `footprints-ensure` | `*/15 * * * *` | Queues `footprints-load` for each needed state not ready or loading. | E1 |
| 13 | `exact-report-poll` | `*/10 * * * *` | Polls EagleView for waiting exact-report orders. | E1 |
| 14 | `signed-pdf-sweep` | `*/15 * * * *` | Re-queues `signed-pdf` for signatures over 10 min old with no PDF. **Only on `e1-estimator`** (see 2.4). | E1 |
| 15 | `spotter-sync` | `*/30 * * * *` | Pulls NOAA SPC storm spotter reports. | S1 |
| 16 | `storm-match` | `*/10 * * * *` | Queues `storm-match-company` for companies whose area meets a recent storm. | S1 |
| 17 | `ad-spend-sync` | `0 * * * *` | Queues `ad-sync-company` for companies with ad accounts or live campaigns. | S1 |
| 18 | `hail-health` | `*/15 * * * *` | Emails `OPS_ALERT_EMAIL` once when hail data goes stale. | S1 |
| 19 | `fd-retention` | `17 3 * * *` | Deletes old call recordings in R2 and blanks old transcript text (defaults 90/365 days). | D1 |
| 20 | `fd-health` | `*/2 * * * *` | Repairs missing voice URLs on numbers (Ruling DE); worker-side checks (Ruling DQ). | D1 |
| 21 | `claims-daily-schedule` | `*/15 * * * *` | Sends `claims-daily` once per company local day. | G1 (next release) |
| 22 | `scheduler-reminders-schedule` | `*/15 * * * *` | Sends `scheduler-reminders` at the company's reminder hour. | G1 (next release) |
| 23 | `scheduler-agenda-schedule` | `*/15 * * * *` | Sends `scheduler-agenda` once per local day. | G1 (next release) |
| 24 | `scheduler-weather-schedule` | `*/15 * * * *` | Sends `scheduler-weather` per local day and hour. | G1 (next release) |
| 25 | `followup-daily-schedule` | `*/15 * * * *` | Sends `followup-daily` once per local day. | G1 (next release) |

Launch set: 1-20 (20 schedules). With G1: 25.

### 2.2 Job queues (`apps/api/src/jobs/queue.ts`, `JOB_NAMES`) and the step queue

Job queues use policy `stately`, 5 attempts (retry limit 4, backoff from 30 s). A job without a valid company id is
logged and dropped.

| Queue | What it does | Track |
|---|---|---|
| `agent-step` | Runs each approved agent step (`runStep`); 4 at a time per worker. | F1 |
| `import-customers` | Runs one customer import. | F3 |
| `texting-registration` | Advances one company's texting registration. | F3 |
| `calendar-push` | Pushes an appointment change to the connected calendar. | C1 |
| `footprints-load` | Loads one state's building footprints into PostGIS (6 h expiry; singleton per state). | E1 |
| `signed-pdf` | Renders and stores a signed proposal PDF in R2. | E1 |
| `storm-match-company` | Matches one company's area to recent storms. | S1 |
| `storm-draft` | Drafts the storm plan for one company storm. | S1 |
| `storm-alert` | Sends one storm alert (kind `now` or `plan`). | S1 |
| `ad-sync-company` | Syncs one company's ad accounts, campaigns and spend. | S1 |
| `fd-after-call` | After-call summary and follow-up (singleton per CallSid). | D1 |
| `fd-recording-store` | Moves a call recording from Twilio to R2, then deletes Twilio's copy. | D1 |
| `fd-text` | Runs Front Desk's reply to an inbound text. | D1 |
| `fd-forwarding-test` | Ends a forwarding test call after 30 s. | D1 |
| `claims-daily`, `scheduler-reminders`, `scheduler-agenda`, `scheduler-weather`, `followup-daily` | The G1 agents' daily plans (sent by the schedules above). | G1 (next release) |
| `claims-reply` | Extracts claim facts from a homeowner's reply. | G1 (next release) |
| `scheduler-no-show` | No-show follow-up, sent from the no-show route. | G1 (next release) |

Launch set: 14 queues (13 job queues + `agent-step`). With G1: 21.

### 2.3 Other long-running work

| Work | Where it runs | What it does | Track |
|---|---|---|---|
| Hail loop (`python -m hail.main`) | hail worker | Ticks at :05 and :35 each hour (UTC): fetches NOAA MRMS MESH, contours 8 hail levels, writes runs/storms/contours as `app_hail`. One email after 3 failed ticks in a row. SIGTERM stops after the current tick. | S1 |
| Relay WebSocket (`/relay`) | **API** process | Twilio ConversationRelay sessions for live calls. Capped by `FRONT_DESK_MAX_CALLS` per process; the model health breaker is per process. | D1 |

### 2.4 Schedule notes and conflicts

- `signed-pdf-sweep` exists only on `e1-estimator`. `s1-storm`, `a1-agents`, `g1-agents`, `g1-w6` and
  `launch-integration` were merged from E1 before it. The launch merge must keep it.
- `fd-retention` and `prune-early-reports` both run at 03:17 UTC (D1 ledger minor). Harmless, but one could move.
- The integration probe found no duplicate job names, schedules or route mounts across tracks.

---

## 3. Infrastructure services

### 3.1 Services

| Service | What it runs | Sizing and cost notes | Health check |
|---|---|---|---|
| **API** (Render web service, Node 22.13+) | `npm start -w @roofline/api`. Serves `/api`, `/hooks`, the built web app (`WEB_DIST_DIR`), public pages, and the `/relay` WebSocket (D1). | Must be always on (live calls hold WebSockets; serverless does not fit). Run **one** instance while D1's per-process call cap and health breaker hold. | `GET /health` answers `{"ok":true}` once it listens. |
| **Worker** (Render background worker) | `npm start -w @roofline/worker`. Same env as the API. | Several may run (pg-boss). Each runs 4 steps at once. | No HTTP endpoint. Start-up logs `Roofline worker started (...)` with the queue and schedule list; failures go to the log. |
| **Hail worker** (Render background worker, Docker) | Dockerfile `services/hail/Dockerfile`, context `services/hail`, image `ghcr.io/osgeo/gdal:ubuntu-small-3.8.5`. Leave the start command empty (CMD `python -m hail.main`). No `render.yaml` (Ruling SB). | About $7-25 per month (S1 spec). Downloads a GRIB2 file per tick to a temp dir. | No HTTP endpoint. Watch for a new `hail_runs` row every 30 min, the 3-failure email, and the API's `hail-health` email. |
| **Postgres with PostGIS** (managed; the specs choose Supabase Postgres, database only) | All data and the pg-boss queues. | Postgres 16+; CI and tests use `postgis/postgis:16-3.4`; the README notes Supabase's Postgres 17 image was checked. Footprints are large (about 130 million buildings nationwide, loaded per state): record the size in E1 smoke (d). | `npm run db:preflight` after each migrate. |
| **Cloudflare R2 bucket** (private) | Signed proposals (E1), call recordings (D1), claim packets (G1). | The bucket stays private; the E1 client never builds a public URL. Use a separate test bucket for smoke. | E1 smoke (b) put/get/delete. |
| **Postmark** | App email (server token), storm email (broadcast stream), bounce/complaint webhook. | Two streams: transactional (`outbound`) and `broadcast`. | F3 smoke (e), S1 smoke (d). |
| **Twilio** (ISV master account + subaccounts) | Texting (A2P 10DLC), registration, voice and ConversationRelay (D1), forwarding tests. | 10-15 days per brand for registration. | F3 smoke (b); D1 smoke (not built). |
| **Stripe** | Subscriptions, metered usage, invoices. | Products and prices from `npm run sync:stripe-plans -w @roofline/api`. | F3 smoke (a). |
| **Geocodio** | Address lookup and reverse geocoding. | Confirm quota. | F3 smoke (d). |
| **MapTiler** | Basemap tiles (browser key at build time); G1 static maps (server key). | Confirm quota. | Map shows tiles. |
| **EagleView** | Aerial data and exact reports. | Partner agreement; sandbox first. | E1 smoke (a). |
| **Google OAuth app** | Sign in with Google; Google Calendar. | Verification can take weeks; 100-user cap until verified. | C1 smoke (not built). |
| **Microsoft Entra app** (multi-tenant) | Outlook calendar. | Publisher verification. | C1 smoke (not built). |
| **Google Ads** (manager account, developer token) | Storm ads. | Basic access, about 2 business days. | S1 smoke (b). |
| **Meta app** (Business Verification, Advanced Access, system user) | Storm ads. | Days to 2 weeks. | S1 smoke (c). |
| **Anthropic** (organization, production key) | Front Desk (D1); G1 drafting. | Set rate tier and spend limits. AI minutes must be priced to cover about $0.10-0.12 per minute. | D1 smoke (not built). |
| **Public data, no account** | NOAA MRMS (S3 `noaa-mrms-pds`, hail), NOAA SPC spotter reports, api.weather.gov (`NWS_USER_AGENT`), Microsoft US Building Footprints. | Outbound HTTPS from the worker and hail worker. | `hail_runs`, `building_footprint_states`. |

### 3.2 Database roles

| Role | Created by | Login | Used by | Rights |
|---|---|---|---|---|
| owner (`DATABASE_URL_OWNER`) | the host | yes | migrate, preflight, set-role-passwords only | Owns the tables; needs `CREATEROLE` and `CREATE` on the database (owning it is simplest). Not a superuser. |
| `app_tenant` | migration 0002 | yes (`TENANT_DB_PASSWORD`) | API and worker request work | NOBYPASSRLS; row-level security forced on every tenant table. |
| `app_system` | migration 0002 | yes (`SYSTEM_DB_PASSWORD`) | auth, webhook routing, scheduler fan-out, pg-boss | NOBYPASSRLS; column-level grants only. |
| `app_hail` | migration 0018 (S1) | NOLOGIN until `HAIL_DB_PASSWORD` is set | hail worker | Only `hail_runs`, `storms`, `storm_contours` (+ delete on contours). |

### 3.3 Migrations

- F1-F3: `0000`-`0012`. C1: `0013`/`0014`. E1: `0015`/`0016`. S1: `0017`/`0018`. D1: `0019`/`0020`. A1:
  `0021`/`0022`. G1: `0023`/`0024`. Never reuse a number. The launch merge keeps journal `when` values strictly
  increasing (G1 ledger Ruling GX-L, A1 ledger Ruling AY).
- Extensions `postgis` and `citext` must be in the `public` schema (not Supabase's `extensions` schema). The first
  migration creates them where the owner may. `db:migrate` moves `citext` into `public`; it stops if `postgis` is
  elsewhere.
- Every `db:migrate` revokes Supabase's `anon` and `authenticated` grants on `public` and `pgboss`.

### 3.4 Database setup, in order

1. `DATABASE_URL_OWNER=… npm run db:migrate` (before each new version starts).
2. `DATABASE_URL_OWNER=… npm run db:preflight`. It must print `Preflight passed.` It checks extensions in `public`,
   no Supabase Data API grants, app roles neither superuser nor BYPASSRLS, forced RLS on every tenant table.
3. Once per new database (or to rotate):
   `DATABASE_URL_OWNER=… TENANT_DB_PASSWORD=… SYSTEM_DB_PASSWORD=… HAIL_DB_PASSWORD=… npm run set-role-passwords -w @roofline/db`.
4. Build `DATABASE_URL_TENANT`, `DATABASE_URL_SYSTEM` and `HAIL_DATABASE_URL` from those passwords.

### 3.5 Endpoints to register with providers

| Provider | Setting | Value |
|---|---|---|
| Stripe | webhook endpoint | `<PUBLIC_BASE_URL>/hooks/stripe` with exactly: `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed` |
| Twilio | registration status callback | `<PUBLIC_BASE_URL>/hooks/twilio-registration` |
| Twilio | texting webhooks (mounted) | `<PUBLIC_BASE_URL>/hooks/twilio/sms`, `/hooks/twilio/status` |
| Twilio | voice (D1; the app sets voice URLs on numbers) | `/hooks/twilio/voice`, `/hooks/twilio/voice-status`, `wss://…/relay` |
| Twilio | Advanced Opt-Out | keep on, default keywords |
| Postmark | bounce and spam-complaint webhook | `<PUBLIC_BASE_URL>/hooks/postmark`, basic auth, any user name, password `POSTMARK_WEBHOOK_SECRET` |
| Google | OAuth redirect | `<PUBLIC_BASE_URL>/api/calendar/oauth/google/callback` |
| Microsoft | OAuth redirect | `<PUBLIC_BASE_URL>/api/calendar/oauth/microsoft/callback` |
| DNS | wildcard | `*.<POLICY_PAGES_DOMAIN>` → the API service (policy pages, storm landing pages) |

---

## 4. Owner's go-live checklist (dependency order)

Start the long-lead items on day one. Each step names its roadmap row.

### A. Accounts, contracts, decisions (long lead first)

1. Twilio ISV account, A2P 10DLC, Roofline's own brand. *[Roadmap: Twilio ISV account]* 10-15 days per brand.
2. Google Cloud OAuth consent screen verification for the Calendar scope. *[Roadmap: Google Cloud OAuth verification]*
3. Meta Business Verification, Advanced Access for `ads_management`/`ads_read`, a system user. *[Roadmap: Meta app]*
4. EagleView partner agreement and API credentials. *[Roadmap: EagleView partner agreement]*
5. Google Ads manager account and developer token with Basic access. *[Roadmap: Google Ads]*
6. Microsoft Entra multi-tenant app and publisher verification. *[Roadmap: Microsoft Entra]*
7. Twilio voice on subaccounts, ConversationRelay enabled, AI/ML addendum accepted, a test caller number.
   *[Roadmap: Twilio voice ...]*
8. Same day: Postmark server and broadcast stream; Stripe account; domains; MapTiler; Geocodio; Cloudflare R2;
   Anthropic organization with rate tier and spend limits. *[Roadmap: Postmark server, Stripe account, Domains,
   MapTiler and Geocodio, Cloudflare R2, Postmark broadcast stream, Anthropic organization]*
9. Hosting accounts: Render (API, worker, hail worker) and the Postgres host. *[Roadmap: Second Render worker for the
   hail service]* (the API, worker and database have no roadmap row; see 6).
10. Test phones on Verizon, AT&T, T-Mobile and a landline/VoIP line. *[Roadmap: Test phones]*
11. Money decisions: plan prices and the EagleView markup, AI-minute price, ad budget default, hail hosting,
    time-saved baselines, Opus fast mode, zero data retention. *[Money: all rows]*
12. Lawyer review: terms, privacy, texting consent and TCPA (F3); e-sign (E1); storm wording, consent checkbox, ad
    claims, Meta Housing category (S1); call recording, AI disclosure, retention (D1). *[Lawyer: F3, E1, S1, D1 rows]*

### B. Credentials

13. Generate `ENCRYPTION_KEY` (`openssl rand -base64 32`). Store it safely. It can never change once data exists.
14. Generate `TENANT_DB_PASSWORD`, `SYSTEM_DB_PASSWORD`, `HAIL_DB_PASSWORD`, `POSTMARK_WEBHOOK_SECRET` (16+), and
    optionally `RELAY_TOKEN_SECRET`.
15. Collect provider keys into the host's secret settings only (never a file in the repo): Postmark, Stripe
    (`sk_live_…`, `whsec_…`), Twilio (`AC…`, auth token, `BU…`), Geocodio, MapTiler (browser key, and server key for
    G1), EagleView, R2 (four values), Google OAuth, Microsoft, Google Ads (five), Meta (four), Anthropic.
16. Pick the ElevenLabs voices and replace the placeholder ids in code (a code change, before live calls).
    *[Roadmap: Voice choice]*

### C. Infrastructure

17. Create the Postgres database with PostGIS and citext available in `public`.
18. Create the private R2 bucket (and a separate test bucket for smoke). *[Roadmap: Cloudflare R2]*
19. DNS: the app domain; wildcard `*.<POLICY_PAGES_DOMAIN>`; Postmark SPF, DKIM and Return-Path; branded short links.
    *[Roadmap: Domains, Postmark server]*
20. Create the Render API web service, the worker, and the hail worker (Docker). Do not start them yet.

### D. Database and migrations

21. Run 3.4 steps 1-4 against the new database: migrate, preflight, set-role-passwords (with `HAIL_DB_PASSWORD`).

### E. Configuration

22. Set the 1.2-1.7 variables on the API and the worker (the same set). `NODE_ENV=production`,
    `WEB_DIST_DIR=apps/web/dist`, all four `R2_*`, `FAKE_PROVIDERS` unset.
23. Set `HAIL_DATABASE_URL`, `OPS_ALERT_EMAIL`, `POSTMARK_SERVER_TOKEN` on the hail worker. Verify `OPS_ALERT_EMAIL`
    as a Postmark sender.
24. Write the real `BILLING_PLANS_FILE`, then run `npm run sync:stripe-plans -w @roofline/api`. *[Roadmap: Stripe
    account]*
25. Register the endpoints in 3.5 (Stripe, Twilio, Postmark, OAuth redirects).

### F. Deploy

26. Build the launch branch from the track heads (merge order and rulings: the controller's launch merge; keep the
    items in 1.10 and 2.4).
27. Build step: `npm ci`, then `npm run build:web` with `VITE_MAPTILER_KEY` set (Vite is a dev dependency, so build
    before `npm ci --omit=dev`).
28. Start the API (`npm start -w @roofline/api`). Check `GET /health`.
29. Start the worker (`npm start -w @roofline/worker`). Check its start-up line lists every queue and schedule.
30. Start the hail worker. After the next :05 or :35, check a new `hail_runs` row.

### G. Smoke tests (owner, by hand; section 5)

31. F3 smoke: Stripe test clock, texting brand, hosted pages, Geocodio, Postmark, TrustHub SIDs.
32. C1 T29 calendar smoke (not built yet).
33. E1 T22 estimator smoke (EagleView sandbox, R2, one proposal text, Nebraska footprints).
34. S1 T29 storm smoke (hail on staging, Google Ads test account, Meta test account, broadcast email).
35. D1 T27 front desk smoke (not built yet).
    *[Roadmap: Manual smoke tests]*

### H. First company

36. Sign up the first company as its owner through the app (do not run `seed:dev`; it refuses outside development).
37. Work through its setup checklist: company details and service area, team invites, prices, schedule, calendar
    connection, billing (Stripe subscription), texting registration (its own brand, 10-15 days), phone forwarding
    and the forwarding test (D1), storm settings and ad connections (S1), agents (A1).
38. Watch the first day: worker logs, `hail-health`, Stripe webhook deliveries, Postmark bounces.

---

## 5. Manual smoke tests

**Rule for every smoke script:** never run `smoke:*` (or any by-hand eval) in automation: not in CI, a scheduled job,
a Routine, a builder or an agent session. The owner runs each by hand, in a terminal that holds the test credentials,
and fills in the runbook's sign-off table. Each script refuses to start without its confirmation flag; the CI guard
tests check only that refusal. Load settings with `set -a; . ./.env; set +a` from a private env file that is never
committed. If anything that looks like a secret is printed, stop and rotate it.

| Smoke | Command | Needs | Runbook | State |
|---|---|---|---|---|
| **F3** (platform) | `npm run sync:stripe-plans -w @roofline/api`, `npm run smoke:stripe -w @roofline/api`; `npm run smoke:texting -w @roofline/api -- --submit --confirm-real-registration` (then `--status`, then `--campaign --confirm-real-registration --privacy-url … --terms-url …`) | `sk_test_…` key and `whsec_…`; Twilio master SID/token, `TWILIO_PRIMARY_PROFILE_SID`, `SMOKE_BRAND_JSON`; the real policy domain; Geocodio; Postmark | `docs/superpowers/f3-manual-smoke.md` (sections a-g) | built |
| **C1 T29** (calendars) | planned: `npm run smoke:calendar -w @roofline/api -- --provider google\|microsoft --confirm-real-calendar` | Google and Microsoft OAuth clients, real test accounts, staging | planned: `docs/superpowers/c1-manual-smoke.md` | **not built yet**: no script, no runbook on any branch; brief `ops/sdd/c1/task-29-brief.md`; parked for the owner (C1 ledger) |
| **E1 T22** (estimator) | `npm run smoke:estimator -w @roofline/api -- --confirm-real-providers --eagleview-sandbox` (add `--place-order` for a sandbox order), `--r2`, `--sms +1XXXXXXXXXX`; all together: `--confirm-real-providers --eagleview-sandbox --r2 --sms +1XXXXXXXXXX` | `EAGLEVIEW_CLIENT_ID/SECRET`, `EAGLEVIEW_ENV=sandbox` (production refused), `EAGLEVIEW_PRODUCT_ID` > 0; four `R2_*` for a test bucket; staging deploy, approved texting brand, `SMOKE_COMPANY_ID`, `SMOKE_PROPOSAL_ID`, `SMOKE_OWNER_USER_ID`, the owner's test phone. Check (d) Nebraska footprints has no command: it runs through the staging worker. | `docs/superpowers/e1-manual-smoke.md` (on `e1-estimator`) | built (T22 merged); not run |
| **S1 T29** (storm) | `npm run smoke:storm -w @roofline/api -- --confirm-real-providers --google <testCustomerId>`, `--meta <testAdAccountId>`, `--email <your address>` (or all three in one command; `--i-understand-spend` only for a $1 real-account check) | Five `GOOGLE_ADS_*` + a test customer; four `META_*` + a test ad account; `POSTMARK_TOKEN`, `MAIL_FROM` or `STORM_MAIL_FROM`, `POSTMARK_BROADCAST_STREAM`, `APP_ORIGIN`, `ENCRYPTION_KEY`; for check (a), the staging hail worker with `HAIL_DATABASE_URL` and a read-only DB query tool | `docs/superpowers/s1-manual-smoke.md` (on `s1-storm`, `g1-agents`) | built (T29 merged); not run. Check (a) needs a `--once` flag the hail worker does not have (see 6) |
| **D1 T27** (front desk) | planned: `npm run smoke:front-desk -w @roofline/api -- --confirm-real-providers` | staging number with ConversationRelay, Anthropic key, test phones on each carrier, R2 | planned: `docs/superpowers/d1-manual-smoke.md` | **not built yet** (brief `ops/sdd/d1/task-27-brief.md`; D1 T7-T9, T19, T25, T27 open) |
| **G1 T18** (agent texts eval; next release) | planned: `eval:agent-texts --confirm-spend` | `ANTHROPIC_API_KEY`; real model spend | planned: `docs/superpowers/g1-acceptance.md` | **not built yet** (brief `ops/sdd/g1/task-18-brief.md`) |
| **A1** | none planned | — | — | A1 has no manual smoke in its plan |

---

## 6. Open questions found while gathering

1. **No roadmap row for the main hosting.** The owner list names the second Render worker (hail) but not the
   Render API web service, the main worker, or the Postgres host (Supabase per the specs). Add them, with a sizing
   decision.
2. **R2 in production.** Confirm the launch merge keeps E1 Ruling ET (production refuses to start without R2). The
   probe branch and the S1/A1/G1 branches carry the older optional rule.
3. **`signed-pdf-sweep`** must survive the launch merge (missing on S1, A1, G1 and the probe).
4. **Hail alert settings.** Rename `POSTMARK_SERVER_TOKEN` to `POSTMARK_TOKEN` (or document both)? Should the hail
   alert use a fixed verified From instead of `OPS_ALERT_EMAIL`?
5. **`OPS_ALERT_EMAIL`** for the API is missing from `.env.example` and the README. Add it.
6. **Two stale thresholds** for hail (banner `HAIL_STALE_MINUTES`=90; email 180/720 hard-coded). Intended?
7. **S1 smoke check (a)** needs `python -m hail.main --once`, which does not exist. Needs a ruling (S1 runbook's own
   open item).
8. **C1 T29** (`smoke:calendar`, `c1-manual-smoke.md`) is not built. `c1-acceptance.md` already links the runbook.
9. **D1 is not on its integration branch.** The config, jobs and schedules sit on `d1-w6a`, waiting for the D1 Task 4
   merge (owner approval of ci-check on `d1-t4` was pending). D1 T7-T9, T19, T25, T27 are open.
10. **ElevenLabs voice ids** are placeholders in code. Who picks them, and when?
11. **API scaling with D1.** `FRONT_DESK_MAX_CALLS` and the model health breaker are per process. Is one always-on
    API instance the launch plan? What instance size?
12. **`TRUST_PROXY`** on Render: how many hops (likely 1)? The default 0 makes every client look like the proxy.
13. **Worker and `WEB_DIST_DIR`.** Build the web app on the worker too, or leave the variable unset there?
14. **G1 variables** (`AGENT_DRAFT_MODEL`, `AGENT_EXTRACT_MODEL`, `MAPTILER_SERVER_KEY`) need `.env.example` and
    README rows when G1 lands.
15. **R2 signed URLs.** E1's R2 client says it never builds a presigned URL; D1 adds `signedGetUrl` for recordings
    (Ruling DV). Confirm this at the E1/D1 merge.
16. **Twilio texting webhooks.** Confirm the app sets `/hooks/twilio/sms` and `/hooks/twilio/status` on each number
    it provisions, or whether the owner sets them on the messaging service by hand.
17. **The E1 smoke address.** The owner should confirm the Omaha sandbox address (E1 ledger T22) before the first
    run.
18. **NANP area-code table** in `recording-consent.ts` was written from memory (D1 ledger). Check it before live
    calls.
