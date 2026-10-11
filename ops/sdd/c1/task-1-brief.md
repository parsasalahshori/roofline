### Task 1: Dependency, C1 schema and the module skeleton

**Base:** `c1-crm`, branched from `f3-setup` when F3 is complete. F3 Tasks 1–13 and 23 are merged into `f3-setup` (7b988eb); F3 adds no migration after `0011_f3_grants_rls.sql` (checked: no F3 brief 14–37 and no open F3 branch touches `packages/db/migrations`). Existing shapes to extend: `packages/db/src/schema/tenant.ts` (`jobs` has `stage`, `stage_changed_at`, `value_cents`, `lost_reason`, `source`; `company_settings` has `hourly_rate_cents`; `TENANT_TABLES` list), `packages/db/src/schema/enums.ts`, `enumCheck`/`pk`/`companyId`/`tstz`/`timestamps` helpers in `schema/columns.ts`, `0011_f3_grants_rls.sql` (copy its section style), `packages/db/test/{migrations,rls}.test.ts`.

Read first: `ops/sdd/c1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-core-crm-design.md`.

**Split:**
- Builder 1: schema TS and the generated migration `0012`.
- Builder 2: the custom grants/RLS migration `0013` plus the `rls.test.ts` and `migrations.test.ts` updates.
- Builder 3: npm dependency, placeholder modules and barrels.

**Files:**
- Modify: `packages/db/src/schema/tenant.ts`, `packages/db/src/schema/enums.ts` (re-export the new shared enums), `packages/db/src/index.ts`, `packages/db/src/system/index.ts`, `packages/shared/src/index.ts`, `apps/api/package.json`, `package-lock.json`
- Create:
  - `packages/db/migrations/0012_crm_schema.sql` (`npm run db:generate -- --name crm_schema`), `packages/db/migrations/0013_crm_grants_rls.sql` (`npx drizzle-kit generate --custom --name crm_grants_rls` in `packages/db`), meta snapshots and journal entries
  - placeholders (`export {};`): `packages/db/src/repos/{board,timeline,notes,appointments,today,schedules,calendar,calendar-links,calendar-busy,quotes,pricebook,export}.ts`, `packages/db/src/system/calendar-sync.ts`, `packages/shared/src/{pipeline,availability,crm,csv}.ts`
- Test: `packages/db/test/migrations.test.ts`, `packages/db/test/rls.test.ts` (extend)

**Interfaces:**
- **npm:** `apps/api` dependencies `pdfkit` (current major) and devDependency `@types/pdfkit`. No later task edits `package-lock.json`.
- **Shared enums** (in `packages/shared/src/availability.ts`, so Task 1 writes the constants there now and Task 3 adds the rest below them): `APPOINTMENT_KINDS = ['inspection','install','adjuster','other'] as const`, `APPOINTMENT_STATUSES = ['scheduled','completed','canceled','no_show'] as const`, `APPOINTMENT_SOURCES = ['manual','front_desk','scheduler','external'] as const`, `CALENDAR_PROVIDERS = ['google','microsoft'] as const`, `CALENDAR_CONNECTION_STATUSES = ['connected','error','revoked'] as const`, `QUOTE_STATUSES = ['draft','final'] as const` and their types.
- **`jobs` gains:** `next_step text` (≤ 120 by CHECK), `next_step_on date`; index `jobs_company_stage_changed_idx (company_id, stage, stage_changed_at)`.
- **`company_settings` gains:** `work_hours jsonb not null default '{"mon":[["08:00","18:00"]],"tue":[["08:00","18:00"]],"wed":[["08:00","18:00"]],"thu":[["08:00","18:00"]],"fri":[["08:00","18:00"]],"sat":[["08:00","12:00"]],"sun":[]}'`, `travel_buffer_minutes integer not null default 30` CHECK 0–120, `min_notice_minutes integer not null default 120` CHECK 0–4320, `stuck_after_days integer not null default 14` CHECK 3–90.
- **New tenant tables** (all with `id`, `company_id`, timestamps; added to `TENANT_TABLES`):
  - `appointments`: `kind` CHECK `APPOINTMENT_KINDS`, `title text`, `job_id uuid`, `customer_id uuid`, `property_id uuid` (composite FKs to jobs/customers/properties), `assigned_user_id` (→ users), `starts_at timestamptz not null`, `ends_at timestamptz not null` CHECK `ends_at > starts_at`, `all_day boolean not null default false`, `status` CHECK `APPOINTMENT_STATUSES` default `'scheduled'`, `notes text`, `source` CHECK `APPOINTMENT_SOURCES` default `'manual'`, `created_by_user_id`, `canceled_at`, `archived_at`; unique `(company_id, id)`; indexes `(company_id, starts_at)`, `(company_id, assigned_user_id, starts_at)`, `(job_id)`.
  - `calendar_connections`: `user_id not null` (→ users), `provider` CHECK `CALENDAR_PROVIDERS`, `account_email text`, `calendar_id text`, `calendar_name text`, `encrypted_credentials bytea not null`, `scopes text[] not null default '{}'`, `status` CHECK `CALENDAR_CONNECTION_STATUSES` default `'connected'`, `last_error_plain text`, `sync_cursor text`, `last_synced_at timestamptz`; unique `(company_id, user_id)`, unique `(company_id, id)`.
  - `calendar_event_links`: `appointment_id uuid not null`, `connection_id uuid not null` (composite FKs, `on delete cascade` from the connection), `provider_event_id text not null`, `etag text`, `last_pushed_at timestamptz`, `push_error_plain text`; unique `(appointment_id)`, unique `(connection_id, provider_event_id)`.
  - `calendar_busy_blocks`: `connection_id uuid not null` (composite FK, cascade), `user_id not null`, `provider_event_id text not null`, `starts_at`, `ends_at` (CHECK end > start), `all_day boolean not null default false`; unique `(connection_id, provider_event_id)`; index `(company_id, user_id, starts_at)`.
  - `member_schedules`: `user_id not null`, `weekly_hours jsonb not null`; unique `(company_id, user_id)`.
  - `pricebooks`: `prices jsonb not null`, `defaults jsonb not null default '{}'`, `updated_by_user_id`; unique `(company_id)`.
  - `quotes`: `job_id uuid not null` (composite FK), `number text not null`, `status` CHECK `QUOTE_STATUSES` default `'draft'`, `measurement jsonb not null`, `scope jsonb not null`, `prices jsonb not null`, `calculation jsonb not null`, `notes text`, `valid_until date not null`, `created_by_user_id`, `finalized_at`; unique `(company_id, number)`, unique `(company_id, id)`; index `(job_id)`.
  - `quote_counters`: `company_id` unique, `next_number integer not null default 1`.
