# Roofline
- **What is where:** `v1/` is the original single-company estimator (React + Express + SQLite); `packages/` (`shared`, `db`, `send-gate`) and `apps/` (`api`, `worker`) are the multi-company platform as npm workspaces that export TypeScript source (no build step); specs and plans live in `docs/superpowers/`.
- **Run v1:** `cd v1 && npm install && npm start`, then open http://127.0.0.1:4311 (v1 keeps its own `package.json`, `.env` and `data/`; see `v1/README.md`).
- **Run the platform tests:** `npm install`, then `npm test` (Vitest); `npm run typecheck` and `npm run lint` are the other checks, and `npm run db:up` starts the local PostGIS database (needs Docker).
- **Run v1's tests:** `cd v1 && npm test` (node:test) and `npm run test:e2e` (Playwright).

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
| `TRUST_PROXY` | no (0) | How many proxy hops to trust for the client address. |
| `API_RATE_LIMIT_PER_MIN` | no (600) | Requests per minute per session on `/api/*`. |
| `PORT` | no (4400) | Listen port (Render sets it). |
| `HOST` | no | Listen address: `0.0.0.0` in production, `127.0.0.1` otherwise, unless set. |
| `DATABASE_URL_OWNER` | migrations only | The migration owner. Only the migrate and role-password steps use it; never the API or worker. |
| `TENANT_DB_PASSWORD`, `SYSTEM_DB_PASSWORD` | role passwords only | Set on `app_tenant` and `app_system`; must match the two app URLs. |

- **Boot order:**
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
