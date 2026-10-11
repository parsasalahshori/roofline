# Roofline F1 — Platform Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the multi-company API foundation that every Roofline feature plugs into:

- tenancy enforced twice (app layer + Postgres RLS)
- accounts, logins and roles
- customer, property and job records
- the approval queue (draft → approve → run → results)
- the send gate that decides every outbound text

**Architecture:**

- **Monorepo:** npm workspaces. The v1 app is moved to `v1/` untouched.
- **API:** Express 5 in `apps/api`. A pg-boss worker runs in `apps/worker`.
- **Shared packages:**
  - `packages/shared`: zod schemas, enums, the pricing engine ported from v1, step-type registry
  - `packages/db`: Drizzle schema, migrations, `withTenant`, repositories, `system/` functions, test harness
  - `packages/send-gate`: pure `decide()`, inbound keyword classifier, SMS adapter interface
- **Database:** Postgres 16 + PostGIS with three database roles:
  - **owner:** runs migrations
  - **`app_tenant`:** RLS-enforced, used for all request work
  - **`app_system`:** narrow; used for auth, webhook routing and scheduler fan-out

**Tech Stack:** Node 22, TypeScript (strict), Express 5, zod 4, Drizzle ORM + drizzle-kit, `pg`, pg-boss, luxon, libphonenumber-js, `twilio` (signature validation only), `jose` (Google ID tokens), express-rate-limit, Vitest, supertest, Testcontainers (`@testcontainers/postgresql`), tsx.

**Spec:**

- `docs/superpowers/specs/2026-10-10-roofline-foundation-design.md`: §2 repo layout, §3 F1, §6 errors, §7 testing
- Context: `docs/superpowers/specs/2026-10-10-roofline-saas-design.md`

## Global Constraints

**Runtime and repo**
- **Node:** `>=22.13.0`; `.nvmrc` = `22`. TypeScript `strict: true` in `tsconfig.base.json`; ESM everywhere (`"type": "module"`).
- **Workspace packages** export TypeScript source directly (`"exports": {".": "./src/index.ts"}`), so there is no build step. Run with `tsx`; test with Vitest.
- **Package names:** `@roofline/shared`, `@roofline/db`, `@roofline/send-gate`, `@roofline/api`, `@roofline/worker`.

**Database**
- **Every tenant table** has `company_id uuid not null`.
- **Global tables:** `users`, `sessions`, `memberships`, `invites`, `companies`, `company_phone_numbers`, `texting_registrations`, `webhook_events`, `user_tokens`.
- **RLS policy expression (exact):** `company_id = nullif(current_setting('app.company_id', true), '')::uuid`, as both `USING` and `WITH CHECK`.
- **Per-request transaction:** `select set_config('app.company_id', $1, true)`, the transaction-local equivalent of `SET LOCAL`.
- **`app_tenant`** is not the table owner, has no `BYPASSRLS`, and has no UPDATE/DELETE on `audit_log`.
- **`@roofline/db/system`** may be imported only from `apps/api/src/auth/**`, `apps/api/src/hooks/**`, `apps/api/src/jobs/scheduler/**` and `apps/worker/**`. ESLint `no-restricted-imports` enforces this.

**Errors and HTTP**
- **API error body:** `{ "error": "<plain English>", "field"?: "<name>" }`. Never a stack trace or code.
- **Cross-tenant ID → 404** (never 403).
- **Session cookie:** `rl_session`, httpOnly, `Secure` when `NODE_ENV=production`, `SameSite=Lax`.
  - 30-day sliding expiry: extend `expires_at` to now + 30 days when `last_seen_at` is older than 1 hour.
  - The stored token is sha256 of a 32-byte random base64url value.
- **Rate limits:**
  - `POST /api/auth/login`: 10 per 15 minutes, keyed by IP + lowercased email
  - `/api/*`: 600 per minute per session
  - `/hooks/*`: exempt
- **Mutations** with an `Origin` header other than `APP_ORIGIN` → 403 `"This request came from another site and was blocked."`
- **JSON body limit:** 256 KB. `express.urlencoded` is used only on `/hooks/twilio/*`.

**Accounts**
- **Passwords:** scrypt, minimum 10 characters.
- **Email** is stored lowercased and trimmed (`citext` column).

**Enums (exact values)**

| Enum | Values |
|---|---|
| Roles | `owner \| office \| rep` |
| Consent | `none \| express \| attested \| written \| revoked` |
| Job stages | `lead \| inspection \| proposal \| won \| installed \| lost` |
| Job sources | `storm \| call \| text \| web \| referral \| import \| manual` |
| Customer sources | `import \| manual \| call \| text \| web \| storm` |
| Company status | `trial \| trial_ended \| active \| past_due \| canceled` |
| Campaign status | `none \| pending \| approved \| rejected` |
| Agents | `storm_scout \| estimator \| front_desk \| claims \| scheduler \| follow_up \| system` |
| Task status | `draft \| awaiting_owner \| approved \| declined \| expired \| running \| done \| partly_done \| needs_attention` |
| Step status | `pending \| awaiting_owner \| skipped \| queued \| running \| done \| failed \| needs_attention` |
| Approval class | `message \| spend \| internal` |
| Message status | `scheduled \| queued \| sent \| delivered \| failed \| blocked \| received` |
| Gate rules, in order | `billing, registration, contact, consent, content, dedupe, frequency, quiet_hours` |

**Settings and limits**
- **`marketing_cap_per_7d`:** default 2, allowed 0–2.
- **Quiet hours:** 08:00–21:00 recipient-local; FL, OK, MD use 08:00–20:00.
- **FL/OK/MD frequency:** at most 3 marketing messages per rolling 24 hours.
- **Informational reply exception:** a reply within 15 minutes of the customer's own inbound call or text is exempt from quiet hours.

## Review Focus

Things a real user will hit that the spec's own acceptance tests don't exercise. Each one has a pinned test in the task named.

1. **An inbound text that merely contains "stop".** "Can you stop by Thursday?" must **not** opt out. "STOP.", " Stop " and "stop texting me" **must**. *(Task 16)*
2. **Phone numbers in everyday formats.** `(402) 555-0144`, `402.555.0144` and `+1 402 555 0144` all become `+14025550144`. `555-0144` is rejected with a field error. Two customers can't be created with the same number written differently. *(Task 10)*
3. **Email case and whitespace on sign-up and login.** `" Owner@Example.COM "` logs into the account created as `owner@example.com`, and a second sign-up with that variant is refused. *(Task 6)*
4. **Double-clicking Approve, or two users approving at once.** Exactly one approval is recorded and each step is enqueued once. The second request gets 409. *(Task 13)*
5. **A recipient with no property time zone or state.** Quiet hours fall back to the company time zone and the standard 21:00 end. On a DST-change day the window is still 08:00–21:00 local. *(Task 15)*

---

## File structure

```
roofline/
  package.json                 # workspaces: apps/*, packages/*; scripts: lint, typecheck, test, db:*
  tsconfig.base.json  .nvmrc  eslint.config.js  vitest.config.ts  docker-compose.yml
  .github/workflows/ci.yml
  v1/                          # entire v1 app moved here (git mv), runs with its own package.json
  packages/shared/src/
    index.ts  enums.ts  phone.ts  pricing.ts  steps.ts
  packages/shared/test/        pricing.test.ts  phone.test.ts  steps.test.ts
  packages/db/
    drizzle.config.ts
    migrations/                # drizzle-kit output + 0001_roles_rls.sql (custom)
    src/
      index.ts  pools.ts  tenant.ts  crypto.ts
      schema/global.ts  schema/tenant.ts
      repos/customers.ts  properties.ts  jobs.ts  activities.ts  audit.ts  tasks.ts  messages.ts  companies.ts
      system/index.ts  auth.ts  routing.ts  scheduler.ts
      testing/index.ts  global-setup.ts  seed.ts  reset.ts
    test/                      rls.test.ts  migrations.test.ts
  packages/send-gate/src/      index.ts  decide.ts  quiet-hours.ts  inbound.ts  render.ts  adapter.ts
  packages/send-gate/test/     decide.test.ts  quiet-hours.test.ts  inbound.test.ts
  apps/api/src/
    app.ts  server.ts  config.ts  errors.ts  validate.ts  permissions.ts  mailer.ts  clock.ts
    auth/ routes.ts  password.ts  sessions.ts  google.ts  tokens.ts  middleware.ts  team-store.ts
    routes/ company.ts  team.ts  customers.ts  properties.ts  jobs.ts  activities.ts  approvals.ts  tasks.ts
    tasks/ service.ts  runner.ts  handlers.ts  queue.ts
    messaging/ send-batch.ts  gate-request.ts  dispatcher.ts
    hooks/ twilio.ts
    jobs/scheduler/ expire-drafts.ts  dispatch-messages.ts  sweep-queued.ts
    scripts/ seed-demo.ts
  apps/api/test/               helpers.ts + one *.test.ts per task below
  apps/worker/src/index.ts
```

---

## Group A — Repo, database, tenancy

### Task 1: Move v1 into `v1/` and create the workspace skeleton

