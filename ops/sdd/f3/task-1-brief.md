### Task 1: Dependencies, F3 schema and the module skeleton

**Split:**
- Builder 1: schema TS, the generated migration and `recordUsage`.
- Builder 2: the custom grants/RLS migration plus the `rls.test.ts` and `migrations.test.ts` updates.
- Builder 3: npm dependencies, placeholder modules and barrels.

**Files:**
- Modify:
  - `packages/db/src/schema/global.ts`, `packages/db/src/schema/tenant.ts`, `packages/db/src/schema/enums.ts`
  - `packages/db/src/index.ts`, `packages/db/src/system/index.ts`, `packages/shared/src/index.ts`
  - `apps/api/package.json`, `package-lock.json`
- Create:
  - migrations: `packages/db/migrations/0010_f3_schema.sql` (generated: `npm run db:generate -- --name f3_schema`), `packages/db/migrations/0011_f3_grants_rls.sql` (`npx drizzle-kit generate --custom --name f3_grants_rls`, run in `packages/db`), plus the meta snapshots and journal entries
  - placeholders (`export {}` unless stated):
    - `packages/db/src/repos/{setup,imports,import-apply,billing,company-location,opt-outs,delivery}.ts`
    - `packages/db/src/repos/usage.ts`, which is not a placeholder: it holds `recordUsage` below
    - `packages/db/src/system/{billing-customers,billing-events,trials,usage-fanout,texting,policy}.ts` (one file per owning task, so Lane F never shares one)
    - `packages/shared/src/{billing,texting,consent}.ts`
    - `packages/shared/src/setup.ts` and `packages/shared/src/imports.ts`, which carry the constants below
- Test: `packages/db/test/migrations.test.ts`, `packages/db/test/rls.test.ts` (extend), `packages/db/test/usage.test.ts`

**Interfaces:**
- **npm:**
  - `apps/api` dependencies: `stripe`, `csv-parse`, `exceljs`, each at the current major.
  - **No later task edits `package-lock.json`.**
- **Barrels:**
  - `packages/db/src/index.ts`: add `export * from './repos/<name>.ts'` for each new repo file.
  - `packages/db/src/system/index.ts`: add `export * from './<name>.ts'` for each new system file.
  - `packages/shared/src/index.ts`: add `export * from './<name>.ts'` for each new shared file.
- **Shared constants:**
  - `setup.ts`:
    - `SETUP_ITEM_KEYS = ['company_basics','import_customers','texting_registration','invite_team','payment_method','prices_and_tiers','connect_calendar','phone_number','connect_ads'] as const`
    - `SETUP_STATUSES = ['todo','in_progress','waiting','done','skipped'] as const`
    - the types `SetupItemKey` and `SetupStatus`
  - `imports.ts`:
    - `IMPORT_STATUSES = ['uploaded','queued','processing','done','failed'] as const`
    - `IMPORT_ROW_OUTCOMES = ['created','updated','skipped'] as const`
    - their types
- **`companies` gains:**
  - `location geometry(Point,4326)` null (`point4326('location')`)
  - `service_area_miles integer` null, CHECK in (10,20,40,60)
  - `stripe_subscription_id text` unique null
  - `billing_event_at timestamptz` null
  - `billing_period_start timestamptz` null
  - `past_due_at timestamptz` null
- **`texting_registrations` gains:**
  - `customer_profile_sid text`
  - `trust_product_sid text`
  - `brand_info jsonb`
  - `rejected_fields text[] not null default '{}'`
  - `last_checked_at timestamptz`
- **`usage_events` gains:**
  - columns `description text`, `meter_batch_id uuid`, `stripe_invoice_item_id text`
  - unique index `usage_events_ref_uniq` on `(company_id, kind, ref_type, ref_id) where ref_id is not null`
  - index `usage_events_unreported_idx` on `(company_id) where reported_to_stripe_at is null`
- **`customers` gains:**
  - `index('customers_phones_gin').using('gin', t.phones.op('jsonb_path_ops'))`
  - `index('customers_emails_gin').using('gin', t.emails)`