- **`0013_crm_grants_rls.sql`** (follow `0011`'s section style):
  - `GRANT SELECT, INSERT, UPDATE` on the eight tables to `app_tenant`; `GRANT DELETE ON calendar_busy_blocks, calendar_event_links TO app_tenant`; each table's ENABLE / FORCE / `tenant_isolation`.
  - `GRANT UPDATE (work_hours, travel_buffer_minutes, min_notice_minutes, stuck_after_days) ON company_settings TO app_tenant` (if company_settings already grants table-wide UPDATE, assert it in the test instead).
  - `GRANT UPDATE (next_step, next_step_on) ON jobs TO app_tenant` likewise.
  - `GRANT SELECT (id, company_id, user_id, status, last_synced_at) ON calendar_connections TO app_system` + `CREATE POLICY app_system_all ON calendar_connections FOR ALL TO app_system USING (true) WITH CHECK (true)`.
- **Barrels:** `export * from './repos/<name>.ts'` for each new repo, `export * from './calendar-sync.ts'` in `system/index.ts`, `export * from './<name>.ts'` for each new shared file.

**Tests:**
- `migrations.test.ts`: `test('C1 tables are tenant tables with RLS forced')` (the eight tables); `test('an appointment cannot end before it starts')` → `23514`; `test('one calendar connection per person per company')` → `23505`; `test('quote numbers are unique per company')` → `23505` in A, success in B; `test('stuck_after_days accepts 3 to 90')` → 2 is `23514`.
- `rls.test.ts`: extend the grants lists (app_tenant relations incl. the two DELETE grants, the `app_system` column grant and `app_system_all` table list now including `calendar_connections`).

**Carries and rulings:**
- Barrels get **every** C1 line now (repos, `system/calendar-sync.ts`, shared files), so no later task edits `packages/db/src/index.ts`, `system/index.ts` or `packages/shared/src/index.ts`.
- The placeholders include `repos/calendar-links.ts` and `repos/calendar-busy.ts` as separate files so T13 and T14 never share a file.

**Verify notes:**
- `npx vitest run --project @roofline/db` (CI: `ops/bin/ci-check`).
- Generate `0012`; write `0013` by hand; `npm install pdfkit -w @roofline/api && npm install -D @types/pdfkit -w @roofline/api`.
- `npx vitest run --project @roofline/db && npm run typecheck && npm run lint && npx vitest run`. Expected: PASS; F1–F3 counts unchanged except the extended lists.
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint` plus focused pure tests; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(db): C1 schema (appointments, calendar sync, schedules, pricebook, quotes) and module skeleton`
