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
| `POSTMARK_TOKEN` | no | Sends email through Postmark; unset means email is only logged. |
| `MAIL_FROM` | when `POSTMARK_TOKEN` is set | The verified From address. |
| `TWILIO_AUTH_TOKEN` | no | Twilio master token for webhook signatures (companies without a subaccount token). |
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
  3. `DATABASE_URL_OWNER=… TENANT_DB_PASSWORD=… SYSTEM_DB_PASSWORD=… npm run set-role-passwords -w @roofline/db`, once for a new database (again only to change the passwords).
  4. Start the API: `npm start -w @roofline/api` (`/health` answers once it listens).
  5. Start the worker: `npm start -w @roofline/worker`. Without it, approved steps wait in the queue.
- **Database host:**
  - The migration owner needs `CREATEROLE` (it creates `app_tenant` and `app_system`) and `CREATE` on the database; owning the database is simplest (on Supabase, the `postgres` role owns the `postgres` database). It doesn't need to be a superuser: neither app role bypasses row-level security.
  - The `postgis` and `citext` extensions must be enabled on the host, in the `public` schema. The first migration runs `CREATE EXTENSION IF NOT EXISTS` for both, which works where the owner may create them (Supabase's `postgres` role may); otherwise enable them first (Supabase: dashboard → Database → Extensions).
  - **Pick `public`, not an `extensions` schema** (the Supabase dashboard offers one): the app roles' `search_path` is `"$user", public`, so with `citext` in `extensions` their email lookups silently turn case-sensitive (checked on Supabase's Postgres 17 image).
