# Roofline
- **What is where:** `v1/` is the original single-company estimator (React + Express + SQLite); `packages/` (`shared`, `db`, `send-gate`) and `apps/` (`api`, `worker`) are the multi-company platform as npm workspaces that export TypeScript source (no build step); specs and plans live in `docs/superpowers/`.
- **Run v1:** `cd v1 && npm install && npm start`, then open http://127.0.0.1:4311 (v1 keeps its own `package.json`, `.env` and `data/`; see `v1/README.md`).
- **Run the platform tests:** `npm install`, then `npm test` (Vitest); `npm run typecheck` and `npm run lint` are the other checks, and `npm run db:up` starts the local PostGIS database (needs Docker).
- **Run v1's tests:** `cd v1 && npm test` (node:test) and `npm run test:e2e` (Playwright).

## Run it locally
- **Prerequisites:** Node 22.13 or newer, Docker (for the database), and `npm install` once at the repository root.
- **Environment:**
  1. `cp .env.example .env` and fill in `ENCRYPTION_KEY` (`openssl rand -base64 32`).
  2. In each terminal that runs one of the commands below, `set -a; . ./.env; set +a` first (the processes don't read `.env` themselves).
  3. In development `APP_ORIGIN` is Vite's origin, `http://127.0.0.1:4401`, because that is the Origin the browser sends. Leave `WEB_DIST_DIR` blank.
- **Set up the database (once):**
  1. `npm run db:up` starts PostGIS on port 54329.
  2. `npm run db:migrate` creates the tables and the two app roles (with `DATABASE_URL_OWNER` unset it uses the local compose database).
  3. `npm run set-role-passwords -w @roofline/db` gives the two roles the passwords from `TENANT_DB_PASSWORD` and `SYSTEM_DB_PASSWORD`.
  4. `npm run seed:dev -w @roofline/api` fills it with a demo company and its team. (The script comes with the dev seed, Task 9 of the F2 plan.)
- **Start the three processes**, each in its own terminal:
  1. `npm run dev:api` (the API, on http://127.0.0.1:4400).
  2. `npm run dev:worker` (runs approved steps and the scheduled jobs; without it, approvals wait in the queue).
  3. `npm run dev:web` (Vite, on http://127.0.0.1:4401, handing `/api`, `/hooks` and `/health` on to the API).
- **Open** http://127.0.0.1:4401.
- **Map tiles:** the map draws tiles only when `VITE_MAPTILER_KEY` is set where Vite starts (never commit it), or `VITE_MAP_TILES=osm` is set for OpenStreetMap's tiles. With neither it is a blank map and makes no network requests.

## Running locally with demo data
- **Database:** `npm run db:up` starts the local PostGIS database (needs Docker). Migrate it with `DATABASE_URL_OWNER=… npm run db:migrate`, then set the app role passwords with `DATABASE_URL_OWNER=… TENANT_DB_PASSWORD=… SYSTEM_DB_PASSWORD=… npm run set-role-passwords -w @roofline/db`, as the production boot order below describes.
- **Dev seed:** run `NODE_ENV=development DATABASE_URL_OWNER=<owner url> DATABASE_URL_TENANT=<app_tenant url> DATABASE_URL_SYSTEM=<app_system url> npm run seed:dev -w @roofline/api`. It refuses to run unless `NODE_ENV` is `development`.
- **Sign-ins:** the seed creates **Summit Roofing** (America/Chicago, Nebraska) only when no company has the slug `summit-roofing`. It has three users: `owner@summit.test` (Dana Park, owner), `office@summit.test` (Chris Lane, office, cannot approve spend) and `rep@summit.test` (Robin Hale, rep).
- **Password:** `roofline-demo-2026`. These are dev-only test credentials; the script never prints them.
- **Showcase:** the seed then loads an Omaha service area, 60 customers, 70 addresses, 28 jobs across every stage, and one storm plan waiting for approval. Running it again changes nothing.
- **Storm plan only:** `npm run seed:demo -w @roofline/api -- --company <slug>` adds just the storm plan to an existing company, and its sample text names that company.

## Running in production
- **Environment:** every variable is listed, with placeholders, in [`.env.example`](.env.example). The processes don't read a `.env` file; set the variables in the host (Render: the service's Environment tab). The API and the worker need the same set.

| Name | Required? | Purpose |
| --- | --- | --- |
| `NODE_ENV` | yes | `production` in production. It also makes `HOST` default to `0.0.0.0`. |
| `APP_ORIGIN` | yes | The web app's origin: links in emails; mutations from any other Origin are refused. |
| `PUBLIC_BASE_URL` | yes | This API's public URL, no trailing slash: email links and Twilio webhook signature checks. |
| `DATABASE_URL_TENANT` | yes | Postgres URL for `app_tenant` (all request work, under row-level security). |
| `DATABASE_URL_SYSTEM` | yes | Postgres URL for `app_system` (auth, webhook routing, scheduler fan-out, pg-boss). |
| `ENCRYPTION_KEY` | yes | `openssl rand -base64 32`. Encrypts secrets in the database; never change it once data exists. |
| `GOOGLE_CLIENT_ID` | no | Turns on Sign in with Google. |
| `GOOGLE_CLIENT_SECRET` | no | With `GOOGLE_CLIENT_ID`, turns on Google Calendar connections. |
| `MICROSOFT_CLIENT_ID` | no | Both or neither with `MICROSOFT_CLIENT_SECRET`. Turns on Outlook calendar connections. |
| `MICROSOFT_CLIENT_SECRET` | no | Both or neither with `MICROSOFT_CLIENT_ID`. Turns on Outlook calendar connections. |
| `POSTMARK_TOKEN` | no | Sends email through Postmark; unset means email is only logged. |
| `MAIL_FROM` | when `POSTMARK_TOKEN` is set | The verified From address. |
| `TWILIO_AUTH_TOKEN` | no | Twilio master token for webhook signatures (companies without a subaccount token). |
| `TWILIO_ACCOUNT_SID` | no | Twilio account SID (`AC` + 32 hex digits). When set, `TWILIO_AUTH_TOKEN` is required. |
| `TWILIO_PRIMARY_PROFILE_SID` | no | Twilio primary customer profile SID (`BU` + 32 hex digits), for texting registration. |
| `STRIPE_SECRET_KEY` | no | Stripe secret key (`sk_`). Unset: billing is off. |
| `STRIPE_WEBHOOK_SECRET` | when `STRIPE_SECRET_KEY` is set | Stripe webhook signing secret (`whsec_`). |
| `BILLING_PLANS_FILE` | no | The billing plans JSON file. Defaults to `config/billing-plans.example.json` outside production; required in production when `STRIPE_SECRET_KEY` is set. |
| `GEOCODIO_API_KEY` | no | Geocodio key for address lookup. Unset: addresses are not looked up. |
| `EAGLEVIEW_CLIENT_ID` | no | EagleView client id. Both or neither with `EAGLEVIEW_CLIENT_SECRET`. Unset: aerial measurement and exact reports are off. |
| `EAGLEVIEW_CLIENT_SECRET` | no | EagleView client secret. Both or neither with `EAGLEVIEW_CLIENT_ID`. |
| `EAGLEVIEW_ENV` | no (`sandbox`) | `sandbox` or `production`. |
| `EAGLEVIEW_PRODUCT_ID` | no (0) | The EagleView product id to order. 0 is a placeholder: ask before ordering. |
| `R2_ACCOUNT_ID` | no | Cloudflare R2 account id. All four R2 settings or none. Expected in production once any company can sign; without them start-up warns and signed proposals cannot be stored. |
| `R2_ACCESS_KEY_ID` | no | R2 access key id. All four R2 settings or none. |
| `R2_SECRET_ACCESS_KEY` | no | R2 secret access key. All four R2 settings or none. |
| `R2_BUCKET` | no | R2 bucket name. All four R2 settings or none. |
| `PROPOSAL_LINK_BASE_URL` | no (`APP_ORIGIN`) | Base URL of customer proposal links; trailing slashes are removed. |
| `FOOTPRINTS_BASE_URL` | no | Where building footprint files are read from; a trailing slash is added. Defaults to `https://usbuildingdata.blob.core.windows.net/usbuildings-v2/`. |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | no | Google Ads developer token. All five GOOGLE_ADS settings or none; unset means Google ads are off. |
| `GOOGLE_ADS_MANAGER_ID` | no | Google Ads manager account id. All five GOOGLE_ADS settings or none. |
| `GOOGLE_ADS_CLIENT_ID` | no | Google Ads OAuth client id. All five GOOGLE_ADS settings or none. |
| `GOOGLE_ADS_CLIENT_SECRET` | no | Google Ads OAuth client secret. All five GOOGLE_ADS settings or none. |
| `GOOGLE_ADS_REFRESH_TOKEN` | no | Google Ads OAuth refresh token. All five GOOGLE_ADS settings or none. |
| `GOOGLE_ADS_API_VERSION` | no (`v21`) | The Google Ads API version, like `v21`. |
| `META_APP_ID` | no | Meta app id. All four META settings or none; unset means Meta ads are off. |
| `META_APP_SECRET` | no | Meta app secret. All four META settings or none. |
| `META_SYSTEM_USER_TOKEN` | no | Meta system user token. All four META settings or none. |
| `META_BUSINESS_ID` | no | Meta business id that ad accounts are shared with. All four META settings or none. |
| `META_GRAPH_VERSION` | no (`v24.0`) | The Meta Graph API version, like `v24.0`. |
| `POSTMARK_BROADCAST_STREAM` | no (`broadcast`) | The Postmark message stream for storm alert email. |
| `POSTMARK_WEBHOOK_SECRET` | no | Basic-auth password for Postmark's bounce and complaint webhook at `/hooks/postmark` (16+ characters). Unset: the webhook refuses every call. |
| `STORM_MAIL_FROM` | no | Plain From address for storm email, like `storms@roofline.app`. Unset: `storms@` plus the `MAIL_FROM` domain, else `POLICY_PAGES_DOMAIN`, else the `PUBLIC_BASE_URL` host. |
| `HAIL_STALE_MINUTES` | no (90) | Minutes without a fresh hail report before the hail feed counts as stale (1 to 10080). |
| `POLICY_PAGES_DOMAIN` | no | The bare hostname for the policy pages, like `roofline.app`. |
| `FAKE_PROVIDERS` | no | `1` or `true` swaps every outside service for a fake. Development and test only; refused in production. |
| `WEB_DIST_DIR` | no | Where the built web app is: `apps/web/dist` in production (a relative path is read from the repository root). When set, the API also serves the app, so one origin answers both; it must contain `index.html` or start-up stops. Leave unset in development, where Vite serves the app. |
| `TRUST_PROXY` | no (0) | How many proxy hops to trust for the client address. |
| `API_RATE_LIMIT_PER_MIN` | no (600) | Requests per minute per session on `/api/*`. |
| `PORT` | no (4400) | Listen port (Render sets it). |
| `HOST` | no | Listen address: `0.0.0.0` in production, `127.0.0.1` otherwise, unless set. |
| `DATABASE_URL_OWNER` | migrations only | The migration owner. Only the migrate and role-password steps use it; never the API or worker. |
| `TENANT_DB_PASSWORD`, `SYSTEM_DB_PASSWORD` | role passwords only | Set on `app_tenant` and `app_system`; must match the two app URLs. |

- **Boot order:**
  0. Build the web app once per deploy: `npm run build:web` writes `apps/web/dist` (Vite is a dev dependency, so run it before `npm ci --omit=dev`, or in the host's build step) and set `WEB_DIST_DIR=apps/web/dist`. `APP_ORIGIN` is then the API's own public URL.
  1. `npm ci --omit=dev` (`tsx`, which runs the TypeScript, is a runtime dependency of the API, the worker and `@roofline/db`).
  2. `DATABASE_URL_OWNER=… npm run db:migrate`, as the owner, before each new version starts.
  2a. `DATABASE_URL_OWNER=… npm run db:preflight`, as the owner, right after the migrate: it prints each problem it finds (an extension outside `public`, a grant the Supabase Data API roles still hold, an app role that is a superuser or bypasses row-level security, a tenant table without forced row-level security) and exits 1, or prints `Preflight passed.`
  3. `DATABASE_URL_OWNER=… TENANT_DB_PASSWORD=… SYSTEM_DB_PASSWORD=… npm run set-role-passwords -w @roofline/db`, once for a new database (again only to change the passwords).
  4. Start the API: `npm start -w @roofline/api` (`/health` answers once it listens).
  5. Start the worker: `npm start -w @roofline/worker`. Without it, approved steps wait in the queue.
- **Database host:**
  - The migration owner needs `CREATEROLE` (it creates `app_tenant` and `app_system`) and `CREATE` on the database; owning the database is simplest (on Supabase, the `postgres` role owns the `postgres` database). It doesn't need to be a superuser: neither app role bypasses row-level security.
  - The `postgis` and `citext` extensions must be enabled on the host, in the `public` schema. The first migration runs `CREATE EXTENSION IF NOT EXISTS` for both, which works where the owner may create them (Supabase's `postgres` role may); otherwise enable them first (Supabase: dashboard → Database → Extensions).
  - **Pick `public`, not an `extensions` schema** (the Supabase dashboard offers one): the app roles' `search_path` is `"$user", public`, so with `citext` in `extensions` their email lookups silently turn case-sensitive (checked on Supabase's Postgres 17 image). `db:migrate` moves a `citext` it finds in another schema into `public`. It stops with a plain message when `postgis` is in another schema, because that one can't be moved: drop it there and let the migration install it, or enable it for `public` in the host's settings.
  - **Supabase's Data API roles:** Supabase grants `anon` and `authenticated` access to new `public` tables by default, which would expose `users` (with `password_hash`) and `sessions` over its REST API. Every `db:migrate` revokes all their grants on `public` and `pgboss` (on `pgboss` only where the owner may: a table pg-boss made as `app_system` can't be revoked on by a plain `CREATEROLE` owner, so that one is skipped), their use of the `public` schema, and the default privileges that hand them new tables, so tables a later migration adds are covered too. `db:preflight` (step 2a) fails if any grant is left, `pgboss` included.
- **Billing and texting setup (F3):**
  - **Plans:** run `npm run sync:stripe-plans -w @roofline/api` before the first deploy and again after every price change. It creates the meters, products and prices from `BILLING_PLANS_FILE`.
  - **Stripe webhook:** add the endpoint `<PUBLIC_BASE_URL>/hooks/stripe` with exactly these five events: `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`. Its signing secret is `STRIPE_WEBHOOK_SECRET`; without it the endpoint answers 503 and Stripe retries.
  - **Twilio registration callback:** point Twilio's registration status callback at `<PUBLIC_BASE_URL>/hooks/twilio-registration`. A daily poll also checks the carriers.
  - **Hosted policy pages:** set `POLICY_PAGES_DOMAIN` (like `roofline.app`) and add wildcard DNS `*.<POLICY_PAGES_DOMAIN>` pointing at the API service, so each company's `https://<company-slug>.<POLICY_PAGES_DOMAIN>/privacy` and `/terms` resolve.
- **Owner to-dos before texting goes live:**
  - Keep Twilio Advanced Opt-Out on, with its default keywords.
  - Have the lawyer review the policy templates and the consent sentence.
  - Set the real `BILLING_PLANS_FILE` (required in production when `STRIPE_SECRET_KEY` is set).
  - Set `TWILIO_PRIMARY_PROFILE_SID` (the primary customer profile, `BU` + 32 hex digits).
  - Run the by-hand checks in [`docs/superpowers/f3-manual-smoke.md`](docs/superpowers/f3-manual-smoke.md).