- **`messages` gains:** `uniqueIndex('messages_inbound_sid_uniq').on(t.companyId, t.providerMessageSid).where(sql\`${t.direction} = 'in'\`)`
- **New tenant tables**, added to `TENANT_TABLES`:
  - `setup_items`:
    - `company_id`
    - `key text` CHECK `SETUP_ITEM_KEYS`
    - `status text` CHECK `SETUP_STATUSES`, default `'todo'`
    - `data jsonb not null default '{}'`
    - timestamps
    - unique `(company_id, key)`
  - `imports`:
    - `company_id`
    - `file_name text not null`
    - `headers jsonb not null default '[]'`, `mapping jsonb not null default '{}'`, `counts jsonb not null default '{}'`
    - `row_count integer not null default 0`
    - consent: `consent_attested boolean not null default false`, `consent_text text`, `attested_by_user_id` (→ users), `attested_at timestamptz`
    - `status text` CHECK `IMPORT_STATUSES`, default `'uploaded'`
    - `error_file_url text`, `error_plain text`
    - `created_by_user_id` (→ users)
    - `started_at`, `finished_at`
    - timestamps
    - unique `(company_id, id)`, and an index `(company_id, created_at)`
  - `import_rows`:
    - `company_id`
    - `import_id uuid not null`, with a composite FK to `imports`
    - `row_number integer not null`
    - `cells jsonb not null`
    - `outcome text` CHECK `IMPORT_ROW_OUTCOMES`, null
    - `reason text`
    - `customer_id uuid`, with a composite FK to `customers`
    - timestamps
    - unique `(import_id, row_number)`, and an index `(import_id, outcome)`
  - `early_delivery_reports`:
    - `company_id`
    - `provider_message_sid text not null`
    - `status text` CHECK in (`delivered`, `failed`)
    - `reason text`
    - `received_at timestamptz not null default now()`
    - `applied_at timestamptz`
    - timestamps
    - unique `(company_id, provider_message_sid, status)`
- **`0011_f3_grants_rls.sql`:**
  - `GRANT SELECT, INSERT, UPDATE` on the 4 new tables to `app_tenant`, plus each table's ENABLE / FORCE / `tenant_isolation` block
  - `GRANT UPDATE (location, service_area_miles) ON companies TO app_tenant`
  - `GRANT SELECT (customer_profile_sid, trust_product_sid, brand_info, rejected_fields, last_checked_at) ON texting_registrations TO app_tenant`
  - `GRANT SELECT (id, company_id, kind, reported_to_stripe_at) ON usage_events TO app_system`
  - `CREATE POLICY app_system_all ON usage_events FOR ALL TO app_system USING (true) WITH CHECK (true)`
- **Produces `recordUsage`** in `repos/usage.ts`: `recordUsage(tx: Tx, ctx: TenantContext, input: NewUsage): Promise<boolean>`
  - `NewUsage = { kind: UsageKind; quantity: number; unitCostCents: number | null; refType: string; refId: string; description: string | null; at: Date }`
  - Inserts with `ON CONFLICT DO NOTHING` on `usage_events_ref_uniq`.
  - Returns true when a row was written.

- [ ] **Step 1: Write the failing tests**
  - `migrations.test.ts`:
    - `test('F3 tables are tenant tables with RLS forced')`: `setup_items`, `imports`, `import_rows` and `early_delivery_reports` each have `relrowsecurity` and `relforcerowsecurity` true.
    - `test('one inbound row per provider message per company')`:
      - Two `direction='in'` rows with SID `SM` + 32×`a` for company A → the second fails with `23505`.
      - The same SID as an outbound row succeeds.
      - The same inbound SID for company B succeeds.
    - `test('customers.phones has a jsonb_path_ops GIN index')`: the `pg_indexes.indexdef` of `customers_phones_gin` contains `gin` and `jsonb_path_ops`.
    - `test('service_area_miles accepts only 10, 20, 40 or 60')`: 25 → `23514`.
  - `rls.test.ts`: extend the expected lists in the grants tests (app_tenant relations, the companies UPDATE columns, the texting_registrations readable columns, app_system column grants, the `app_system_all` tables now including `usage_events`).
  - `usage.test.ts`: `recordUsage` with the same `(kind, refType, refId)` twice → `true`, then `false`, and one row.

- [ ] **Step 2: Run them and see them fail.** `npx vitest run --project @roofline/db`

- [ ] **Step 3: Implement.**
  - Generate `0010`.
  - Write `0011` by hand, following `0002`'s section style.
  - Run `npm install stripe csv-parse exceljs -w @roofline/api`.

- [ ] **Step 4: Run the db suite, then everything.**
  - `npx vitest run --project @roofline/db && npm run typecheck && npm run lint && npx vitest run`
  - Expected: PASS. The F1/F2 counts are unchanged except for the extended lists.

- [ ] **Step 5: Commit.** `feat(db): F3 schema (setup items, imports, billing, registration, inbound dedupe) and module skeleton`

---