**Files:**
- Move with `git mv`: `client/ server/ shared/ tests/ cli/ scripts/ examples/ index.html vite.config.ts tsconfig.json playwright.config.ts package.json package-lock.json Dockerfile .dockerignore .env.example README.md "Start Roofline.command"` → `v1/`. Also move `docs/{API,CLI,CONNECTORS,DEPLOYMENT,DESIGN,PLAN,RESEARCH,VERIFICATION,WORKSPACE-GUIDE}.md` → `v1/docs/`.
- Move untracked files with plain `mv`: `.env` → `v1/.env`, `data/` → `v1/data/`, `node_modules/` → `v1/node_modules/`.
- Modify `.gitignore`:
  - replace `data/*` and `!data/.gitkeep` with `v1/data/*` and `!v1/data/.gitkeep`
  - replace `cli/roof/target/` (both lines) with `v1/cli/roof/target/`
  - keep `node_modules/`, `.env`, `.superpowers/`
- Create:
  - root `package.json`, `tsconfig.base.json`, `.nvmrc`, `eslint.config.js`, `vitest.config.ts`, `docker-compose.yml`
  - for each of the 5 workspaces: `package.json`, `tsconfig.json`, `src/index.ts`
  - a new root `README.md` (5 lines: what is where, how to run v1, how to run tests)

**Interfaces:**
- Produces:
  - root scripts `lint`, `typecheck` (`tsc -b` over workspaces), `test` (`vitest run`), `db:up` (`docker compose up -d db`), `db:migrate`, `db:generate`
  - `docker-compose.yml` service `db`: image `postgis/postgis:16-3.4`, port `54329:5432`, user/password/db `roofline/roofline/roofline`

- [ ] **Step 1: Do the moves, then verify v1 still works from its new home**

Run: `cd v1 && npm test`
Expected: v1's node:test suite passes (same count as before the move).

- [ ] **Step 2: Verify v1 starts**

Run: `cd v1 && npm start`, then in another shell `curl -s http://127.0.0.1:4311/api/health`
Expected: JSON containing `"service":"roofline"`. Then stop the server.

- [ ] **Step 3: Create the workspace skeleton and install**

Dependencies: TypeScript, Vitest, ESLint + typescript-eslint and tsx as root devDependencies. Each workspace's `src/index.ts` exports nothing yet (`export {}`).

Run: `npm install && npm run typecheck && npm run lint && npx vitest run --passWithNoTests`
Expected: all exit 0.

- [ ] **Step 4: Verify the database container**

Run: `npm run db:up && docker compose exec db psql -U roofline -c 'select postgis_version()'`
Expected: a PostGIS version row.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: move v1 to v1/ and add workspace skeleton"
```

---

### Task 2: Port the pricing engine and add enums and phone normalization to `@roofline/shared`

**Files:**
- Create:
  - `packages/shared/src/pricing.ts`: copy of `v1/shared/pricing.ts`, unchanged except import paths
  - `packages/shared/src/enums.ts`
  - `packages/shared/src/phone.ts`
- Modify: `packages/shared/src/index.ts` (re-export all three)
- Test:
  - `packages/shared/test/pricing.test.ts`: every assertion from `v1/tests/pricing.test.ts`, same inputs and expected values, rewritten from `node:test`/`assert` to Vitest `test`/`expect`
  - `packages/shared/test/phone.test.ts`

**Interfaces:**
- Produces:
  - Everything `v1/shared/pricing.ts` exports, with identical names and signatures: `calculateQuote`, `toSurfaceArea`, `defaultPricebook`, `defaultScope`, `pricebookSchema`, `scopeSchema`, `materialNames`, `money`, `Pricebook`, `Scope`, `QuoteLine`, `Calculation`.
  - `enums.ts`: `as const` arrays and their union types for every enum in Global Constraints: `ROLES`/`Role`, `CONSENT_STATUSES`/`ConsentStatus`, `JOB_STAGES`/`JobStage`, `JOB_SOURCES`/`JobSource`, `CUSTOMER_SOURCES`/`CustomerSource`, `COMPANY_STATUSES`/`CompanyStatus`, `CAMPAIGN_STATUSES`/`CampaignStatus`, `AGENTS`/`Agent`, `TASK_STATUSES`/`TaskStatus`, `STEP_STATUSES`/`StepStatus`, `APPROVAL_CLASSES`/`ApprovalClass`, `MESSAGE_STATUSES`/`MessageStatus`, `GATE_RULES`/`GateRule`.
  - `phone.ts`: `toE164(input: string): string | null`. Uses libphonenumber-js with default country `US`; returns null unless `isValid()`.

- [ ] **Step 1: Write the failing tests**

`pricing.test.ts` contains the 5 v1 test cases ported 1:1:
- `surface measurements are not pitched twice`
- `orders complete bundles and calculates labor on actual area`
- `tax applies to marked-up materials only, money reconciles`
- `invalid areas and dangerous pricing values fail closed`
- `additional layers, slope and height increase the correct labor costs`

`phone.test.ts` (Review Focus #2):

```ts
test.each(['(402) 555-0144', '402.555.0144', '+1 402 555 0144', '4025550144'])('%s → +14025550144', (s) => {
  expect(toE164(s)).toBe('+14025550144');
});
test.each(['555-0144', '', 'call me', '+1 000 000 0000'])('%s → null', (s) => expect(toE164(s)).toBeNull());
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run packages/shared`
Expected: FAIL (modules not found).

- [ ] **Step 3: Copy `pricing.ts`, then implement `enums.ts` and `toE164`**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/shared`
Expected: all pass. The pricing assertion count matches the v1 file.

- [ ] **Step 5: Commit**

```bash
git add packages/shared && git commit -m "feat(shared): port pricing engine, add enums and phone normalization"
```

---

### Task 3: Database schema, migrations and the test harness

**Files:**
- Create:
  - `packages/db/drizzle.config.ts`
  - `packages/db/src/schema/global.ts`, `packages/db/src/schema/tenant.ts`
  - `packages/db/migrations/*` (generated)
  - `packages/db/src/testing/global-setup.ts`, `reset.ts`, `seed.ts`, `index.ts`
- Test: `packages/db/test/migrations.test.ts`

**Interfaces:**
- Produces:
  - **Drizzle tables.** Columns are exactly as spec §3.3 and §3.5, plus these additions:
    - `users.email_verified_at` (nullable)
    - `properties.address_key text`, unique with `company_id`; normalized as lowercase `address_line + '|' + zip` with punctuation removed and whitespace collapsed
    - `messages.to_e164`
    - `agent_task_steps.attempts int default 0`
    - partial unique index on `messages (step_id, customer_id) where step_id is not null`
    - `texting_registrations.subaccount_auth_token_encrypted bytea` (nullable)
    - global table `user_tokens(id, user_id, kind 'verify_email'|'reset_password', token_hash, expires_at, used_at)`
  - **PostGIS types:** points use drizzle `geometry({type:'point', srid:4326})`; `companies.service_area` uses a `customType` emitting `geometry(MultiPolygon,4326)`.
  - **Migration runner:** `migrate(ownerUrl: string): Promise<void>` runs drizzle migrations, including the custom SQL from Task 4.
  - **Test harness (`@roofline/db/testing`):**
    - Vitest `globalSetup` starts one `postgis/postgis:16-3.4` Testcontainer, runs `migrate`, and calls `provide('dbUrls', {owner})`. Task 4 adds `tenant` and `system` once the roles exist.
    - `resetDb(ownerUrl): Promise<void>` truncates every table (`RESTART IDENTITY CASCADE`).
    - `seedTwoCompanies(ownerUrl): Promise<{a: SeededCompany; b: SeededCompany}>`, where:
      - `SeededCompany = {companyId; slug; owner: SeedUser; office: SeedUser; rep: SeedUser; otherRep: SeedUser}`
      - `SeedUser = {userId; email; password: 'correct-horse-battery'}`
      - each company also gets: `company_settings` with defaults, timezone `America/Chicago`, state `NE`, and `texting_registrations.campaign_status='approved'`

- [ ] **Step 1: Write the failing test**

```ts
test('every tenant table has a non-null company_id', async () => {
  const rows = await ownerQuery(`select table_name from information_schema.columns
    where table_schema='public' and column_name='company_id' and is_nullable='NO'`);
  expect(rows.map(r => r.table_name)).toEqual(expect.arrayContaining([...TENANT_TABLES]));
});
test('seed creates two companies with four members each', async () => {
  const s = await seedTwoCompanies(urls.owner);
  expect(await count('memberships', s.a.companyId)).toBe(4);
});
```

`TENANT_TABLES` is exported from `schema/tenant.ts`:

```ts
['company_settings', 'customers', 'properties', 'jobs', 'activities', 'audit_log', 'integrations',
 'usage_events', 'agent_tasks', 'agent_task_steps', 'messages', 'opt_outs']
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/db/test/migrations.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write both schema files and generate the migration**

Run: `npm run db:generate`

- [ ] **Step 4: Implement the harness and seed, then run the test**

Run: `npx vitest run packages/db/test/migrations.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db && git commit -m "feat(db): schema, migrations and testcontainers harness"
```

---

### Task 4: Database roles, RLS, `withTenant`, system pool

**Files:**
- Create:
  - `packages/db/migrations/0001_roles_rls.sql` (custom migration via `drizzle-kit generate --custom`)
  - `packages/db/src/pools.ts`, `packages/db/src/tenant.ts`
  - `packages/db/src/system/index.ts` (empty barrel for now)
  - `packages/db/scripts/set-role-passwords.ts`
- Modify: `packages/db/src/testing/global-setup.ts` (set role passwords and provide tenant/system URLs)
- Test: `packages/db/test/rls.test.ts`

**Interfaces:**
- Produces:
  - **The SQL migration:**
    - Creates roles `app_tenant` and `app_system` (LOGIN, idempotent `DO` block).
    - `app_tenant` gets SELECT/INSERT/UPDATE on tenant tables, except `audit_log`, which gets INSERT/SELECT only.
    - Enables and **forces** RLS on every `TENANT_TABLES` entry, with policy `tenant_isolation` using the exact Global Constraints expression for USING and WITH CHECK.
    - Creates view `company_members` (`membership id, user_id, name, email, role, status`), filtered by the same setting, granted to `app_tenant`.
    - **Company-scoped global tables are readable by `app_tenant` for its own company only**, with RLS enabled and forced:
      - `companies`: policy `company_self` on `id` using the same expression; SELECT, plus column-level UPDATE on profile columns only (`name, legal_name, phone_e164, email, website, address columns, timezone, service_area, logo_url`). Never on `status`, `plan_key`, `stripe_customer_id` or `trial_ends_at`.
      - `company_phone_numbers`, `texting_registrations`: SELECT only, policy on `company_id`.
      - All writes to these tables go through `app_system`.
    - `app_system` gets:
      - `NOBYPASSRLS` (final-review fix I2: only a superuser may grant the bypass, and Supabase has none) and, on every RLS table it has a grant on, a permissive policy `app_system_all … FOR ALL TO app_system USING (true) WITH CHECK (true)`
      - ALL on global tables
      - column-level SELECT only on `agent_tasks(id, company_id, status, expires_at)`, `agent_task_steps(id, task_id, company_id, status, updated_at)` and `messages(id, company_id, status, scheduled_for)`
      - ownership of schema `pgboss`
  - **Pools:** `createPools(urls: {tenant: string; system: string}): Pools`, where `Pools = {tenant: NodePgDatabase; system: NodePgDatabase; end(): Promise<void>}`.
  - **`withTenant<T>(pools: Pools, ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T>`:** opens a transaction on `pools.tenant`, runs `select set_config('app.company_id', ctx.companyId, true)`, then `fn`.
    - `TenantContext = {companyId: string; userId: string | null; role: Role | 'system'; canApproveSpend: boolean}`
    - `Tx` is the Drizzle transaction type.

- [ ] **Step 1: Write the failing tests**

```ts
test('tenant role sees zero rows when the company setting is absent', async () => {
  expect(await tenantRaw(`select count(*)::int n from customers`)).toEqual([{ n: 0 }]);
});
test('tenant role sees zero rows when the setting is empty', ...);       // set_config('app.company_id','',true)
test('tenant role sees only its own company', ...);                      // seed 1 customer in a, 1 in b; withTenant(a) → 1 row, id = a's
test('insert with another company_id is rejected', ...);                 // withTenant(a) insert company_id=b → throws /row-level security/
test('tenant role cannot update or delete audit_log', ...);              // → throws /permission denied/
test('system role can read only whitelisted columns of agent_tasks', ...); // select title → /permission denied/
test('tenant role reads its own companies row only and cannot change status', ...); // other company → 0 rows; update status → /permission denied/
test('tenant role can read its texting_registrations row but not write it', ...);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run packages/db/test/rls.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the SQL migration, `pools.ts`, `tenant.ts`, and the password script**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/db`
Expected: PASS (Task 3's tests too).

- [ ] **Step 5: Commit**

```bash
git add packages/db && git commit -m "feat(db): app_tenant/app_system roles, forced RLS, withTenant"
```

---

## Group B — API skeleton, accounts, sessions

### Task 5: API app skeleton

**Files:**
- Create: `apps/api/src/app.ts`, `server.ts`, `config.ts`, `errors.ts`, `validate.ts`, `clock.ts`, `mailer.ts`
- Test: `apps/api/test/helpers.ts`, `apps/api/test/app.test.ts`

**Interfaces:**
- Produces:
  - **`createApp(deps: AppDeps): Express`**
    - In this task, `AppDeps = {pools: Pools; config: Config; mailer: Mailer; clock: Clock}`.
    - Later tasks add one field each: `google: GoogleVerifier` (Task 8), `queue: StepQueue` (Task 13), `sms: SmsAdapter` (Task 17). `makeTestApp` gains the matching fake at the same time.
  - **`Config`** (zod-parsed env):
    - required: `NODE_ENV`, `APP_ORIGIN`, `DATABASE_URL_TENANT`, `DATABASE_URL_SYSTEM`, `ENCRYPTION_KEY` (base64, 32 bytes), `PUBLIC_BASE_URL`
    - optional: `GOOGLE_CLIENT_ID`, `POSTMARK_TOKEN`, `TWILIO_AUTH_TOKEN`, `TRUST_PROXY` (int, default 0), `API_RATE_LIMIT_PER_MIN` (int, default 600; tests set 5)
  - **`class AppError extends Error {constructor(status: number, message: string, field?: string)}`.** The error middleware maps:
    - `AppError` → `{error, field}`
    - `ZodError` → 400 with the first issue's path as `field` and a plain message
    - anything else → 500 `"Something went wrong on our side. Please try again."`
  - **`parse<T>(schema: ZodType<T>, value: unknown): T`** (throws AppError 400).
  - **`Clock = {now(): Date}`.** `TestClock` (in helpers) has `set(d: Date)` and `advance(ms)`.
  - **`Mailer = {send(msg: {to: string; subject: string; text: string}): Promise<void>}`.** `PostmarkMailer` is the real one. `FakeMailer.sent` is an array (in helpers).
  - **Test helpers:**
    - `makeTestApp(overrides?: Partial<Config>): Promise<{app; deps; clock: TestClock; mailer: FakeMailer; seed: {a: SeededCompany; b: SeededCompany}}>` resets and seeds the DB. Tasks 8, 13 and 17 add `google`, `queue` and `sms` to the returned object.
    - `loginAs(app, user: SeedUser): Promise<SuperAgent>` returns a supertest agent carrying the session cookie.

- [ ] **Step 1: Write the failing tests**

- `GET /health` → 200 `{ok: true}`.
- `GET /api/nope` → 404 `{error: "We couldn't find that."}`.
- `POST /api/anything` with `Origin: https://evil.example` → 403 with the exact Global Constraints message.
- A thrown plain `Error` → 500 with the generic message, and the body contains no `stack`.
- A 300 KB JSON body → 413 `{error: "That request was too large."}`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run apps/api/test/app.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run apps/api/test/app.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api && git commit -m "feat(api): app skeleton, config, plain-English errors"
```

---

### Task 6: Password sign-up, login, sessions

**Files:**
- Create:
  - `apps/api/src/auth/password.ts`, `sessions.ts`, `middleware.ts`, `routes.ts`
  - `packages/db/src/system/auth.ts`
  - `packages/db/src/repos/companies.ts`
- Test: `apps/api/test/auth-password.test.ts`

**Interfaces:**
- Consumes: `withTenant`, `Pools` (Task 4); `AppError`, `parse` (Task 5).
- Produces:
  - **Password hashing:** `hashPassword(pw: string): Promise<string>` produces `scrypt$16384$8$1$<salt b64>$<hash b64>`; `verifyPassword(pw, stored): Promise<boolean>` uses `timingSafeEqual`.
  - **Sessions:**
    - `createSession(system, {userId, companyId, ua, ip}): Promise<{token: string}>`
    - `resolveSession(system, token, now): Promise<SessionInfo | null>` performs the sliding extension
    - `SessionInfo = {sessionId; userId; companyId; role: Role; canApproveSpend: boolean; emailVerified: boolean}`. Null when the membership isn't `active`.
  - **Middleware:** `requireSession` sets `req.ctx: TenantContext` and `req.session: SessionInfo`; otherwise 401 `"Please sign in."`.
  - **Routes:**
    - `POST /api/auth/signup {email, password, name, companyName}` → 201 `{user, company}` and sets the cookie. It creates the user, the company (slug from name: lowercase-hyphenated, suffix `-2`, `-3`, … on collision, status `trial`, `trial_ends_at` = now + 14 days), an owner membership and `company_settings` defaults.
    - `POST /api/auth/login {email, password}` → 200 with the cookie, or 401 `"That email and password don't match."`
    - `POST /api/auth/logout` deletes the session.
    - `GET /api/auth/me` → `{user: {id, email, name, emailVerified}, company: {id, name, slug, status}, role, companies: [{id, name}]}`.
    - `GET /api/auth/sessions` lists this user's sessions (`current: true` on this one).
    - `DELETE /api/auth/sessions/:id` signs out that device (own sessions only, else 404).

- [ ] **Step 1: Write the failing tests**

- **Sign-up:** creates a trial company with slug `acme-roofing` from "Acme Roofing", and a second "Acme Roofing" gets `acme-roofing-2`.
- **Email case (Review Focus #3):**
  - sign up as `owner@example.com`, then log in with `" Owner@Example.COM "` → 200
  - sign up again with that variant → 409 `{error: "An account with that email already exists.", field: "email"}`
- **Short password:** `password: "short"` → 400, field `password`.
- **Wrong password:** → 401 with the exact message.
- **Login rate limit:** 11th failed attempt in 15 minutes for the same IP + email → 429 `{error: "Too many sign-in attempts. Try again in a few minutes."}`.
- **API rate limit:** with `API_RATE_LIMIT_PER_MIN: 5`, the 6th `GET /api/auth/me` in a minute on one session → 429 `{error: "You're going a little fast. Try again in a minute."}`. `GET /health` is never limited.
- **Sliding expiry:** `clock.advance(29 days)` with a request each day → still signed in. `clock.advance(31 days)` with no request → 401.
- **Disabled membership:** set `memberships.status='disabled'` → the next request returns 401.
- **Device sign-out:** `DELETE /api/auth/sessions/:otherId` signs out the other device, and its next request returns 401.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run apps/api/test/auth-password.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run apps/api/test/auth-password.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api packages/db && git commit -m "feat(auth): password sign-up, login, sliding sessions"
```

---

### Task 7: Email verification and password reset

**Files:**
- Create: `apps/api/src/auth/tokens.ts`
- Modify: `apps/api/src/auth/routes.ts`, `packages/db/src/system/auth.ts`
- Test: `apps/api/test/auth-email.test.ts`

**Interfaces:**
- Consumes: `Mailer` (Task 5), `createSession` (Task 6).
- Produces:
  - **Tokens:** `issueToken(system, userId, kind, ttlMs): Promise<string>` (stores the sha256 hash) and `consumeToken(system, token, kind, now): Promise<string /*userId*/ | null>` (single use).
  - **Verification:** sign-up sends a verification email (subject `"Confirm your email for Roofline"`, link `${APP_ORIGIN}/verify?token=…`, valid 7 days). `POST /api/auth/verify-email {token}` sets `email_verified_at`.
  - **Reset:**
    - `POST /api/auth/reset-request {email}` always returns 200 (no account enumeration) and emails a reset link valid for 1 hour.
    - `POST /api/auth/reset {token, password}` sets the password and deletes all of the user's sessions.
  - **Middleware:** `requireVerifiedEmail` returns 403 `"Please confirm your email first. We sent you a link."`

- [ ] **Step 1: Write the failing tests**

- Sign-up queues exactly one email to the new address, and its link token verifies.
- Using the token a second time → 400 `"That link has already been used or has expired."`
- `reset-request` for an unknown email → 200 and no email sent.
- Reset with a valid token → the old password fails, the new one works, and the other session gets 401.
- A reset token older than 1 hour is rejected.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run apps/api/test/auth-email.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run apps/api/test/auth-email.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api packages/db && git commit -m "feat(auth): email verification and password reset"
```

---

### Task 8: Sign in with Google and account linking

**Files:**
- Create: `apps/api/src/auth/google.ts`
- Modify: `apps/api/src/auth/routes.ts`
- Test: `apps/api/test/auth-google.test.ts`

**Interfaces:**
- Produces:
  - **`GoogleVerifier = {verify(credential: string): Promise<{sub: string; email: string; emailVerified: boolean; name: string}>}`.**
    - The real implementation (`JoseGoogleVerifier`) checks the Google JWKS via `jose` `createRemoteJWKSet('https://www.googleapis.com/oauth2/v3/certs')`, `aud = GOOGLE_CLIENT_ID`, and `iss ∈ {accounts.google.com, https://accounts.google.com}`.
    - `FakeGoogleVerifier` maps test credential strings to claims.
  - **`POST /api/auth/google {credential, companyName?}`** → 200 with the cookie. In order:
    1. A user exists with this `google_sub` → sign in.
    2. Else, if `emailVerified` and a user with that email exists → link it (set `google_sub`, set `email_verified_at` if null) and sign in.
    3. Else, if `emailVerified` → create the user (verified) plus a company (`companyName` required, else 400 field `companyName`).
    4. Else → 400 `"Google hasn't confirmed this email address, so we can't use it to sign in."`

- [ ] **Step 1: Write the failing tests**

One test per branch above. Plus: an unverified Google email matching an existing password user does **not** link, and that user's `google_sub` stays null.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run apps/api/test/auth-google.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run apps/api/test/auth-google.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api && git commit -m "feat(auth): Google sign-in with verified-email linking"
```

---

### Task 9: Permissions, company settings, team, invites, company switcher

**Files:**
- Create:
  - `apps/api/src/permissions.ts`, `apps/api/src/routes/company.ts`, `apps/api/src/routes/team.ts`, `packages/db/src/repos/audit.ts`
  - `apps/api/src/auth/team-store.ts`: the only module that writes `memberships` and `invites` through `@roofline/db/system`. `routes/team.ts` calls it and never imports `db/system` itself.
- Modify: `apps/api/src/auth/routes.ts` (accept-invite, switch-company)
- Test: `apps/api/test/team.test.ts`, `apps/api/test/permissions.test.ts`

**Interfaces:**
- Produces:
  - **Capabilities:** `type Capability = 'billing' | 'company_admin' | 'approve_message' | 'approve_internal' | 'approve_spend' | 'import' | 'view_money_totals'`.
  - **`can(member: {role: Role; canApproveSpend: boolean}, cap: Capability): boolean`** follows the spec §3.2 matrix:
    - owner: all capabilities
    - office: `approve_message`, `approve_internal`, `view_money_totals`, plus `approve_spend` when delegated
    - rep: none
  - **`requireCapability(cap)`** middleware → 403 `"Your role can't do that. Ask the owner."`
  - **`audit(tx, ctx, {action, targetType, targetId, before?, after?, ip?}): Promise<void>`**
  - **Routes:**
    - `GET /api/company`, `PATCH /api/company` (`company_admin`)
    - `GET/PATCH /api/company/settings` (`company_admin`). `marketing_cap_per_7d` must be an integer 0–2, else 400 field `marketingCapPer7d` `"You can lower this, but it can't go above 2 a week."`
    - `GET /api/team` returns members from the `company_members` view
    - `POST /api/team/invites {email, role}` (`company_admin` plus `requireVerifiedEmail`) emails `${APP_ORIGIN}/invite?token=…`, valid 7 days
    - `PATCH /api/team/members/:membershipId {role?, canApproveSpend?, status?}` (`company_admin`). The last active owner can't be demoted or disabled: 400 `"Your company needs at least one owner."`
    - `POST /api/auth/accept-invite {token, name, password} | {token, googleCredential}` (the email must match the invite)
    - `POST /api/auth/switch-company {companyId}` (requires an active membership there)
  - Every PATCH writes `audit`.

- [ ] **Step 1: Write the failing tests**

- **`permissions.test.ts`:** a table test of every role × capability, including office with and without `canApproveSpend`.
- **`team.test.ts`:**
  - an office user doing `PATCH /api/company` → 403
  - invite → accept → the new member appears with the invited role
  - accepting with a different email → 400
  - demoting the only owner → 400
  - setting the cap to 3 → 400 with the exact field and message
  - switching to a company without membership → 404
  - every PATCH leaves an `audit_log` row with the before/after values

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run apps/api/test/team.test.ts apps/api/test/permissions.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run apps/api/test/team.test.ts apps/api/test/permissions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api packages/db && git commit -m "feat(api): permissions matrix, company settings, team and invites"
```

---

## Group C — Records API

### Task 10: Customers API with consent and do-not-contact handling

**Files:**
- Create: `packages/db/src/repos/customers.ts`, `packages/db/src/repos/activities.ts`, `apps/api/src/routes/customers.ts`, `apps/api/src/routes/activities.ts`
- Test: `apps/api/test/customers.test.ts`

**Interfaces:**
- Consumes: `toE164` (Task 2), `audit` (Task 9), `withTenant`.
- Produces:
  - **Repo** (all take `(tx, ctx, …)`): `listCustomers({q?, limit=50 (max 200), offset=0, includeArchived=false})`, `getCustomer(id)`, `createCustomer(input)`, `updateCustomer(id, patch)`, `setArchived(id, archived: boolean)`.
  - **`addActivity(tx, ctx, {subjectType, subjectId, kind, summary, data?})`**
  - **Routes:**
    - `GET/POST /api/customers`, `GET/PATCH /api/customers/:id`
    - `POST /api/customers/:id/archive` and `/unarchive`
    - `GET /api/activities?subjectType=&subjectId=`
  - **Input shape:** `{displayName, firstName?, lastName?, phones?: [{number, label?, primary?}], emails?: string[], tags?: string[], doNotContact?: boolean, smsConsentStatus?: ConsentStatus}`.
  - **Phone handling:** each phone goes through `toE164`; invalid → 400 field `phones.N.number` `"That doesn't look like a US phone number."` If none is marked primary, the first becomes primary.
  - **Duplicate phone:** another non-archived customer in this company already has the number → 409 field `phones.N.number` `"Another customer already has this number."`
  - **Manual consent changes** set `sms_consent_source='manual'`, `sms_consent_by_user_id`, `sms_consent_at`. When the status becomes `revoked` or `doNotContact` becomes true, an `opt_outs` row is upserted for every phone (keyword `manual`).
  - **Reps:** a customer created by a rep stores `created_by_user_id`.

- [ ] **Step 1: Write the failing tests**

- **Phone formats (Review Focus #2):**
  - create with `(402) 555-0144` → stored `+14025550144`, primary
  - create a second customer with `402.555.0144` → 409 with the exact field
  - `555-0144` → 400 with the exact field and message
- **Opt-outs:** PATCH `doNotContact: true` → `opt_outs` has the number; PATCH consent `revoked` → same.
- **History:** PATCH writes `audit_log` (before/after) and an activity "Customer details updated".
- **Archive:** archived customers are hidden from the list unless `includeArchived=true`.
- **Search:** `q=lind` matches "Molly Lindgren" (case-insensitive on `display_name`, and on phone digits).

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run apps/api/test/customers.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run apps/api/test/customers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api packages/db && git commit -m "feat(api): customers API with consent and do-not-contact handling"
```

---

### Task 11: Properties and jobs, rep visibility, tenant-isolation sweep

**Files:**
- Create: `packages/db/src/repos/properties.ts`, `packages/db/src/repos/jobs.ts`, `apps/api/src/routes/properties.ts`, `apps/api/src/routes/jobs.ts`
- Modify: `packages/db/src/repos/customers.ts` (rep scoping)
- Test: `apps/api/test/jobs.test.ts`, `apps/api/test/rep-visibility.test.ts`, `apps/api/test/isolation.test.ts`

**Interfaces:**
- Produces:
  - **Properties:** `POST/GET/PATCH /api/properties[/:id]` with `{customerId?, addressLine, city, state (2-letter), zip (5 digits), lat?, lng?, timezone?, yearBuilt?}`.
    - `geom` is set from lat/lng when both are given.
    - `timezone` is stored only when given; otherwise it stays null (`timezone: null` in responses) and the send gate falls back to the company timezone at send time. (Final-review fix I3: copying the company's zone at creation froze the `America/Chicago` default.)
    - A duplicate `address_key` → 409 `"This address is already saved."`
  - **Jobs:** `POST/GET/PATCH /api/jobs[/:id]` with `{customerId, propertyId, stage?='lead', source?='manual', valueCents?, assignedUserId?, lostReason?}`.
    - A stage change sets `stage_changed_at` and adds activity `"Moved to <Stage label>"`, with labels Lead, Inspection, Proposal, Won, Installed, Lost.
    - `GET /api/jobs?stage=&assigned=me|unassigned&limit&offset`.
  - **Archive routes** for both, as in Task 10.
  - **Rep scoping**, as a single helper `repScope(ctx)` used by the jobs, customers and properties repos (spec §3.2):
    - jobs where `assigned_user_id = me OR created_by_user_id = me OR (stage='lead' AND assigned_user_id IS NULL)`
    - customers and properties linked to such a job, plus customers with `created_by_user_id = me`
    - out-of-scope IDs → 404
  - **Money:** list and get responses omit `valueCents` for reps on jobs outside their scope. In-scope jobs show it.

- [ ] **Step 1: Write the failing tests**

- **`rep-visibility.test.ts`** (one test per §3.2 row for reps):
  - a rep sees jobs assigned to them, jobs they created, and unassigned leads
  - a rep does not see another rep's job: GET → 404
  - a rep can't PATCH another rep's job → 404
  - a rep sees a customer only through a visible job, or because they created it
- **`jobs.test.ts`:**
  - stage `lead` → `inspection` sets `stage_changed_at` to `clock.now()` and adds the "Moved to Inspection" activity
  - an invalid stage → 400 field `stage`
- **`isolation.test.ts`:** a route table run as company B's owner against company A's IDs. Each entry carries the expected result:

```ts
const routes: [method: string, path: string, expect: 404 | 'empty'][] = [
  ['GET', '/api/customers/:customerId', 404], ['PATCH', '/api/customers/:customerId', 404],
  ['POST', '/api/customers/:customerId/archive', 404], ['GET', '/api/properties/:propertyId', 404],
  ['PATCH', '/api/properties/:propertyId', 404], ['GET', '/api/jobs/:jobId', 404], ['PATCH', '/api/jobs/:jobId', 404],
  ['GET', '/api/activities?subjectType=job&subjectId=:jobId', 'empty'], // list endpoint → 200 with []
];
```

Task 14 extends this table with the approval routes.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run apps/api/test/jobs.test.ts apps/api/test/rep-visibility.test.ts apps/api/test/isolation.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the tests to verify they pass**

Run: the same three files.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api packages/db && git commit -m "feat(api): properties, jobs, rep visibility, isolation sweep"
```

---

## Group D — Approval queue

### Task 12: Step-type registry, task creation, approvals list, step edits

**Files:**
- Create: `packages/shared/src/steps.ts`, `packages/db/src/repos/tasks.ts`, `apps/api/src/tasks/service.ts`, `apps/api/src/routes/approvals.ts`
- Test: `packages/shared/test/steps.test.ts`, `apps/api/test/approvals-edit.test.ts`

**Interfaces:**
- Produces:
  - **`StepTypeDef<P>`:**

    ```ts
    {
      type: StepType;
      approvalClass: ApprovalClass;
      payload: z.ZodType<P>;
      validate?(p: P, facts: {companyName: string}): string | null;
      preview(p: P, facts: PreviewFacts): StepPreview;
      minutesSaved(p: P, result: StepResult): number;
    }
    ```

    - `PreviewFacts = {companyName: string; recipientCount?: number; sampleFirstName?: string}`
    - `StepPreview = {title: string; lines: string[]; messageSample?: string; recipientCount?: number; sendTime?: string; maxSpendCents?: number}`
    - `StepResult = Record<string, number | Record<string, number>>`
  - **`stepTypes: Record<StepType, StepTypeDef<any>>`**, where `StepType = 'demo_noop' | 'demo_message' | 'demo_spend' | 'send_sms_batch'`:
    - `demo_noop`: internal, payload `{label: string}`, minutes 5
    - `demo_message`: message, payload `{label: string}`, minutes 5
    - `demo_spend`: spend, payload `{label: string; maxSpendCents: int ≥ 0}`, minutes 5
    - `send_sms_batch`: message
      - payload `{purpose: 'marketing' | 'informational'; body: string (1–1000); customerIds: uuid[] (1–5000); dedupePrefix?: string}`
      - `validate`: when purpose is `marketing`, the body must contain `{company}` or the company name (case-insensitive) **and** `Reply STOP to opt out` (case-insensitive). Otherwise it returns `"Marketing texts must include your company name and \"Reply STOP to opt out\"."`
      - `preview.messageSample` = `renderBody` (Task 15) with `sampleFirstName`
      - `minutesSaved = min(120, 1.5 × result.sent)`
  - **`createTask(tx, ctx, input: NewTask): Promise<{taskId: string}>`**
    - `NewTask = {agent: Agent; kind: string; title: string; summary?: string; subjectType?: string; subjectId?: string; expiresAt?: Date; mode?: 'needs_approval' | 'live'; steps: {type: StepType; payload: unknown}[]}`
    - Validates each payload with its schema and `validate` (failure → AppError 400 with field `steps.N.payload`), builds previews, and sets `idempotency_key` = a new uuid per step, `version` = 1, status `pending`, task status `draft`.
  - **`GET /api/approvals`** → `{count, tasks: TaskView[]}`. It includes `draft`, plus `awaiting_owner` when `can(ctx, 'approve_spend')`. Reps get `{count: 0, tasks: []}`.
    - `TaskView = {id, agent, kind, title, summary, status, createdAt, expiresAt, steps: StepView[]}`
    - `StepView = {id, position, type, approvalClass, enabled, version, status, preview, canApprove: boolean}`
  - **`GET /api/approvals/:taskId`** → `TaskView`, or 404.
  - **`PATCH /api/approvals/:taskId/steps/:stepId {version, enabled?, payload?}`**
    - only while the step is `pending`
    - a version mismatch → 409 `"This changed while you were looking. Here's the latest."`
    - re-validates and rebuilds the preview, bumps `version`, writes `audit`
    - returns the `StepView`

- [ ] **Step 1: Write the failing tests**

- **`steps.test.ts`:**
  - `send_sms_batch.validate` rejects a marketing body without opt-out wording, with the exact message
  - it accepts `"Hi {first_name}, it's {company}. … Reply STOP to opt out."`
  - informational bodies need neither
- **`approvals-edit.test.ts`:**
  - `createTask` with a bad payload → 400 field `steps.0.payload`
  - the owner's `GET /api/approvals` count is 1 after one draft; a rep's is 0
  - PATCH `enabled: false` with the current version → 200, version 2
  - the same PATCH again with version 1 → 409 with the exact message
  - a payload edit rebuilds `preview.messageSample`

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run packages/shared/test/steps.test.ts apps/api/test/approvals-edit.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the tests to verify they pass**

Run: the same files.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared apps/api packages/db && git commit -m "feat(tasks): step registry, task creation, approvals list and edits"
```

---

### Task 13: Approve, partial approval, decline, run, finish, retry

**Files:**
- Create: `apps/api/src/tasks/queue.ts`, `apps/api/src/tasks/runner.ts`, `apps/api/src/tasks/handlers.ts`, `apps/api/src/routes/tasks.ts`
- Modify: `apps/api/src/tasks/service.ts`, `apps/api/src/routes/approvals.ts`
- Test: `apps/api/test/approvals-approve.test.ts`, `apps/api/test/runner.test.ts`

**Interfaces:**
- Produces:
  - **`StepQueue = {enqueueStep(companyId: string, stepId: string): Promise<void>}`.** `InlineQueue` (test) records calls; `drain(deps)` runs them with `runStep` in order until empty.
  - **`approveTask(tx, ctx, taskId, seen: {id: string; version: number}[]): Promise<{toEnqueue: string[]}>`.** It locks the task row `FOR UPDATE` and requires status `draft` or `awaiting_owner` (else 409 "This was already handled."). Then:

    ```
    for each step with status in (pending, awaiting_owner):
      if seen has no entry or version differs → throw 409 (same message as Task 12)
    for each such step:
      if !enabled → skipped
      else if can(ctx, 'approve_' + approvalClass) → queued, approved_by/at = ctx.userId/now, add to toEnqueue
      else → awaiting_owner
    task.status = any step awaiting_owner ? 'awaiting_owner' : (toEnqueue non-empty ? 'running' : 'done')
    task.approved_by/at set the first time any step is approved; audit 'task.approve' with step ids
    ```

    The route calls `queue.enqueueStep` for each ID in `toEnqueue` **after** the transaction commits, and returns `TaskView`.
  - **Decline:**
    - `POST /api/approvals/:taskId/approve {steps: [{id, version}]}` (requires `approve_message` or `approve_internal`; per-step checks as above)
    - `POST /api/approvals/:taskId/decline {reason?}` sets task `declined`, records `decline_reason`, and marks pending or awaiting_owner steps `skipped`
    - `POST /api/approvals/:taskId/steps/:stepId/decline` skips one `awaiting_owner` step (`approve_spend` only), then runs `refreshTask`
  - **Running:**
    - `registerStepHandler(type: StepType, handler: StepHandler)`, where `StepHandler = (deps: AppDeps, tx: Tx, ctx: TenantContext, step: StepRow) => Promise<StepOutcome>`
    - `StepOutcome = {status: 'done' | 'running' | 'failed' | 'needs_attention'; result: StepResult; errorPlain?: string}`
    - All three demo types are registered as `{status: 'done', result: {ok: 1}}`.
  - **`runStep(deps, companyId, stepId): Promise<void>`** opens `withTenant(system ctx)`:
    1. Claim with `UPDATE … SET status='running', attempts = attempts + 1 WHERE id=$1 AND status IN ('queued','running') RETURNING *`. No row means return.
    2. Call the handler and write the outcome.
    3. If the handler throws: when `attempts < 5`, rethrow so the queue retries; else set `needs_attention` with `errorPlain = "We couldn't finish this step. We'll keep the details here so you can retry."`
    4. Call `refreshTask`.
  - **`refreshTask(tx, ctx, taskId)`:** if no step is `queued`, `running` or `awaiting_owner`, the task becomes:
    - `done` if every non-skipped step is done
    - `needs_attention` if any is `needs_attention`
    - `partly_done` if any is `failed`

    It then sets `minutes_saved` = the sum of `minutesSaved` over the done steps.
  - **Retry:** `POST /api/approvals/:taskId/steps/:stepId/retry` (`approve_message`) moves `failed` or `needs_attention` to `queued` (same `idempotency_key`), sets the task `running`, and enqueues after commit.
  - **Feed:** `GET /api/tasks?agent=&status=&since=&limit=50` → `TaskView[]`; `GET /api/tasks/summary` → `{working: number}`, the count of distinct tasks with any step `queued` or `running`.

- [ ] **Step 1: Write the failing tests**

- **`approvals-approve.test.ts`:**
  - **Owner, 3 demo steps** (message, internal, spend): approve → the task runs; after `queue.drain()` → `done`, `minutes_saved` 15, `audit_log` has `task.approve`.
  - **Partial approval:** an office user without delegation approves `demo_message` + `demo_spend`. The message step ends `done`; the spend step and the task are `awaiting_owner`. The owner's approvals list includes the task and the office user's does not. The owner approves with current versions → after drain the task is `done`.
  - **Skipped step:** with step 2 disabled before approval, step 2 ends `skipped` and the task `done` with `minutes_saved` 10.
  - **Stale version:** approve with an old version → 409, and no step was queued.
  - **Double-click (Review Focus #4):** two concurrent `approve` requests with the same versions (`Promise.all`) → exactly one 200 and one 409. `queue` received each step ID exactly once.
  - **Decline:** decline with reason "Not this storm" → task `declined`, steps `skipped`, `decline_reason` stored.
- **`runner.test.ts`:**
  - **Retries:** a test handler that throws twice then succeeds → attempts 3, status `done`.
  - **Gives up:** a handler that always throws → after 5 attempts `needs_attention` with the exact `errorPlain`, task `needs_attention`.
  - **Retry endpoint:** → `queued` again, same `idempotency_key`; after drain with the handler now succeeding → `done`.
  - **Summary:** `GET /api/tasks/summary` shows `working: 1` while a step is `queued`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run apps/api/test/approvals-approve.test.ts apps/api/test/runner.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the tests to verify they pass**

Run: the same files.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api && git commit -m "feat(tasks): approve with partial approval, decline, runner, retry"
```

---

### Task 14: pg-boss worker, draft expiry, queued-step sweeper, rerun, demo seed

**Files:**
- Create:
  - `apps/worker/src/index.ts`
  - `apps/api/src/tasks/pgboss-queue.ts`
  - `apps/api/src/jobs/scheduler/expire-drafts.ts`, `sweep-queued.ts`
  - `packages/db/src/system/scheduler.ts`
  - `apps/api/src/scripts/seed-demo.ts`
- Modify: `apps/api/src/routes/approvals.ts` (rerun), `apps/api/test/isolation.test.ts` (approval routes)
- Test: `apps/api/test/scheduler.test.ts`, `apps/api/test/pgboss.test.ts`

**Interfaces:**
- Produces:
  - **`PgBossQueue implements StepQueue`:** queue name `agent-step`, `send('agent-step', {companyId, stepId}, {singletonKey: stepId, retryLimit: 5, retryBackoff: true})`. It connects with the `app_system` URL and schema `pgboss`.
  - **System functions:** `companiesWithExpiredDrafts(system, now): Promise<string[]>` and `stepsQueuedLongerThan(system, ms, now): Promise<{companyId; stepId}[]>`. They read only the whitelisted columns.
  - **`expireDrafts(deps, now)`:** for each such company, in `withTenant`, sets `status='expired'` where `status='draft' AND expires_at < now`.
  - **`sweepQueued(deps, now)`:** re-enqueues steps that have been `queued` for more than 2 minutes. Safe, because the `singletonKey` dedupes them.
  - **Rerun:** `POST /api/approvals/:taskId/rerun` (an `expired` task only) creates a fresh draft with the same agent, kind, title and step payloads, new step IDs, and `expires_at` = now + (old `expires_at` − old `created_at`). It returns the new `TaskView`.
  - **Worker** (`apps/worker/src/index.ts`) builds deps from env, then:
    - `boss.work('agent-step', job => runStep(deps, job.data.companyId, job.data.stepId))`
    - schedules `expire-drafts` (`*/5 * * * *`), `sweep-queued` (`* * * * *`) and `dispatch-messages` (`* * * * *`, wired in Task 17)
  - **Demo seed:** `npm run seed:demo -w @roofline/api -- --company <slug>` creates the 3-step demo task for F2:
    - `demo_message` "Text 31 customers"
    - `demo_noop` "Door-knock routes for 4 reps"
    - `demo_spend` "Google + Facebook ads on the swath", `maxSpendCents` 27000
    - `expires_at` = now + 48 hours

- [ ] **Step 1: Write the failing tests**

- **`scheduler.test.ts`:**
  - a draft with `expires_at` in the past → `expireDrafts` → `expired`; a draft in company B with a future expiry is untouched
  - rerun of an expired task → a new draft with the same step payloads and a 48-hour window
  - rerun of a non-expired task → 409 `"Only expired plans can be run again."`
  - `sweepQueued` re-enqueues a step stuck in `queued` for 3 minutes and leaves a 1-minute-old one alone
- **`pgboss.test.ts`** (real pg-boss on the Testcontainer): approve a demo task with `PgBossQueue`, start a worker in-process, and poll ≤ 10 s until the task is `done`.
- **`isolation.test.ts`:** add `GET /api/approvals/:taskId`, `PATCH …/steps/:stepId`, `POST …/approve`, `…/decline`, `…/steps/:stepId/retry`, `…/rerun`. All return 404 for company B against company A's task.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run apps/api/test/scheduler.test.ts apps/api/test/pgboss.test.ts apps/api/test/isolation.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the tests to verify they pass, then try the seed**

Run: the same files, then `npm run seed:demo -w @roofline/api -- --company acme-roofing` against the dev database.
Expected: tests PASS; the seed prints the new task ID.

- [ ] **Step 5: Commit**

```bash
git add apps packages/db && git commit -m "feat(worker): pg-boss runner, draft expiry, sweeper, rerun, demo seed"
```

---

## Group E — Send gate

### Task 15: `decide()` and quiet hours (pure)

**Files:**
- Create: `packages/send-gate/src/decide.ts`, `quiet-hours.ts`, `render.ts`, `adapter.ts`, `index.ts`
- Test: `packages/send-gate/test/decide.test.ts`, `quiet-hours.test.ts`

**Interfaces:**
- Produces:
  - **`GateRequest`:**

    ```ts
    {
      now: Date;
      company: { name: string; timezone: string; status: CompanyStatus; campaignStatus: CampaignStatus; marketingCapPer7d: number };
      recipient: { phoneE164: string | null; consent: ConsentStatus; doNotContact: boolean; optedOut: boolean; timezone: string | null; state: string | null };
      message: { purpose: 'marketing' | 'informational'; body: string; dedupeKey: string | null; replyToInboundAt: Date | null };
      history: { dedupeAlreadySent: boolean; marketingSentAt: Date[] }; // marketingSentAt = last 7 days, any order
    }
    ```

  - **`GateDecision = {action: 'send'} | {action: 'schedule'; at: Date; rule: GateRule; reason: string} | {action: 'block'; rule: GateRule; reason: string}`**
  - **`decide(req: GateRequest): GateDecision`** applies the rules in order, stopping at the first block. Block reasons (exact):

    | Rule | When it blocks | Reason |
    |---|---|---|
    | `billing` | `status ∈ {trial_ended, past_due, canceled}` | "Texting is paused until billing is sorted out." |
    | `registration` | `campaignStatus !== 'approved'` | "Texting turns on after the phone carriers approve your registration." |
    | `contact` | `phoneE164` null | "No mobile number on file." |
    | `contact` | `doNotContact` or `optedOut` | "This customer asked not to be texted." |
    | `consent` | marketing needs `attested`/`written`; informational needs `express`/`attested`/`written` | "No texting consent on file." |
    | `content` | marketing body missing the company name or `/reply stop to opt out/i` | "Marketing texts must include your company name and how to opt out." |
    | `dedupe` | `dedupeAlreadySent` | "Already sent this message to this customer." |
    | `frequency` | marketing count in the last 7 days ≥ `marketingCapPer7d` | "Already texted this customer the most allowed this week." |

    Then two deferrals:
    - **`frequency` (FL/OK/MD, marketing):** ≥ 3 in the last 24 hours → candidate `t1` = third-most-recent + 24 hours. Otherwise `t1` = now.
    - **`quiet_hours`** applies unless the message is informational and `replyToInboundAt` is within 15 minutes before now. Then `t2 = nextAllowedTime(t1, recipient.timezone ?? company.timezone, recipient.state)`.

    Result: if `t2 > now` → schedule at `t2` with rule `frequency` if `t1 > now`, else `quiet_hours`, and reason `"Will send at <h:mm a> their time (quiet hours)."` or `"Will send at <h:mm a> their time (daily limit)."`. Otherwise → send.
  - **`nextAllowedTime(t: Date, tz: string, state: string | null): Date`** uses luxon in `tz`:
    - window start 08:00, end 21:00, or 20:00 when `state ∈ {FL, OK, MD}`
    - inside the window → `t`
    - before start → today at 08:00
    - at or after end → tomorrow at 08:00
  - **`renderBody(template: string, vars: {first_name?: string; company: string}): string`** replaces `{first_name}` (empty → "there") and `{company}`.
  - **SMS adapter:**
    - `SmsAdapter = {send(m: {companyId: string; to: string; body: string}): Promise<{providerSid: string; segments: number}>}`
    - `FakeSmsAdapter` has `sent: {companyId, to, body}[]`, `failNext(n)`, and segments = `ceil(body.length / 153)` (1 when ≤ 160)

- [ ] **Step 1: Write the failing tests**

- **`decide.test.ts`:**
  - **Rule coverage:** one test per rule above asserting `action`, `rule` and the exact `reason`, with a baseline request that sends (consent `attested`, approved campaign, active company, 10:00 local, Nebraska).
  - **Rule order:** a request failing both `consent` and `dedupe` reports `consent`.
  - **Informational consent:** with `express` → send; marketing with `express` → block `consent`.
  - **Quiet hours:** marketing at 21:30 Chicago → schedule at next day 08:00 Chicago, rule `quiet_hours`.
  - **Reply exception:** informational at 23:00 with `replyToInboundAt` = 22:50 → send. With `replyToInboundAt` = 22:40 → schedule.
  - **Florida:** marketing at 20:15, state FL → schedule at 08:00. At 20:15 in NE → send.
  - **FL frequency:** three marketing sends in the last 24 hours at 09:00, 10:00 and 11:00 → schedule at 09:00 tomorrow, rule `frequency`. With cap 2 per 7 days → block `frequency` instead.
- **`quiet-hours.test.ts`** (Review Focus #5):
  - **No time zone or state:** the recipient falls back to the company zone (`America/Chicago`) and a 21:00 end.
  - **DST days:** on 2026-03-08 (spring forward) a 07:30 local request → 08:00 local the same day. On 2026-11-01 (fall back) a 21:05 local request → 08:00 local the next day. Both are asserted via luxon in `America/Chicago`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run packages/send-gate`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run packages/send-gate`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/send-gate && git commit -m "feat(send-gate): decide() with consent, caps, quiet hours"
```

---

### Task 16: Inbound keyword classifier (pure)

**Files:**
- Create: `packages/send-gate/src/inbound.ts`
- Test: `packages/send-gate/test/inbound.test.ts`

**Interfaces:**
- Produces: **`classifyInbound(body: string): 'stop' | 'help' | 'start' | 'other'`**.
  - **Normalize first:** lowercase, strip characters other than letters and spaces, collapse whitespace, trim.
  - **`stop`:** the normalized text is exactly one of `stop, stopall, unsubscribe, cancel, end, quit, revoke, optout, opt out`, or exactly one of these phrases: `stop texting me, stop messaging me, stop texting, please stop, please stop texting me, unsubscribe me, remove me, take me off your list, do not text me, dont text me, opt me out`.
  - **`help`:** exactly `help` or `info`.
  - **`start`:** exactly `start`, `unstop` or `yes start`.
  - **Everything else:** `other`. This is a whole-message match only, never "contains".

- [ ] **Step 1: Write the failing test** (Review Focus #1)

```ts
test.each(['STOP', 'Stop.', '  stop  ', 'Stop texting me!', "don't text me", 'UNSUBSCRIBE'])('%s → stop', b =>
  expect(classifyInbound(b)).toBe('stop'));
test.each(['Can you stop by Thursday?', 'stop the leak please', 'Is the crew going to stop at 5?', 'end of day works'])(
  '%s → other', b => expect(classifyInbound(b)).toBe('other'));
test('help', () => expect(classifyInbound('HELP')).toBe('help'));
test('start', () => expect(classifyInbound('Start')).toBe('start'));
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/send-gate/test/inbound.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run packages/send-gate/test/inbound.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/send-gate && git commit -m "feat(send-gate): whole-message STOP/HELP/START classifier"
```

---

### Task 17: `send_sms_batch` handler and the scheduled-message dispatcher

**Files:**
- Create:
  - `packages/db/src/repos/messages.ts`
  - `apps/api/src/messaging/gate-request.ts`, `send-batch.ts`, `dispatcher.ts`
  - `apps/api/src/jobs/scheduler/dispatch-messages.ts`
- Modify: `apps/api/src/tasks/handlers.ts` (register `send_sms_batch`), `packages/db/src/system/scheduler.ts`, `apps/worker/src/index.ts`
- Test: `apps/api/test/send-batch.test.ts`, `apps/api/test/dispatcher.test.ts`

**Interfaces:**
- Consumes: `decide`, `renderBody`, `SmsAdapter` (Task 15); `registerStepHandler`, `refreshTask` (Task 13).
- Produces:
  - **`buildGateRequest(tx, ctx, {customerId, purpose, body, dedupeKey, replyToInboundAt}, now): Promise<{req: GateRequest; toE164: string | null}>`**
    - The phone is the customer's primary phone (else the first, else null).
    - Time zone and state come from the customer's most recently updated property, else null.
    - `optedOut` = an `opt_outs` row exists for that phone.
    - `dedupeAlreadySent` = an out message with this `dedupe_key` exists in `sent` or `delivered`.
    - `marketingSentAt` = out marketing messages in `sent`/`delivered` in the last 7 days.
  - **`sendSmsBatch: StepHandler`.** For each customer in `payload.customerIds` that has no message row for `(step_id, customer_id)` yet:
    1. Render the body with the customer's first name and the company name.
    2. Decide.
    3. Insert a message row:
       - **send:** `queued`, then `sms.send`, then `sent` with `provider_message_sid`, `segments` and `sent_at`, plus a `usage_events` row (`sms_segment`, quantity = segments)
       - **schedule:** `scheduled` with `scheduled_for`
       - **block:** `blocked` with `block_rule` and `block_reason`
    4. Existing rows in `queued` older than 5 minutes become `failed` with `block_reason "We couldn't confirm this text was sent, so we didn't resend it."` They are never resent.
    5. `result = {sent, scheduled, failed, blocked: {<rule>: n}}`
    6. Outcome `running` if any row is `scheduled`, else `done`.
    7. An `sms.send` throw → that row becomes `failed` and the handler rethrows once all recipients are processed, so the runner retries. Rows already sent are skipped on retry.
  - **`dispatchDueMessages(deps, now)`** in `jobs/scheduler/dispatch-messages.ts` (allowed to use `db/system`):
    - It calls the system function `companiesWithDueMessages(system, now)`.
    - Then it calls **`dispatchCompanyMessages(deps, companyId, now)`** from `messaging/dispatcher.ts`, which uses `withTenant` only.
    - For each due row, `dispatchCompanyMessages` rebuilds the gate request, so a STOP, do-not-contact change or billing pause overnight is honored.
    - Then: send → as above; schedule → update `scheduled_for`; block → `blocked`.
    - The second decision is stored in `block_rule`/`block_reason`, or on the row's send fields.
    - For each step touched it updates `result` and, when no row is `scheduled`, sets the step `done` and calls `refreshTask`.
  - **Worker:** `dispatch-messages` is wired into the worker schedule from Task 14.

- [ ] **Step 1: Write the failing tests**

- **`send-batch.test.ts`:** seed 5 customers in company A:
  - `c1` attested, Nebraska property
  - `c2` express only (marketing → blocked `consent`)
  - `c3` opted out (blocked `contact`)
  - `c4` no phone (blocked `contact`, "No mobile number on file.")
  - `c5` attested with a Florida property

  Create and approve a marketing `send_sms_batch` at 20:30 Chicago and drain. Expect:
  - `c1` sent
  - `c5` scheduled for 08:00 the next day
  - result `{sent: 1, scheduled: 1, failed: 0, blocked: {consent: 1, contact: 2}}`
  - step `running`, and `usage_events` has 1 row
  - running the step again (retry) sends nothing new (`FakeSmsAdapter.sent.length` is still 1)
  - with `failNext(1)`: the row is `failed`, the handler rethrows, the retry sends it, and the total sent stays exactly 1 per customer
- **`dispatcher.test.ts`:**
  - advance the clock to 08:01 the next day, then `dispatchDueMessages` → `c5` sent, step `done`, task `done`
  - **STOP overnight:** if `c5` texts STOP overnight (insert an `opt_outs` row) before dispatch, `c5` becomes `blocked` with rule `contact` and nothing is sent

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run apps/api/test/send-batch.test.ts apps/api/test/dispatcher.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the tests to verify they pass**

Run: the same files.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps packages/db && git commit -m "feat(messaging): send_sms_batch through the gate, scheduled-text dispatcher"
```

---

### Task 18: Twilio inbound and status webhooks

**Files:**
- Create: `apps/api/src/hooks/twilio.ts`, `packages/db/src/system/routing.ts`, `packages/db/src/crypto.ts`
- Modify: `apps/api/src/app.ts` (mount `/hooks/twilio` with `express.urlencoded`, before the session middleware)
- Test: `apps/api/test/twilio-hooks.test.ts`

**Interfaces:**
- Produces:
  - **Encryption:** `encrypt(plain: string, keyB64: string): Buffer` and `decrypt(buf: Buffer, keyB64: string): string`, AES-256-GCM, layout `iv(12) | tag(16) | ciphertext`.
  - **Routing:** `companyIdForNumber(system, e164): Promise<string | null>` (from `company_phone_numbers`) and `signingTokenFor(system, companyId, fallback: string | undefined): Promise<string | null>`. The token is the decrypted `texting_registrations.subaccount_auth_token_encrypted`, else the fallback (`TWILIO_AUTH_TOKEN`).
  - **`POST /hooks/twilio/sms`:**
    1. Resolve the company from `To`. Unknown → 404, and nothing is stored.
    2. Verify `X-Twilio-Signature` with `twilio.validateRequest(token, signature, PUBLIC_BASE_URL + req.originalUrl, req.body)`. Invalid → 403.
    3. Dedupe on `webhook_events(provider='twilio', event_id=MessageSid)`. A repeat → 200 with empty TwiML and nothing else done.
    4. Inside `withTenant(company)`: find the customer by phone (`From`).
    5. Store a `messages` row: `direction=in`, `status=received`, `body`, `customer_id` (nullable).
    6. Classify the text:
       - **stop** → upsert `opt_outs` (keyword = normalized text); set the customer's consent to `revoked` (source `text`); audit; reply TwiML `"You're unsubscribed from <Company> texts. No more messages will be sent. Reply START to resubscribe."`
       - **help** → reply `"<Company>: call us at <company phone>. Reply STOP to opt out."`
       - **start** → delete the `opt_outs` row; set consent `express` (source `text`); reply `"You're resubscribed to <Company> texts. Reply STOP to opt out."`
       - **other** → empty TwiML
  - **`POST /hooks/twilio/status`:** same company resolution (by `From`, the company's number) and signature check. It updates the message (by `MessageSid`) to `delivered`, or to `failed` when `MessageStatus ∈ {failed, undelivered}`.

- [ ] **Step 1: Write the failing tests**

Seed `company_phone_numbers` for A (`+14025550100`) and an encrypted subaccount token. Sign requests with `twilio.getExpectedTwilioSignature`.

- **STOP:** a valid "STOP" from customer `c1` → opt-out row, consent `revoked`, an `audit_log` entry, and a reply containing "You're unsubscribed from".
- **Repeat delivery:** the same `MessageSid` again → 200, and still exactly one inbound message row.
- **Bad signature:** → 403, and no rows are written.
- **Unknown number:** an unknown `To` → 404.
- **Normal message:** "Can you stop by Thursday?" → stored as received, and consent is unchanged (Review Focus #1 end to end).
- **START** after STOP → opt-out removed, consent `express`.
- **Status callback:** `delivered` → the message status is `delivered`.
- **Isolation:** the message lands in company A only. Company B's `withTenant` sees 0 inbound rows.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run apps/api/test/twilio-hooks.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run apps/api/test/twilio-hooks.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api packages/db && git commit -m "feat(hooks): Twilio inbound STOP/HELP/START and delivery status"
```

---

### Task 19: Import boundaries, CI, and the F1 acceptance run

**Files:**
- Modify: `eslint.config.js` (`no-restricted-imports` for `@roofline/db/system` everywhere, turned off for the four allowed globs in Global Constraints)
- Create: `.github/workflows/ci.yml`, `apps/api/test/boundaries.test.ts`

**Interfaces:**
- Produces: CI on push and pull request. Ubuntu, Node 22, `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`. Testcontainers uses the runner's Docker. Live provider calls are never made in CI.

- [ ] **Step 1: Write the failing test**

`boundaries.test.ts` runs ESLint programmatically on a fixture file `apps/api/src/routes/__fixture_bad_import.ts` that imports `@roofline/db/system`, and expects 1 `no-restricted-imports` error. The same import in a fixture under `apps/api/src/hooks/` expects 0. Delete both fixtures in the afterAll hook, or keep them under `test/fixtures/` with matching globs.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/api/test/boundaries.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the ESLint rule and the CI workflow**

- [ ] **Step 4: Run the full F1 acceptance**

Run: `npm run lint && npm run typecheck && npm test && (cd v1 && npm test)`
Expected: everything passes. Spec §3.7 checklist:
- isolation tests (Tasks 4, 11, 14, 18)
- the permission matrix (Tasks 9, 11)
- the approval queue: edit, 409, partial approval, retry, expiry, audit (Tasks 12–14)
- every send-gate rule, FL/OK/MD, DST, and the STOP re-check (Tasks 15–17)
- pricing parity (Task 2)
- v1 runs (Task 1)

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: import boundaries for db/system, CI workflow"
```

Pushing to GitHub (and creating the private repo) is **not** part of this task. Ask the owner first.

---

## Decisions this plan adds to the spec

Recorded so reviewers don't treat them as drift.

**New columns, tables and step types**
- `users.email_verified_at`; a global `user_tokens` table.
- `properties.address_key`; `messages.to_e164`.
- `agent_task_steps.attempts`; a partial unique index on `messages(step_id, customer_id)`.
- `texting_registrations.subaccount_auth_token_encrypted`.
- Demo step types `demo_message` and `demo_spend` alongside `demo_noop`, so partial approval and the F2 demo can be tested.

**Status and summary rules**
- A task whose steps are partly `awaiting_owner` and partly running shows `awaiting_owner`. The "agents working" count comes from step states (`GET /api/tasks/summary`), not task status.

**Send gate**
- The `billing` gate rule is implemented now, because it's pure and `companies.status` already exists. F3 only adds what sets the status.
- Inbound START re-subscribes at `express` (informational only). Marketing consent is never restored by a text.

**Database and queue**
- `app_system` gets past RLS with permissive `app_system_all` policies (not the bypass attribute, which needs a superuser; final-review fix I2) but only column-level SELECT on three tenant tables, so it can do cross-company scheduling without reading content.
- The company-scoped global tables (`companies` by `id`, `company_phone_numbers`, `texting_registrations`) also get RLS, so `app_tenant` can read its own row. `app_tenant` may update only profile columns of `companies`; billing and registration state are written only by `app_system`.
- pg-boss enqueue happens after the transaction commits. A 1-minute sweeper re-enqueues steps stuck in `queued`, and `singletonKey` = step ID prevents duplicates.
- Outbound texts never auto-resend a row whose send outcome is unknown.
