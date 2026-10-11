# Roofline F3 — Sign-up, Billing, Setup, Import and Texting Registration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a roofer sign up alone and reach the map in under 2 minutes, pay through Stripe (plan plus metered usage), work through a setup checklist, import their customers with a recorded consent confirmation, and register for texting through Twilio's ISV / A2P 10DLC flow. Close every F1 follow-up that blocks texting going live.

**Architecture:**
- **Provider seams first.** Every outside service sits behind an interface in `apps/api/src/providers/` with a deterministic fake:
  - `Geocoder`: Geocodio
  - `BillingProvider`: Stripe
  - `TextingRegistrar`: Twilio subaccounts, brand, campaign and numbers
  - `SmsAdapter`: Twilio Messaging
  
  Tests and the end-to-end stack use the fakes. The real adapters are tested against recorded responses through an injected `fetch`.
- **Skeletons before features.**
  - Task 1 lays down the database (all F3 schema in two migrations) and placeholder modules.
  - Task 9 lays down the API: config, deps, mounted routers, schedules and job queues, all pointing at stub files.
  - Task 30 lays down the web routes and slots.
  - Feature tasks then touch only their own files, so they run in parallel.
- **Company-level state that only `app_system` may write** (billing state, texting registration, phone numbers) is written from two new boundary-allowed folders:
  - `apps/api/src/account/**`: owner-only routes and services
  - `apps/api/src/public/**`: the hosted policy pages
  
  Everything else stays in `withTenant`.
- **Billing state feeds the existing send-gate `billing` rule.** The rule already blocks every status except `trial` and `active`. F3 keeps `companies.status` true from Stripe webhooks and a trial-end job, and adds a read-only API mode.
- **Long or outside work runs in pg-boss jobs.** Each job is retried with backoff:
  - import processing
  - registration progress
  - usage reporting, subaccount provisioning, the registration poll and monthly fees, which are scheduler ticks

**Tech Stack:**
- Already in the repo: Express 5, Drizzle + drizzle-kit, pg-boss 12, zod 4, Vitest 5, Testcontainers PostGIS, React 19, React Router 7, TanStack Query 5, Playwright
- New in F3:
  - the `stripe` npm package (current major at install time; inject `Stripe.createFetchHttpClient(fetch)` in tests)
  - `csv-parse` (sync API)
  - `exceljs` (reads `.xlsx`)
  - Twilio and Geocodio over plain `fetch`, with no SDK for them

**Spec:**
- `docs/superpowers/specs/2026-10-10-roofline-foundation-design.md`:
  - §5 (F3)
  - §6 errors
  - §7 testing
  - §9 owner to-dos
  - §3 for the F1 data model and rules
- `docs/superpowers/specs/2026-10-10-roofline-saas-design.md`: §9 cross-cutting rules (send gate), §10 accounts, §11 testing
- `docs/superpowers/f1-followups.md`: the section "Must be done before texting goes live (F3 blockers)". Every item there is a task below.
- `docs/superpowers/f1-decision-log.md`: binding F1 rulings (R1–R25 and the later ones). Nothing here contradicts them.
- **Branch:** `f3-setup`, stacked on `f2-shell`.

## Global Constraints

**Code and repo (from F1/F2)**
- **Language and modules:** Node ≥ 22.13, TypeScript strict, ESM. Relative imports carry explicit `.ts`/`.tsx` extensions.
- **Enum columns:** `text` with drizzle `{ enum }` plus a CHECK (`enumCheck`), never `pgEnum` (R10).
- **Tenant tables:**
  - Each has `company_id uuid not null`.
  - Each is listed in `TENANT_TABLES`.
  - Each gets `ENABLE` + `FORCE ROW LEVEL SECURITY` and the `tenant_isolation` policy, using exactly `company_id = nullif(current_setting('app.company_id', true), '')::uuid`.
  - Links between tenant tables are composite `(company_id, x_id)` foreign keys.
- **`app_system` on tenant tables:** column-level SELECT only, plus an `app_system_all` policy on each such table (the `rls.test.ts` rule).
- **`@roofline/db/system` imports:** only from `apps/api/src/{auth,hooks,jobs/scheduler,scripts,account,public}/**`, `apps/worker/**`, `packages/db/**` and tests. `account` and `public` are new in Task 9.
- **No raw query path from routes:** every tenant read and write goes through `packages/db` repos inside `withTenant`.
- **Error bodies:** `{ error: "<plain English>", field? }`. Never a stack trace, a code, a vendor message, a phone number or a message body.
- **Provider error messages:** text from a provider is never stored, shown or logged, because Twilio's messages echo phone numbers. Keep the code and the HTTP status only.
- **Message constants:** F3 keeps its plain-English messages as constants in its own modules, not in `errors.ts` `MESSAGES`.
- **Secrets:** only from env, read in `config.ts`. Never in code, never in a URL we log, never in an error.

**Billing (spec §5.1–5.2, verbatim)**
- **Trial and card:**
  - "No credit card to start: a **14-day trial** begins."
  - "Card and plan required before anything that costs money: texting registration submission, buying a phone number, ordering exact reports."
  - Checkout runs "Stripe Checkout in subscription mode". "The subscription starts with its trial ending on the company's `trial_ends_at`."
  - "Usage during the trial is billed normally; the trial covers only the monthly fee."
- **Trial ends without a card:** `status=trial_ended`. The app is read-only; the send gate blocks with rule `billing`. A banner offers "Pick a plan to keep going". Data is kept for 90 days.
- **Plans:**
  - Shape: `{key, name, monthly_price_cents, included: {ai_call_minutes, sms_segments}, overage_cents: {ai_call_minute, sms_segment}}`.
  - "Prices are business configuration set by the owner before launch. The code has no hard-coded prices."
- **Metering:**
  - "Fixed-unit usage (`ai_call_minute`, `sms_segment`; MMS counts as 3 segments) is reported to one Stripe Billing Meter per kind within 5 minutes (batched job)."
  - Metered prices use "graduated tiers, with the first tier free up to the included amount".
- **Invoice items:**
  - Exact reports: "Roofline's cost × (1 + markup % from config)".
  - Texting registration fees and phone number monthly fees: "passed through at cost".
  - Each has a plain description such as "Exact roof report — 812 Oak St".
- **Webhooks:** `POST /hooks/stripe`, signature verified. Events: subscription created, updated or deleted; invoice paid or payment failed.
- **Past-due banner, verbatim:** "Your payment didn't go through. Texts and calls are paused until it's fixed," with a button to the Stripe customer portal.
- **Billing page:** current plan, usage so far this period (by kind, with the included amount), invoices (Stripe portal link), and change plan.

**Setup checklist (spec §5.3)**
- **`setup_items` table:** `company_id`, `key`, `status (todo|in_progress|waiting|done|skipped)`, `data jsonb`, `updated_at`.
- **Keys, in order:** `company_basics`, `import_customers`, `texting_registration`, `invite_team`, `payment_method`, `prices_and_tiers`, `connect_calendar`, `phone_number`, `connect_ads`.
- **Texting waiting state:** "Waiting on phone carriers (usually 10–15 days)".
- **Later-spec items** show "Coming with [feature]". The checklist never blocks using the app; it shows as a progress ring in the user menu until complete.

**Import (spec §5.4)**
- **File:** CSV or XLSX, up to 20,000 rows, converted on the server.
- **Header synonyms:** name/first/last, phone/mobile/cell, email, address/street, city, state, zip, notes, stage.
- **Preview:**
  - the first 20 rows as they'll be saved
  - counts: new, matches an existing customer (by phone E.164 or email; updated, not duplicated), will be skipped (no name, no phone and no email, bad phone)
- **Consent text, verbatim:** "These customers agreed to receive text messages from [Company]. I understand [Company] is responsible for having their consent."
- **Box checked:** **new** customers with phones get `sms_consent_status=attested`, `source=import`, `by=user`, `at=now`, evidence `{import_id, text}`.
- **Box unchecked:** **new** customers get `express`.
- **Existing (matched) customers:**
  - never raised from `revoked`, `do_not_contact` or an `opt_outs` row
  - never lowered (`written` stays `written`, `attested` stays `attested`)
  - only `none` → `express`/`attested` and `express` → `attested`
  - `do_not_contact` is never cleared
- **Preview line:** "12 customers previously opted out, and their texting stays off".
- **Processing:** a background job, geocoded in batches. Jobs are created only when a stage column is mapped, with that stage and `source=import`. A progress bar shows while it runs; at the end there is a summary and a downloadable skipped-rows CSV.
- **Audit:** the import and the consent confirmation are written to `audit_log`.

**Texting registration (spec §5.5)**
- **Sign-up:** a subaccount is created per company, at no cost.
- **Brand info:** legal name, EIN, business type, address, website, contact name, email and phone.
- **Default use case:** "Customer care + marketing (mixed)", with sample messages from our templates.
- **Number:** one local number with voice and SMS, in the company's area code, in `company_phone_numbers` with `purpose=main`. Its monthly fee is a usage event.
- **Hosted pages:** `https://<company-slug>.<app-domain>/privacy` and `/terms`.
- **Status:** Twilio status callbacks plus a daily poll.
- **Rejection:** a plain reason plus **Fix and resubmit** with the fields highlighted.
- **Send gate:** rule order `billing, registration, contact, consent, content, dedupe, frequency, quiet_hours` (unchanged). F3 adds checks only inside `contact`.

**Errors and reliability (spec §6)**
- **Provider failures:** retried with exponential backoff, up to 5 attempts, through pg-boss.
- **After the last attempt:** a plain `error_plain` such as "Couldn't reach the texting service. We'll keep trying; you can also retry now".
- **Webhooks:** idempotent by provider event id.

**Web (F2 rules apply to every F3 screen)**
- **Strings:** every UI string lives in `apps/web/src/copy/*.ts`. No literal text in JSX. No raw `<button>`.
- **Banned whole words in copy:** `JSON`, `API`, `sandbox`, `env`, `webhook`, `null`, `undefined`, and every snake_case value of an `as const` array exported by `@roofline/shared` (F3 adds several, such as `company_basics`, `ai_call_minute` and `non_profit`). Copy objects use unquoted camelCase keys.
- **Vendor names** (`Twilio`, `Google`, `Meta`, `Facebook`, `Stripe`, `Outlook`, `Microsoft`, `EagleView`, `MapTiler`) appear only in `copy/connections.ts`, `copy/setup.ts`, `copy/auth.ts`, `copy/billing.ts` and `copy/legal.ts`.
- **Limits:**
  - at least 12px type
  - WCAG AA contrast
  - keyboard reachable
  - 40px touch targets on phone
  - no horizontal scroll at 375px
- **Feature hooks:** in `apps/web/src/features/<feature>/api.ts`, built on F2's `apiFetch`/`ApiError` (`apps/web/src/api/client.ts`) and `keys`.

**Tests (spec §7)**
- **No live provider calls in tests or CI.** Stripe, Twilio, Geocodio and Postmark go through fakes or recorded responses.
- **Stripe webhooks** are signed in tests with the test secret `whsec_test_roofline`.
- **Stripe test clocks** run only in the manual smoke suite (Task 37).
- **Playwright** runs desktop 1440×900 and phone 375×812, through F2's `apps/web/e2e/stack.ts`.

## Review Focus

These inputs and conditions are implied by the spec but not exercised by its acceptance list. Each has its test in the owning task.

1. **Spreadsheets as Excel leaves them.** Each must import correctly, with no crash and no silent loss:
   - phones stored as numbers (`4025550144`)
   - ZIPs that lost their leading zero (`2134` → `02134`)
   - date cells
   - a UTF-8 BOM, or Windows-1252 text (`Peña`)
   - blank header cells and trailing empty rows
   
   (Tasks 6, 7)
2. **Formulas in the skipped-rows download.** A cell starting with `=`, `+`, `-` or `@` is prefixed with `'`, so opening the file in Excel never runs it. (Task 23)
3. **Hostile or odd company details on the hosted policy pages.**
   - A company named `Acme <script>alert(1)</script>` renders escaped.
   - An uppercase host still matches.
   - An unknown slug gets a plain 404 page.
   
   (Task 17)
4. **Stripe events twice or out of order.**
   - A replayed event changes nothing.
   - An older `customer.subscription.updated` arriving after a newer one is ignored.
   - `invoice.paid` clears `past_due` but never reactivates a canceled company.
   
   (Task 20)
5. **Double clicks and two tabs.**
   - Import started twice: one job, one set of customers.
   - Registration submitted twice: one submission, one brand fee.
   - Checkout clicked twice: one Stripe customer.
   
   (Tasks 19, 23, 24, 27)

## Parallel lanes

F2 is being built at the same time. "Needs F2" names the F2 tasks that must be merged into `f2-shell` (and then into `f3-setup`) first. A dash means the task needs nothing beyond what is on `f2-shell` today (F2 Tasks 1–4).

| Task | Depends on (F3) | Needs F2 |
|---|---|---|
| 1 Dependencies, F3 schema, module skeleton | — | — |
| 2 Database deploy hardening | — | — |
| 3 Shared billing config and metering math | 1 | — |
| 4 Shared setup checklist rules | 1 | — |
| 5 Shared texting registration details | 1 | — |
| 6 Import parsing and column auto-mapping | 1 | — |
| 7 Import normalizing, consent and plan | 6 | — |
| 8 Send gate: textable numbers, refusal kinds | — | — |
| 9 API skeleton | 1, 3, 5 | T6, T7, T8, T9 |
| 10 Inbound texts hardening | 1 | — |
| 11 Delivery reports | 10 | — |
| 12 Lease heartbeat | — | — |
| 13 Twilio sending | 8, 9, 11, 12 | (via 9) |
| 14 Geocodio geocoder | 9 | (via 9) |
| 15 Sign-up with company details | 9 | (via 9) |
| 16 Setup checklist API | 4, 9 | (via 9) |
| 17 Hosted privacy and terms pages | 9 | (via 9) |
| 18 Stripe adapter and plan sync | 3, 9 | (via 9) |
| 19 Billing API | 3, 9 | (via 9) |
| 20 Stripe webhooks | 3, 9 | (via 9) |
| 21 Trial end and read-only mode | 9 | (via 9) |
| 22 Usage reporting | 3, 9 | (via 9) |
| 23 Import API | 7, 9 | (via 9) |
| 24 Import job | 23 | (via 9) |
| 25 Twilio accounts and numbers | 13 | (via 9) |
| 26 Twilio business profile, brand, campaign | 5, 13 | (via 9) |
| 27 Texting provisioning and submit | 5, 9, 17 | (via 9) |
| 28 Registration progress | 25, 26, 27 | (via 9) |
| 29 Design kit additions | — | T5 |
| 30 Web skeleton | — | T10, T12, T16, T17 |
| 31 Web: sign-up | 29, 30 | (via 30) |
| 32 Web: Setup window | 4, 29, 30 | (via 30) |
| 33 Web: Billing tab and banners | 3, 29, 30 | (via 30) |
| 34 Web: import wizard | 6, 7, 29, 30 | (via 30) |
| 35 Web: texting registration | 5, 29, 30 | (via 30) |
| 36 End-to-end tests and docs | 13–35 | T13, T17 |
| 37 Manual smoke suite | 18, 25, 26 | (via 9) |

**Lanes that run at the same time:**
- **Lane A, database (start now):** 1 and 2 in parallel.
- **Lane B, shared rules (after 1):** 3, 4, 5 and 6 in parallel; then 7 (after 6).
- **Lane C, texting go-live (the F1 blockers):**
  - 8 and 12 start now.
  - 10 starts after 1; then 11.
  - 13 waits for 8, 9, 11 and 12.
  - Then 25 and 26 in parallel.
- **Lane D, API skeleton:** 9, after 1, 3 and 5 and F2 T6–T9. F2's four API tasks all edit `app.ts`, `config.ts`, `deps.ts`, `index.ts` or `test/helpers.ts`, which Task 9 rewires.
- **Lane E, sign-up, setup and policy (after 9):** 14, 15, 16 and 17 in parallel.
- **Lane F, billing (after 9 and 3):** 18, 19, 20, 21 and 22 in parallel. Each has its own `system/*.ts` file.
- **Lane G, import:** 23 (after 7 and 9), then 24.
- **Lane H, registration:** 27 (after 9 and 17), then 28 (also after 25 and 26, for the recorded-answers test).
- **Lane I, web:**
  - 29 after F2 T5.
  - 30 after F2 T10/T12/T16/T17.
  - Then 31–35 in parallel. They need only the shared types, not the API tasks, because their unit tests stub `fetch`.
- **Lane J, finish:** 36 after everything; 37 after 18, 25 and 26.

**Shared files.** The only files two lanes may both touch are the barrel files (`packages/db/src/index.ts`, `packages/db/src/system/index.ts`), which F2 Tasks 6, 7 and 9 also append to. A conflict there is resolved by keeping both export lines. Every other shared hotspot is pre-cut by a skeleton task:
- Task 1: migrations, the lockfile and the F3 barrel lines
- Task 9: `app.ts`, `config.ts`, `deps.ts`, `worker.ts`, the provider factories, `.env.example` and the README env table
- Task 30: `router.tsx`, `Settings.tsx`, `Shell.tsx` and `UserMenu.tsx`

Tasks that edit the same file are chained in the table: 10 → 11 → 13 (`hooks/twilio.ts`, `messages.ts`), 12 → 13 (`send-batch.ts`) and 27 → 28 (`system/texting.ts`).

---

## File structure

```
config/billing-plans.example.json          example plan config (dev/test only)          T3
packages/shared/src/
  billing.ts   setup.ts   texting.ts   imports.ts   consent.ts   (new)                  T1 placeholders → T3–T7
  phone.ts (textability)                                                                T8
packages/send-gate/src/adapter.ts decide.ts (refusal kinds, textable contact rule)      T8
packages/db/
  migrations/0010_f3_schema.sql  0011_f3_grants_rls.sql                                 T1
  src/schema/global.ts tenant.ts enums.ts                                               T1
  src/repos/ setup.ts imports.ts import-apply.ts usage.ts billing.ts company-location.ts opt-outs.ts delivery.ts
  src/system/ billing-customers.ts (T19) billing-events.ts (T20) trials.ts (T21) usage-fanout.ts (T22) texting.ts (T27/T28) policy.ts (T17)
  src/migrate.ts  src/preflight.ts  scripts/preflight.ts                                T2
apps/api/src/
  providers/ geocoder.ts billing.ts registrar.ts sms.ts fakes/{geocoder,billing,registrar}.ts   T9
  providers/ geocodio.ts (T14) stripe.ts (T18) twilio/{http,sms}.ts (T13) twilio/accounts.ts (T25) twilio/brands.ts (T26)
  jobs/queue.ts jobs/handlers.ts jobs/scheduler/{end-trials,report-usage,provision-texting,poll-texting,bill-monthly-fees}.ts
  billing/ plans.ts guards.ts (T9) read-only.ts (T21) stripe-signature.ts stripe-events.ts (T20)
  company/location.ts                                                                   T15
  imports/ parse.ts mapping.ts normalize.ts plan.ts preview.ts skipped-csv.ts run.ts
  account/ billing-routes.ts setup-routes.ts texting-routes.ts texting/{advance,progress,view}.ts
  public/ policies.ts policy-text.ts policy-urls.ts
  hooks/ stripe.ts twilio-registration.ts (twilio.ts modified)
  routes/imports.ts
  scripts/ sync-stripe-plans.ts smoke/{stripe-test-clock,texting-real-brand,guards}.ts
apps/web/src/
  features/signup/  features/setup/  features/billing/  features/imports/  features/texting/
  copy/ auth.ts setup.ts billing.ts (extended)  import.ts texting.ts (new)
packages/ui/src/components/{Checkbox,ProgressBar,ProgressRing,FilePicker,Banner}/         T29
apps/web/e2e/ signup.spec.ts setup.spec.ts import.spec.ts billing.spec.ts fixtures/customers-25.csv
docs/superpowers/ f3-acceptance.md f3-manual-smoke.md
```

---

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

### Task 2: Database deploy hardening (extensions in public, the Data API exposure, preflight)

**Split:**
- Builder 1: `migrate.ts` post-steps.
- Builder 2: `preflight.ts`, the script and the README.
- Builder 3: `hardening.test.ts`.

**Files:**
- Modify: `packages/db/src/migrate.ts`, `packages/db/package.json` (script `preflight`), root `package.json` (script `db:preflight`), `README.md` ("Boot order" and "Database host" only)
- Create: `packages/db/src/preflight.ts`, `packages/db/scripts/preflight.ts`
- Test: `packages/db/test/hardening.test.ts`

**Interfaces:**
- **`migrate(ownerUrl)` gains a pre-step and a post-step.**
  - Before migrating, `ensureExtensionsInPublic(client)`:
    - When `citext` exists in another schema → `ALTER EXTENSION citext SET SCHEMA public`.
    - When `postgis` exists in another schema → throw `ExtensionSchemaError` with the message `postgis is installed in schema "<ns>". Roofline needs it in public: drop it there and let the migration install it, or enable it for the public schema in your database host's settings.`
  - After migrating, the same check, then `revokeDataApiExposure(client)`. For each of `anon` and `authenticated` that exists as a role:
    - `REVOKE ALL ON ALL TABLES|SEQUENCES|FUNCTIONS IN SCHEMA public FROM <r>`
    - the same in schema `pgboss`
    - `REVOKE USAGE ON SCHEMA public FROM <r>`
    - `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES|SEQUENCES|FUNCTIONS FROM <r>`
  - Both steps are idempotent and run on every migrate, so tables added by any later migration are covered.
- **`preflight(ownerUrl: string): Promise<{ ok: boolean; problems: string[] }>`** checks:
  - `citext` and `postgis` are in `public`
  - neither `anon` nor `authenticated` holds SELECT, INSERT, UPDATE or DELETE on any relation in `public` or `pgboss` (`has_table_privilege`)
  - `app_tenant` and `app_system` are neither superuser nor `BYPASSRLS`
  - every `TENANT_TABLES` table has RLS forced
- **Problem lines** (exact formats):
  - `<ext> is in schema <ns>, not public`
  - `<role> can read <schema>.<table>`
  - `<role> can write <schema>.<table>`
  - `<role> bypasses row-level security`
  - `<role> is a superuser`
  - `<table> does not force row-level security`
- **`npm run db:preflight`** prints each problem as a plain line and exits 1 on any, or prints `Preflight passed.`
- **README:**
  - Boot order gains step "2a. `DATABASE_URL_OWNER=… npm run db:preflight`".
  - The "Database host" bullets say that migrate moves `citext` into `public`, stops on a misplaced `postgis`, and revokes Supabase's `anon`/`authenticated` grants.

- [ ] **Step 1: Write the failing tests** (`hardening.test.ts`, on the shared container through the owner URL)
  - `test('a Supabase-like database is cleaned up by migrate')`:
    - `create database supa_sim`
    - in it:
      - `create role anon nologin` and `create role authenticated nologin` when missing
      - `alter default privileges in schema public grant all on tables to anon, authenticated`
      - `create schema extensions; create extension citext schema extensions`
    - Then `migrate(urlFor('supa_sim'))`.
    - Expect:
      - `citext`'s namespace is `public`
      - `has_table_privilege('anon','public.users','SELECT')` is false
      - the same for `public.sessions` and `authenticated`
      - `preflight(url)` → `{ ok: true, problems: [] }`
    - Drop the database, then the roles.
  - `test('postgis in another schema stops migrate with a plain reason')`: a database with `create extension postgis schema extensions` → `migrate` rejects with a message containing `postgis is installed in schema "extensions"`.
  - `test('preflight names what is wrong')`: grant `select on users to anon` after migrating → `problems` contains `anon can read public.users`.

- [ ] **Step 2: Run them and see them fail.** `npx vitest run --project @roofline/db hardening`

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the db suite.** `npx vitest run --project @roofline/db && npm run lint`. Expected: PASS.

- [ ] **Step 5: Commit.** `fix(db): keep extensions in public, revoke the Data API grants, add a deploy preflight`

---

### Task 3: Shared billing config and metering math

**Split:**
- Builder 1: the schema and loader.
- Builder 2: the metering and amount functions.
- Builder 3: the example config, the no-hard-coded-prices scan and the `USAGE_KINDS` move.

**Files:**
- Create: `config/billing-plans.example.json`
- Modify: `packages/shared/src/billing.ts`, `packages/db/src/schema/enums.ts` (move `USAGE_KINDS` to shared and re-export it, as Task 10 of F1 did for other enums)
- Test: `packages/shared/test/billing.test.ts`

**Interfaces:**
- **Config types**, keys exactly as spec §5.2:
```ts
export const USAGE_KINDS = ['ai_call_minute','sms_segment','mms','exact_report','texting_registration_fee','phone_number_month'] as const;
export const METERS = ['ai_call_minute', 'sms_segment'] as const;           export type Meter = (typeof METERS)[number];
export const INVOICE_KINDS = ['exact_report', 'texting_registration_fee', 'phone_number_month'] as const;
export const METER_EVENT_NAME: Record<Meter, string> = { ai_call_minute: 'roofline_ai_call_minute', sms_segment: 'roofline_sms_segment' };
export type PlanConfig = { key: string; name: string; monthly_price_cents: number;
  included: { ai_call_minutes: number; sms_segments: number }; overage_cents: { ai_call_minute: number; sms_segment: number } };
export type BillingConfig = { plans: PlanConfig[]; exact_report_markup_pct: number;
  pass_through_cents: { brand_registration: number; campaign_vetting: number; campaign_monthly: number; phone_number_monthly: number } };
export class BillingConfigError extends Error {}
export function parseBillingConfig(json: unknown): BillingConfig;     // zod; issues listed as "path: problem"
export function planByKey(config: BillingConfig, key: string): PlanConfig | null;
export function priceLookupKeys(planKey: string): { monthly: string; ai_call_minute: string; sms_segment: string };
export function planFromLookupKey(lookupKey: string): string | null;
export function meteredTiers(plan: PlanConfig, meter: Meter): { up_to: number | 'inf'; unit_amount_decimal: string }[];
export function meterUnits(kind: UsageKind, quantity: number): { meter: Meter; value: number } | null;
export function invoiceAmountCents(kind: UsageKind, quantity: number, unitCostCents: number, config: BillingConfig): number;
```
- **Views:**
```ts
export type PlanSummary = { key: string; name: string; monthlyPriceCents: number;
  included: { aiCallMinutes: number; smsSegments: number }; overageCents: { aiCallMinute: number; smsSegment: number } };
export type BillingView = { status: CompanyStatus; planKey: string | null; planName: string | null; trialEndsAt: string | null;
  hasPaymentMethod: boolean; canOpenPortal: boolean; periodStart: string;
  usage: { meter: Meter; used: number; included: number | null }[]; plans: PlanSummary[] };
```
- **Rules:**
  - Plan keys match `/^[a-z][a-z0-9]{1,30}$/` and are unique.
  - Every amount is a whole number ≥ 0.
  - `exact_report_markup_pct` is 0–500.
  - An optional top-level `_note` string is allowed.
- **Lookup keys:** `roofline_<key>_monthly`, `roofline_<key>_ai_call_minute` and `roofline_<key>_sms_segment`.
- **`meteredTiers`:**
  - Normally `[{ up_to: included, unit_amount_decimal: '0' }, { up_to: 'inf', unit_amount_decimal: String(overage) }]`.
  - When the included amount is 0, only the second tier.
- **`meterUnits`:**
  - `sms_segment` → `{sms_segment, ceil(q)}`
  - `mms` → `{sms_segment, 3 × ceil(q)}`
  - `ai_call_minute` → `{ai_call_minute, ceil(q)}`
  - any other kind → null
- **`invoiceAmountCents`:**
  - `exact_report` → `Math.round(q × unit × (100 + markup) / 100)`
  - the other invoice kinds → `Math.round(q × unit)`
  - a metered kind → `RangeError`
- **Example file:** the JSON below, verbatim.
```json
{ "_note": "Example values for development and tests only. The owner sets real prices in the file BILLING_PLANS_FILE points to.",
  "plans": [
    { "key": "starter", "name": "Starter", "monthly_price_cents": 19900,
      "included": { "ai_call_minutes": 300, "sms_segments": 1000 }, "overage_cents": { "ai_call_minute": 25, "sms_segment": 3 } },
    { "key": "pro", "name": "Pro", "monthly_price_cents": 39900,
      "included": { "ai_call_minutes": 1000, "sms_segments": 5000 }, "overage_cents": { "ai_call_minute": 20, "sms_segment": 2 } } ],
  "exact_report_markup_pct": 20,
  "pass_through_cents": { "brand_registration": 4400, "campaign_vetting": 1500, "campaign_monthly": 1000, "phone_number_monthly": 115 } }
```

- [ ] **Step 1: Write the failing tests** (`billing.test.ts`)
```ts
const cfg = parseBillingConfig(JSON.parse(readFileSync(EXAMPLE, 'utf8')));
expect(cfg.plans.map((p) => p.key)).toEqual(['starter', 'pro']);
expect(meterUnits('mms', 1)).toEqual({ meter: 'sms_segment', value: 3 });
expect(meterUnits('sms_segment', 2)).toEqual({ meter: 'sms_segment', value: 2 });
expect(meterUnits('ai_call_minute', 2.2)).toEqual({ meter: 'ai_call_minute', value: 3 });
expect(meterUnits('exact_report', 1)).toBeNull();
expect(invoiceAmountCents('exact_report', 1, 4500, cfg)).toBe(5400);
expect(invoiceAmountCents('texting_registration_fee', 1, 4400, cfg)).toBe(4400);
expect(invoiceAmountCents('phone_number_month', 1, 115, cfg)).toBe(115);
expect(() => invoiceAmountCents('sms_segment', 1, 1, cfg)).toThrow(RangeError);
expect(meteredTiers(planByKey(cfg, 'starter')!, 'sms_segment')).toEqual([{ up_to: 1000, unit_amount_decimal: '0' }, { up_to: 'inf', unit_amount_decimal: '3' }]);
expect(priceLookupKeys('pro').monthly).toBe('roofline_pro_monthly');
expect(planFromLookupKey('roofline_pro_sms_segment')).toBe('pro');
```
  - `it('refuses bad config with the path')`: duplicate keys, `monthly_price_cents: -1` and a missing `included` each throw `BillingConfigError` whose message names the path, for example `plans.0.monthly_price_cents`.
  - `it('the code has no hard-coded prices')`: walk `apps/**/src` and `packages/**/src`. No file contains `19900` or `39900`.

- [ ] **Step 2: Run them and see them fail.** `npx vitest run --project @roofline/shared billing`

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the tests.** `npx vitest run --project @roofline/shared && npx vitest run --project @roofline/db && npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit.** `feat(shared): billing plan config, meters and invoice amounts`

---

### Task 4: Shared setup checklist rules

**Split:** one builder for the rules and one for the tests.

**Files:**
- Modify: `packages/shared/src/setup.ts`
- Test: `packages/shared/test/setup.test.ts`

**Interfaces:**
```ts
export const COMING_WITH = ['estimator', 'calendar', 'front_desk', 'storm_scout'] as const; export type ComingWith = (typeof COMING_WITH)[number];
export const FOUNDATION_ITEMS: readonly SetupItemKey[] = ['company_basics','import_customers','texting_registration','invite_team','payment_method'];
export const SKIPPABLE: ReadonlySet<SetupItemKey> = new Set(['import_customers', 'invite_team']);
export type SetupFacts = { addressSaved: boolean; located: boolean; serviceArea: boolean;
  imports: { done: number; running: number };
  texting: { campaignStatus: CampaignStatus; rejectionReason: string | null; rejectedFields: string[] };
  activeMembers: number; pendingInvites: number; paymentMethod: boolean; skipped: ReadonlySet<SetupItemKey> };
export type SetupItemView = { key: SetupItemKey; status: SetupStatus; comingWith: ComingWith | null; skippable: boolean; data: Record<string, unknown> };
export type SetupView = { items: SetupItemView[]; progress: { done: number; total: number } };
export function deriveSetup(facts: SetupFacts): SetupView;
```
- **Rules,** in `SETUP_ITEM_KEYS` order. A real `done` always beats a stored skip.
  - **`company_basics`:**
    - `done` when `located && serviceArea`
    - `in_progress` when `addressSaved && !located`
    - else `todo`
    - `data {located, serviceArea}`
  - **`import_customers`:**
    - `done` when `imports.done > 0`
    - else `in_progress` when `imports.running > 0`
    - else `skipped` when skipped
    - else `todo`
  - **`texting_registration`:**
    - `done` when `approved`
    - `waiting` when `pending`
    - `todo` with `data {rejected: true, reason, fields}` when `rejected`
    - else `todo`
  - **`invite_team`:**
    - `done` when `activeMembers >= 2`
    - else `in_progress` when `pendingInvites > 0`
    - else `skipped` when skipped
    - else `todo`
  - **`payment_method`:** `done` when `paymentMethod`, else `todo`.
  - **Later-spec items** are `todo` with `comingWith`:
    - `prices_and_tiers` → `estimator`
    - `connect_calendar` → `calendar`
    - `phone_number` → `front_desk`
    - `connect_ads` → `storm_scout`
  - **Progress:** `total: 5` (the `FOUNDATION_ITEMS`). `done` counts the Foundation items that are `done` or `skipped`.

- [ ] **Step 1: Write the failing tests**
  - `it('a brand-new company has everything to do')`: all-false facts → nine items in key order, five Foundation `todo`, four with `comingWith`, and `progress {done:0,total:5}`.
  - `it('a located company with a card and a teammate')` → three `done`, and `progress {done:3,total:5}`.
  - `it('waiting on carriers, and a rejection with its reason')`:
    - `pending` → `waiting`
    - `rejected` with reason "R" and fields `['ein']` → `{status:'todo', data:{rejected:true, reason:'R', fields:['ein']}}`
  - `it('skips only what may be skipped, and done beats skipped')`:
    - a skipped import with `imports.done:1` → `done`
    - `skippable` is true only for the two keys
  - `it('invites pending is started')`.

- [ ] **Step 2: Run them and see them fail.** `npx vitest run --project @roofline/shared setup`

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the tests.** `npx vitest run --project @roofline/shared`. Expected: PASS.

- [ ] **Step 5: Commit.** `feat(shared): setup checklist rules`

---

### Task 5: Shared texting registration details (brand fields, campaign text, rejection reasons, view)

**Split:**
- Builder 1: the schema and field messages.
- Builder 2: `buildCampaign` and `plainRejection`.
- Builder 3: the tests.

**Files:**
- Modify: `packages/shared/src/texting.ts`
- Test: `packages/shared/test/texting.test.ts`

**Interfaces:**
```ts
export const BUSINESS_TYPES = ['llc', 'corporation', 'partnership', 'non_profit'] as const;
export const BRAND_FIELDS = ['legalName','ein','businessType','street','city','state','zip','website',
  'contactFirstName','contactLastName','contactEmail','contactPhone','contactTitle'] as const; export type BrandField = (typeof BRAND_FIELDS)[number];
export const BrandInfoSchema: z.ZodType<BrandInfo>;   // BrandInfo = Record<BrandField, string> with businessType narrowed
export type CampaignInfo = { useCase: 'MIXED'; description: string; messageFlow: string; samples: string[];
  optInMessage: string; optOutMessage: string; helpMessage: string; privacyUrl: string; termsUrl: string;
  hasEmbeddedLinks: true; hasEmbeddedPhone: true };
export const USE_CASE_LABEL = 'Customer care + marketing (mixed)';
export function buildCampaign(input: { companyName: string; companyPhone: string | null; privacyUrl: string; termsUrl: string }): CampaignInfo;
export function plainRejection(failureText: string | null): { reason: string; fields: BrandField[] };
export const TEXTING_STATES = ['not_started', 'waiting', 'approved', 'needs_fix'] as const;
export type TextingView = { state: TextingState; reason: string | null; rejectedFields: BrandField[]; brand: BrandInfo | null;
  defaults: Partial<BrandInfo>; submittedAt: string | null; approvedAt: string | null; number: string | null;
  needsPaymentMethod: boolean; needsVerifiedEmail: boolean; hostedPolicyUrls: { privacy: string; terms: string } };
```
- **Field rules and messages** (`BrandInfoSchema`; each error carries its field path):
  - `legalName`: 2–120 characters → "Enter the legal name on your IRS paperwork."
  - `ein`: `/^\d{2}-?\d{7}$/`, normalized to `12-3456789` → "Enter your 9-digit EIN, like 12-3456789."
  - `businessType`: one of `BUSINESS_TYPES` → "Pick your business type."
  - `street` ≤ 120 and `city` ≤ 60, non-empty → "Enter your business address."
  - `state`: one of the 50 states or DC, uppercased → "Please use the 2-letter state, like NE."
  - `zip`: 5 digits → "Please enter a ZIP code, like 68102."
  - `website`: http(s) URL; a bare `acme.com` becomes `https://acme.com` → "Enter your website, like https://acme.com."
  - `contactFirstName`, `contactLastName` and `contactTitle`: 1–60 characters → "Please fill this in."
  - `contactEmail`: an email address → "Please enter a valid email address."
  - `contactPhone`: through `toE164` → "That doesn't look like a US phone number."
- **Campaign text,** with `N` the company name:
  - `description`: `${N} texts its roofing customers about appointments, estimates and job updates, and sends storm check-ins offering free roof inspections.`
  - `messageFlow`: `Customers give ${N} their mobile number by phone, in person or on a web form, and agree to receive texts. Customers imported from ${N}'s records were confirmed by the business owner to have agreed. Privacy policy: ${privacyUrl}. Terms: ${termsUrl}.`
  - `samples`:
    1. `Hi Maria, it's ${N}. Your roof inspection is confirmed for Tuesday at 10:00 AM. Reply STOP to opt out.`
    2. `Hi Maria, it's ${N}. Tuesday's hail hit your street. Want a free roof check this week? Reply YES to book. Reply STOP to opt out.`
  - `optInMessage`: `${N}: You're signed up for texts about your roof and storm check-ins. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to opt out.`
  - `optOutMessage`: `You're unsubscribed from ${N} texts. No more messages will be sent. Reply START to resubscribe.`
  - `helpMessage`: `${N}: for help call ${(402) 555-0199 | "us"}. Msg & data rates may apply. Reply STOP to opt out.`
- **`plainRejection`,** with the first match in this order:
  1. `/\b(ein|tax|irs|tin)\b/i` → `['legalName','ein']`, "The phone carriers couldn't match your legal name and EIN with IRS records. Use the exact name on your IRS EIN letter."
  2. `/website|url|privacy|domain/i` → `['website']`, "The phone carriers couldn't check your website. It needs to show your business name and a privacy policy (you can use the Roofline page)."
  3. `/address/i` → `['street','city','state','zip']`, "The phone carriers couldn't confirm your business address. Use the address on your tax records."
  4. `/email/i` → `['contactEmail']`, "Use an email address at your business's own website if you have one."
  5. `/phone/i` → `['contactPhone']`, "Check the contact phone number."
  6. `/opt.?in|consent|sample|message flow/i` → `[]`, "The phone carriers asked for clearer details on how customers agree to texts. We've updated them, so send it again."
  7. Anything else (null included) → `[]`, "The phone carriers turned this down. Check your details and send it again."

- [ ] **Step 1: Write the failing tests**
  - Schema:
    - a full valid brand parses, and `ein '123456789'` becomes `'12-3456789'`
    - `ein '12-34'` → issue path `['ein']` with the EIN message
    - `website 'acme.com'` → `'https://acme.com'`
    - `state 'Nebraska'` → the state message
  - `buildCampaign({companyName:'Acme Roofing', companyPhone:'+14025550199', privacyUrl:'P', termsUrl:'T'})`:
    - `samples[1]` equals the exact string above with Acme Roofing
    - `helpMessage` contains `(402) 555-0199`
    - `useCase` is `'MIXED'`
  - `plainRejection`:
    - `'EIN does not match IRS'` → fields `['legalName','ein']`
    - `'Website not accessible'` → `['website']`
    - `null` → the fallback with `[]`
    - `'Tax ID and website'` → the EIN rule (first match wins)

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the tests.** `npx vitest run --project @roofline/shared`. Expected: PASS.

- [ ] **Step 5: Commit.** `feat(shared): texting registration fields, campaign text and plain rejection reasons`

---

### Task 6: Import files: parsing and column auto-mapping

**Split:**
- Builder 1: `parse.ts` (CSV and XLSX).
- Builder 2: `mapping.ts`, plus the shared import types.
- Builder 3: the tests and the XLSX built inside the test.

**Files:**
- Create: `apps/api/src/imports/parse.ts`, `apps/api/src/imports/mapping.ts`
- Modify: `packages/shared/src/imports.ts`
- Test: `apps/api/test/import-parse.test.ts`, `apps/api/test/import-mapping.test.ts`

**Interfaces:**
- **Shared:**
```ts
export const IMPORT_FIELDS = ['name','firstName','lastName','phone','phone2','email','street','city','state','zip','notes','stage'] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
export type ImportMapping = Partial<Record<ImportField, number>>;     // column index
export const SKIP_KEYS = ['noName', 'noContact', 'badPhone', 'duplicate'] as const; export type SkipKey = (typeof SKIP_KEYS)[number];
export type ImportCounts = { total: number; new: number; updated: number; skipped: number; skippedBy: Record<SkipKey, number>;
  consent: { attested: number; express: number; unchanged: number; optedOutKept: number };
  jobs: number; processed: number; located: number; notLocated: number };
export type ImportPreviewRow = { row: number; outcome: 'create' | 'update' | 'skip'; reason: string | null; name: string | null;
  phone: string | null; email: string | null; address: string | null; stage: JobStage | null; consent: ConsentStatus | null };
export type ImportView = { id: string; fileName: string; status: ImportStatus; headers: string[]; mapping: ImportMapping; rowCount: number;
  counts: ImportCounts; preview: ImportPreviewRow[]; progress: { processed: number; total: number }; consentAttested: boolean;
  startedAt: string | null; finishedAt: string | null; errorPlain: string | null; skippedDownloadUrl: string | null };
export const MAX_IMPORT_ROWS = 20_000;
```
- **API:**
```ts
export type ParsedFile = { headers: string[]; rows: string[][] };
export class ImportFileError extends Error {}               // message is shown as is
export async function parseUpload(bytes: Buffer, fileName: string): Promise<ParsedFile>;
export function normalizeHeader(header: string): string;
export const HEADER_SYNONYMS: Record<ImportField, readonly string[]>;
export function autoMap(headers: readonly string[]): ImportMapping;
```
- **Parsing:**
  - Choose by the extension of `fileName`, case-insensitive:
    - `.csv` → `csv-parse/sync` with `bom: true, relax_column_count: true, skip_empty_lines: true`
    - `.xlsx` → `exceljs`, first worksheet
    - anything else → "Please upload a .csv or .xlsx file."
  - **Encoding:** decode as UTF-8 with `fatal: true`; on failure decode as `windows-1252`.
  - **Cells:** every cell becomes a trimmed string.
    - An XLSX number becomes its integer or plain decimal text, never exponent form.
    - An XLSX date becomes `YYYY-MM-DD`.
  - **Rows:** padded or cut to the header length. Rows that are entirely blank are dropped.
  - **Headers:** a blank header becomes `Column <n>` (1-based).
  - **Limits:**
    - 0 data rows → "This file has no rows."
    - more than `MAX_IMPORT_ROWS` → "This file has more than 20,000 rows. Split it into smaller files and import each one."
  - **Unreadable XLSX** → "We couldn't read this spreadsheet. Save it as .csv and try again."
- **`normalizeHeader`:** lowercase, every character other than `a-z0-9` becomes a space, spaces collapse, then trim.
- **`HEADER_SYNONYMS`** (normalized):
  - **name:** name, full name, customer, customer name, client, client name, contact, contact name
  - **firstName:** first, first name, firstname, fname, given name
  - **lastName:** last, last name, lastname, lname, surname, family name
  - **phone:** phone, phone number, mobile, mobile phone, cell, cell phone, cellphone, telephone, tel, primary phone, home phone
  - **phone2:** phone 2, alt phone, other phone, work phone, secondary phone
  - **email:** email, e mail, email address, mail
  - **street:** address, street, street address, address 1, address line 1, address1, property address
  - **city:** city, town
  - **state:** state, st, province
  - **zip:** zip, zip code, zipcode, postal code, postcode
  - **notes:** notes, note, comments, comment, description
  - **stage:** stage, status, pipeline stage, job stage, deal stage
- **`autoMap`:** each field takes the first column whose normalized header is one of its synonyms. Each column is used at most once. When `home phone` is matched while `phone` is already taken, it goes to `phone2`.

- [ ] **Step 1: Write the failing tests**
  - `import-parse.test.ts`:
    - `it('reads a CSV with a BOM, CRLF, quoted commas and trailing blank rows')` → headers and rows exact.
    - `it('reads Windows-1252 text')`: the bytes of `Name\r\nPe\xf1a` → the row `['Peña']`.
    - `it('reads an xlsx built in the test')`: exceljs workbook with phone cell `4025550144` (number), zip cell `2134` (number) and date cell `2026-10-11` → `['4025550144','2134','2026-10-11']`.
    - `it('names blank headers')` → `Column 3`.
    - `it('refuses other files, empty files and more than 20,000 rows')`: each exact message.
  - `import-mapping.test.ts`:
    - `autoMap([' Customer Name ','CELL','E-Mail','Street Address','city','ST','Zip Code','Notes'])` → `{name:0, phone:1, email:2, street:3, city:4, state:5, zip:6, notes:7}`
    - `['First','Last','Mobile','Home Phone','Status']` → `{firstName:0,lastName:1,phone:2,phone2:3,stage:4}`
    - unknown headers stay unmapped

- [ ] **Step 2: Run them and see them fail.** `npx vitest run --project @roofline/api import-parse import-mapping`

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the tests and typecheck.** Expected: PASS.

- [ ] **Step 5: Commit.** `feat(import): read CSV and Excel uploads and match their columns`

---

### Task 7: Import rows: normalizing, consent and the import plan

**Split:**
- Builder 1: `normalize.ts`.
- Builder 2: `consent.ts` (shared) and `plan.ts`.
- Builder 3: the 1,000-row fixture builder and the tests.

**Files:**
- Create: `apps/api/src/imports/normalize.ts`, `apps/api/src/imports/plan.ts`, `apps/api/test/fixtures/import-1000.ts`
- Modify: `packages/shared/src/consent.ts`
- Test: `apps/api/test/import-plan.test.ts`, `packages/shared/test/consent.test.ts`

**Interfaces:**
- **Shared consent:**
```ts
export function consentAttestationText(companyName: string): string;
// `These customers agreed to receive text messages from ${companyName}. I understand ${companyName} is responsible for having their consent.`
export type ExistingConsent = { status: ConsentStatus; doNotContact: boolean; optedOut: boolean };
export function importConsent(existing: ExistingConsent | null, hasPhone: boolean, attested: boolean): ConsentStatus;
```
  - `importConsent` rules:
    - **New customer:** no phone → `none`; attested → `attested`; else `express`.
    - **Existing customer:**
      - `revoked`, `doNotContact` or `optedOut` → their status unchanged
      - `written` or `attested` → unchanged
      - `none` → `attested`/`express`
      - `express` → `attested` when attested, else `express`
- **API:**
```ts
export type NormalizedRow = { displayName: string; firstName: string | null; lastName: string | null; phones: string[]; emails: string[];
  address: { addressLine: string; city: string; state: string; zip: string } | null; notes: string | null; stage: JobStage | null };
export type RowSkip = { skip: Exclude<SkipKey, 'duplicate'> };
export function normalizeRow(cells: readonly string[], mapping: ImportMapping): NormalizedRow | RowSkip;
export function normalizeState(value: string): string | null;     // 'Nebraska'|'ne'|'NE.' → 'NE'
export function normalizeZip(value: string): string | null;       // '2134' → '02134', '68102-1234' → '68102'
export function normalizeStage(value: string): JobStage | null;   // '' → null
export type ExistingCustomer = ExistingConsent & { id: string };
export type ExistingIndex = { byPhone: ReadonlyMap<string, ExistingCustomer>; byEmail: ReadonlyMap<string, ExistingCustomer> };
export type PlannedRow = { row: number; outcome: 'create' | 'update' | 'skip'; skipKey: SkipKey | null; reason: string | null;
  matchId: string | null; consent: ConsentStatus | null; consentChanged: boolean; normalized: NormalizedRow | null };
export type ImportPlan = { rows: PlannedRow[]; counts: ImportCounts };
export function planImport(rows: readonly (NormalizedRow | RowSkip)[], existing: ExistingIndex, attested: boolean): ImportPlan;
export function previewRows(plan: ImportPlan, limit = 20): ImportPreviewRow[];
```
- **Normalizing:**
  - **Name:** `displayName` is the name column, else `first + ' ' + last`, trimmed. With only a name, `firstName` is its first word and `lastName` the rest.
  - **Phones:** each through `toE164`.
  - **Emails:** lowercase. One without `@` and a dot after it is dropped.
  - **Skips:**
    - a blank name → `noName`
    - a filled phone cell that is invalid while no other phone parses → `badPhone`
    - no valid phone and no email → `noContact`
  - **Address:** kept only when there is a street and either a ZIP or both city and state.
  - **Stage synonyms:**
    - lead / new / prospect → `lead`
    - inspection / inspected / appointment → `inspection`
    - proposal / estimate / quote / quoted / bid → `proposal`
    - won / sold / signed / closed won → `won`
    - installed / complete / completed / done → `installed`
    - lost / closed lost / dead → `lost`
    - any other filled value → `lead`
- **Planning:**
  - `row` is the spreadsheet row number: the data index + 2.
  - **Duplicates:** a row whose phone or email matches an earlier row of the same file → `skip`, `duplicate`, reason `Duplicate of row ${n}`.
  - **Matching:** a phone match (any phone, against `existing.byPhone`) beats an email match → `update` with `matchId`. Otherwise `create`.
  - **Reasons:** `noName` → "No name"; `noContact` → "No phone and no email"; `badPhone` → "Bad phone number".
  - **Consent counts:**
    - `attested` and `express` count the rows set to that status (new rows, or raised)
    - `unchanged` counts the matched rows whose status stays as it is, minus the opted-out ones
    - `optedOutKept` counts the matched rows that are `revoked`, `doNotContact` or `optedOut`
- **`buildImportFixture(): { csv: string; existing: { name: string; phone: string; consent: ConsentStatus; doNotContact: boolean; optedOut: boolean }[] }`**
  - Headers: `' Customer Name ','CELL','E-Mail','Street Address','city','ST','Zip Code','Notes'`.
  - 1,000 data rows, each with the address `${1000+i} Pine St, Omaha, NE 68102`:
    - rows 1–850: new, phones `(402) 555-${1000+i}`
    - rows 851–900: phones of the 50 `existing` customers (`+1402555` + 2000…2049), whose states are:
      - 10 `revoked` (with an opt-out)
      - 10 `written`
      - 10 do-not-contact (`express`)
      - 10 `none`
      - 10 `express`
    - rows 901–940: the phones of rows 1–40, written as `402.555.${1000+i}`
    - rows 941–970: named, with phones `555-0144`, `12` or `call me`, and no email
    - rows 971–985: a blank name with a valid fresh phone
    - rows 986–1000: a name with no phone and no email
    - no row has an email, so `E-Mail` is mapped but empty throughout

- [ ] **Step 1: Write the failing tests**
  - `consent.test.ts`:
    - every row of the rules table above, including `importConsent({status:'express', doNotContact:true, optedOut:false}, true, true) === 'express'`
    - `consentAttestationText('Acme Roofing')` equals the verbatim sentence
  - `import-plan.test.ts`:
    - `it('the 1,000-row fixture plans exactly')`:
      - attested → counts `new 850, updated 50, skipped 100`
      - `skippedBy {noName:15, noContact:15, badPhone:30, duplicate:40}`
      - `consent {attested:870, express:0, unchanged:10, optedOutKept:20}`
    - the same unchecked → `consent {attested:0, express:860, unchanged:20, optedOutKept:20}`
    - row 902 → `Duplicate of row 2`
    - `it('fills names and phones from Excel quirks')`:
      - cells `['Ann Lee','4025550144','','12 Elm St','Boston','Massachusetts','2134','','']` → phones `['+14025550144']`, state `MA`, zip `02134`
    - `it('maps stage words')`: `Sold` → `won`, `weird` → `lead`, `''` → `null`
    - `it('matches by email when no phone matches, and a phone match beats an email match')`:
      - a row with only `Ann@Example.com` matches the existing customer with `ann@example.com`
      - a row whose phone matches customer X and whose email matches customer Y → `matchId` X
    - `it('preview is the first 20 rows as saved')` → length 20, first `row: 2`

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the tests.** `npx vitest run --project @roofline/api import-plan && npx vitest run --project @roofline/shared`. Expected: PASS.

- [ ] **Step 5: Commit.** `feat(import): normalize rows, apply the consent rules and plan an import`

---

### Task 8: Send gate: textable numbers and refusal kinds

**Split:**
- Builder 1: `phone.ts` textability and its tests.
- Builder 2: the `adapter.ts` refusal kinds and the fake.
- Builder 3: the `decide.ts` contact rule and its tests.

**Files:**
- Modify: `packages/shared/src/phone.ts`, `packages/send-gate/src/adapter.ts`, `packages/send-gate/src/decide.ts`, `packages/send-gate/src/index.ts`
- Test: `packages/shared/test/phone.test.ts`, `packages/send-gate/test/adapter.test.ts`, `packages/send-gate/test/decide.test.ts` (extend each)

**Interfaces:**
- **Textability:**
```ts
export const TOLL_FREE_AREA_CODES: readonly string[] = ['800','833','844','855','866','877','888','900'];
export const NON_US_NANP_AREA_CODES: readonly string[];   // Canada + other NANP countries, listed below
export function textability(e164: string): 'ok' | 'toll_free' | 'not_us' | 'invalid';
```
  - `NON_US_NANP_AREA_CODES`:
    - **Canada:** 204 226 236 249 250 257 263 289 306 343 354 365 367 368 382 387 403 416 418 428 431 437 438 450 460 468 474 506 514 519 548 579 581 584 587 604 613 639 647 672 683 705 709 742 753 778 780 782 807 819 825 867 873 879 902 905 942
    - **Other NANP countries:** 242 246 264 268 284 345 441 473 649 658 664 721 758 767 784 809 829 849 868 869 876
  - US territories (340 670 671 684 787 939) are `ok`.
- **Refusals:**
```ts
export const SMS_REFUSED: unique symbol = Symbol.for('roofline.sms.refused');
export class SmsRefusedError extends Error {
  readonly [SMS_REFUSED] = true; readonly permanent: boolean; readonly optedOut: boolean; readonly reasonPlain: string | null;
  constructor(message: string, opts?: { permanent?: boolean; optedOut?: boolean; reasonPlain?: string });
}
export function isSmsRefusedError(err: unknown): err is SmsRefusedError;   // instanceof, or name === 'SmsRefusedError' && err[SMS_REFUSED] === true
export type OutboundSms = { companyId: string; to: string; body: string; sender?: { accountSid: string; messagingServiceSid: string } | null };
// FakeSmsAdapter gains: refuseNext(n: number, opts?: { permanent?: boolean; optedOut?: boolean; reasonPlain?: string }): void
// and records `sender` on `sent` entries only when the text carried one.
```
- **`decide()` contact rule,** in order:
  1. no number → "No mobile number on file."
  2. do-not-contact or opted out → "This customer asked not to be texted."
  3. `textability`:
     - `toll_free` → "This is a toll-free number, which can't get these texts."
     - `not_us` → "This number is outside the US, so we can't text it."
     - `invalid` → "This isn't a mobile number we can text."

- [ ] **Step 1: Write the failing tests**
  - `phone.test.ts`:
    - `textability('+18005550100') === 'toll_free'`
    - `'+14165550100'` and `'+18765550100'` → `'not_us'`
    - `'+17875550100'` → `'ok'`
    - `'+14025550144'` → `'ok'`
    - `'+4402071234567'` → `'invalid'`
  - `decide.test.ts`:
    - a toll-free recipient → `{action:'block', rule:'contact', reason:"This is a toll-free number, which can't get these texts."}`
    - Canada → the outside-the-US reason
    - with company status `past_due` and a toll-free number → rule `billing` (order kept)
  - `adapter.test.ts`:
    - `isSmsRefusedError(new SmsRefusedError('x'))` is true
    - a look-alike `{ name: 'SmsRefusedError', [Symbol.for('roofline.sms.refused')]: true }` (as from a second copy of the package) is true
    - `new Error('x')` is false
    - `refuseNext(1, {permanent:true, optedOut:true, reasonPlain:'R'})` makes the next send reject with those fields
    - `sent[0]` has no `sender` key when none was given

- [ ] **Step 2: Run them and see them fail.** `npx vitest run --project @roofline/send-gate --project @roofline/shared`

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the full suite** (the F1 batch and dispatcher tests must still pass). `npx vitest run && npm run typecheck`. Expected: PASS.

- [ ] **Step 5: Commit.** `feat(send-gate): textable US numbers only; permanent and carrier opt-out refusals`

---

### Task 9: API skeleton: provider seams, fakes, config, deps, mounts, schedules and job queues

**Split:**
- Builder 1: config, `deps.ts`, `server.ts`, the worker entry, `test/helpers.ts`, `.env.example` and the README env table.
- Builder 2: `providers/*` interfaces and `providers/fakes/*`, plus `fakes.test.ts`.
- Builder 3: the job queue, handlers, stub modules, mounts in `app.ts`, `SCHEDULES`, `billing/plans.ts`, the ESLint allowlist and `boundaries.test.ts`.

**Files:**
- Create:
  - `apps/api/src/providers/{geocoder,billing,registrar,sms}.ts`
  - `apps/api/src/providers/fakes/{geocoder,billing,registrar}.ts`
  - `apps/api/src/jobs/queue.ts`, `apps/api/src/jobs/handlers.ts`
  - `apps/api/src/billing/plans.ts`, `apps/api/src/billing/guards.ts`
  - stubs that later tasks fill:
    - `apps/api/src/providers/{geocodio,stripe}.ts`, `apps/api/src/providers/twilio/{sms,accounts,brands}.ts`
    - `apps/api/src/imports/run.ts`
    - `apps/api/src/account/{billing-routes,setup-routes,texting-routes}.ts`, `apps/api/src/account/texting/{advance,progress}.ts`
    - `apps/api/src/routes/imports.ts`
    - `apps/api/src/hooks/{stripe,twilio-registration}.ts`
    - `apps/api/src/public/{policies,policy-urls}.ts`
    - `apps/api/src/billing/read-only.ts`
    - `apps/api/src/jobs/scheduler/{end-trials,report-usage,provision-texting,poll-texting,bill-monthly-fees}.ts`
- Modify:
  - `apps/api/src/{config,deps,app,server,index}.ts`, `apps/api/src/jobs/worker.ts`, `apps/worker/src/index.ts`
  - `apps/api/test/helpers.ts`, `apps/api/test/boundaries.test.ts`
  - `eslint.config.js` (`DB_SYSTEM_ALLOWED` gains `apps/api/src/account/**` and `apps/api/src/public/**`, and the message names them)
  - `.env.example`, `README.md` (env table only)
- Test: `apps/api/test/config.test.ts` (extend), `apps/api/test/fakes.test.ts`, `apps/api/test/jobs.test.ts`, `apps/api/test/boundaries.test.ts`

**Interfaces:**
- **Config keys** (all optional; blank counts as unset):
  - `STRIPE_SECRET_KEY`: must start with `sk_`.
  - `STRIPE_WEBHOOK_SECRET`: required when `STRIPE_SECRET_KEY` is set; starts with `whsec_`.
  - `BILLING_PLANS_FILE`:
    - Default, outside production: `config/billing-plans.example.json` resolved from the repo root.
    - Required in production when `STRIPE_SECRET_KEY` is set.
  - `GEOCODIO_API_KEY`.
  - `TWILIO_ACCOUNT_SID`: `/^AC[0-9a-f]{32}$/`. When it is set, `TWILIO_AUTH_TOKEN` is required.
  - `TWILIO_PRIMARY_PROFILE_SID`: `/^BU[0-9a-f]{32}$/`.
  - `POLICY_PAGES_DOMAIN`: a bare hostname such as `roofline.app`.
  - `FAKE_PROVIDERS`: `1|true|0|false` → boolean. With `NODE_ENV=production` it is the issue "must not be set in production".
- **Geocoder seam:**
```ts
// providers/geocoder.ts
export type GeocodeResult = { lng: number; lat: number; street: string | null; city: string | null; state: string | null; zip: string | null;
  timezone: string | null; accuracy: number; accuracyType: string; source: 'geocodio' | 'fake' };
export interface Geocoder { readonly configured: boolean; geocode(address: string): Promise<GeocodeResult | null>;
  geocodeMany(addresses: readonly string[]): Promise<(GeocodeResult | null)[]> }
export class GeocoderUnavailableError extends Error {}
export function createGeocoder(config: Config): Geocoder;       // FAKE → FakeGeocoder; else UnconfiguredGeocoder (Task 14 adds Geocodio)
```
- **Billing seam:**
```ts
// providers/billing.ts
export interface BillingProvider { readonly configured: boolean;
  ensureCustomer(i: { companyId: string; name: string; email: string | null; existingCustomerId: string | null }): Promise<{ customerId: string }>;
  createCheckout(i: { customerId: string; companyId: string; planKey: string; priceLookupKeys: string[]; trialEnd: Date | null;
    successUrl: string; cancelUrl: string }): Promise<{ url: string }>;
  createPortal(i: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  changePlan(i: { subscriptionId: string; planKey: string; priceLookupKeys: string[] }): Promise<void>;
  reportMeterEvent(i: { eventName: string; customerId: string; value: number; identifier: string; timestamp: Date }): Promise<void>;
  createInvoiceItem(i: { customerId: string; amountCents: number; description: string; idempotencyKey: string }): Promise<{ invoiceItemId: string }> }
export class BillingUnavailableError extends Error {}
export function createBillingProvider(config: Config): BillingProvider;   // FAKE → fake; else Unconfigured (Task 18 adds Stripe)
```
- **Registrar seam:**
```ts
// providers/registrar.ts
export type SubaccountRef = { accountSid: string; authToken: string };
export type ReviewStatus = 'pending' | 'approved' | 'failed';
export interface TextingAccounts {
  ensureSubaccount(companyId: string): Promise<{ accountSid: string; authToken: string }>;
  ensureMessagingService(sub: SubaccountRef, companyId: string, urls: { inbound: string; status: string }): Promise<{ messagingServiceSid: string }>;
  ensureNumber(sub: SubaccountRef, i: { messagingServiceSid: string; areaCode: string | null; state: string | null }):
    Promise<{ e164: string; phoneNumberSid: string; capabilities: ('sms' | 'voice')[] }> }
export interface TextingBrands {
  submitBrand(sub: SubaccountRef, i: { companyId: string; brand: BrandInfo; statusCallback: string;
    previous: { customerProfileSid: string | null; trustProductSid: string | null; brandSid: string | null } }):
    Promise<{ customerProfileSid: string; trustProductSid: string; brandSid: string }>;
  brandStatus(sub: SubaccountRef, brandSid: string): Promise<{ status: ReviewStatus; failureReason: string | null }>;
  submitCampaign(sub: SubaccountRef, i: { brandSid: string; messagingServiceSid: string; campaign: CampaignInfo; previousCampaignSid: string | null }):
    Promise<{ campaignSid: string }>;
  campaignStatus(sub: SubaccountRef, messagingServiceSid: string, campaignSid: string): Promise<{ status: ReviewStatus; failureReason: string | null }> }
export type TextingRegistrar = TextingAccounts & TextingBrands & { readonly configured: boolean };
export class RegistrarUnavailableError extends Error {}                         // try again later
export class RegistrarRejectedError extends Error { constructor(readonly reasonText: string) }   // the details were refused
export function createRegistrar(config: Config): TextingRegistrar;   // FAKE → fake; else Unconfigured (Tasks 25/26 add Twilio)
```
- **SMS factory:** `providers/sms.ts`: `createSmsAdapter(config: Config): SmsAdapter`. With FAKE → `FakeSmsAdapter`; else `DisabledSmsAdapter` (Task 13 adds Twilio).
- **Real-adapter stubs.** Each returns `null` until its task replaces the file, so no provider task edits a factory.
  - `providers/geocodio.ts`: `geocodioFor(config): Geocoder | null` (Task 14)
  - `providers/stripe.ts`: `stripeFor(config): BillingProvider | null` (Task 18)
  - `providers/twilio/sms.ts`: `twilioSmsFor(config): SmsAdapter | null` (Task 13)
  - `providers/twilio/accounts.ts`: `twilioAccountsFor(config): TextingAccounts | null` (Task 25)
  - `providers/twilio/brands.ts`: `twilioBrandsFor(config): TextingBrands | null` (Task 26)
- **How each factory chooses:** FAKE → the fake. Else the real adapter, when its `…For` returns non-null. Else the unconfigured one.
  - `createRegistrar` composes the two Twilio halves, each falling back to its unconfigured half.
  - Its `configured` is true when the accounts half is real.
- **Unconfigured adapters:** `configured: false`. Every method throws its `…UnavailableError` with the message `<Service> isn't set up.`
- **Fakes** (deterministic; each records `calls` and has `failNext(n)`, which makes the next n calls throw the Unavailable error):
  - **`FakeGeocoder`:**
    - `/nowhere/i` → `null`
    - `/outage/i` → throws `GeocoderUnavailableError`
    - else parses `street, city, ST zip`:
      - `street` = the first comma part
      - `city` = the second
      - `state`/`zip` from the last part `/\b([A-Za-z]{2})\s+(\d{5})\b/`
    - Position:
      - `h` = FNV-1a 32 of the lowercased, trimmed text
      - `lng = -95.9345 + (h % 1000) / 20000`, `lat = 41.2565 + (Math.floor(h / 1000) % 1000) / 20000`, both rounded to 6 decimals
    - `timezone` by state:
      - NE IA KS MO TX → `America/Chicago`
      - NY FL GA OH MA → `America/New_York`
      - CO → `America/Denver`
      - AZ → `America/Phoenix`
      - CA WA → `America/Los_Angeles`
      - else `America/Chicago`
    - `accuracy: 1`, `accuracyType: 'rooftop'`, `source: 'fake'`
    - `geocodeMany` maps over its input and records each batch in `batches: string[][]`. Inside a batch, a `/outage/i` address gives `null` for that item only; `failNext` makes the whole batch call throw.
  - **`FakeBillingProvider`:**
    - `ensureCustomer`: the same `companyId` always gets the same id; otherwise ids are `cus_fake_<n>`.
    - `createCheckout` → `{url: 'https://checkout.stripe.test/c/cs_fake_<n>'}`, recorded in `checkouts`.
    - `createPortal` → `https://billing.stripe.test/p/bps_fake_<n>`, recorded in `portals`.
    - `changePlan` is recorded in `planChanges`.
    - `reportMeterEvent` is recorded in `meterEvents`, ignoring an `identifier` already seen.
    - `createInvoiceItem` returns the same `ii_fake_<n>` for the same `idempotencyKey` and records it once in `invoiceItems`.
  - **`FakeTextingRegistrar`:**
    - Sids are `fakeSid(prefix, seed)` = prefix + the first 32 hex of `sha256(seed)`.
    - Ids are stable per company or service:
      - `ensureSubaccount` → `{AC…, authToken: 'fake-token-' + companyId.slice(0, 8)}`
      - `ensureMessagingService` → `MG…`
      - `ensureNumber` → `{e164: '+1' + (areaCode ?? '402') + '5550100', phoneNumberSid: 'PN…', capabilities: ['sms','voice']}`, the same on repeat
      - `submitBrand` → `BU…`/`BU…`/`BN…`
      - `submitCampaign` → `QE…`
    - Statuses start `pending`. Change them with `setBrand(status, reason?)` and `setCampaign(status, reason?)`.
    - `failNext(method, 'unavailable' | { rejected: string })` makes the next call of that method throw.
- **Jobs:**
```ts
// jobs/queue.ts
export const JOB_NAMES = ['import-customers', 'texting-registration'] as const; export type JobName = (typeof JOB_NAMES)[number];
export type JobData = { companyId: string; importId?: string };
export type JobMeta = { attempt: number; lastAttempt: boolean };
export interface JobQueue { send(name: JobName, data: JobData, opts?: { singletonKey?: string }): Promise<void> }
export const JOB_QUEUE_OPTIONS = { policy: 'stately', retryLimit: 4, retryBackoff: true, retryDelay: 30 } as const;   // 5 attempts
export class PgBossJobs implements JobQueue { constructor(boss: PgBoss) }
export async function ensureJobQueues(boss: PgBoss): Promise<void>;
export class InlineJobs implements JobQueue { readonly sent: { name: JobName; data: JobData }[]; readonly errors: unknown[];
  drain(deps: AppDeps): Promise<void> }   // runs pending jobs; a throw is retried up to attempt 5 (lastAttempt on the 5th); drops a send whose singletonKey is still pending
// jobs/handlers.ts
export const JOB_HANDLERS: Record<JobName, (deps: AppDeps, data: JobData, meta: JobMeta) => Promise<void>>;
// 'import-customers' → runImport(deps, data.companyId, data.importId!, meta); 'texting-registration' → advanceRegistration(deps, data.companyId)
```
- **`AppDeps` gains** `geocoder: Geocoder; billing: BillingProvider; registrar: TextingRegistrar; jobs: JobQueue`.
- **`buildDeps(config, queue, jobs)`** uses the four factories.
- **`server.ts` and the worker** create `new PgBossJobs(boss)` after `ensureJobQueues(boss)`.
- **`startWorker`** works each `JOB_NAMES` queue with `includeMetadata: true`:
  - `attempt = retryCount + 1`
  - `lastAttempt = retryCount >= retryLimit`
- **`billing/plans.ts`:** `billingConfig(deps: AppDeps): BillingConfig`. It reads `config.BILLING_PLANS_FILE` once per path through `parseBillingConfig` and memoizes it; a missing or invalid file throws.
- **`billing/guards.ts`:** `hasPaymentMethod(f: { stripeSubscriptionId: string | null; status: CompanyStatus }): boolean` is true when there is a subscription and the status is `active` or `past_due`.
- **Scheduler stubs**, each `(deps: AppDeps, now: Date) => Promise<void>`: `endTrials`, `reportUsage`, `provisionTexting`, `pollTexting`, `billMonthlyFees`, in the files of the same names.
- **Route stubs:** `billingRoutes`, `setupRoutes`, `textingRoutes`, `importRoutes`, `stripeHooks`, `twilioRegistrationHooks` and `policyPages` take `(deps)` and return a `Router`; `readOnlyGuard` is a pass-through `RequestHandler`.
- **Job stubs:** `runImport(deps, companyId, importId, meta)`, `advanceRegistration(deps, companyId)` and `continueRegistration(deps, companyId)` (in `account/texting/progress.ts`) do nothing.
- **Mounts in `createApp`:**
  - right after `helmet`: `app.use(policyPages(deps))`
  - before `express.json`: `app.use('/hooks/stripe', stripeHooks(deps))` (its router uses `express.raw({ type: '*/*', limit: '512kb' })`)
  - beside `/hooks/twilio`: `app.use('/hooks/twilio-registration', twilioRegistrationHooks(deps))`
  - after `requireSession`: `app.use('/api', readOnlyGuard)`
  - routers:
    - `/api/billing` → `billingRoutes(deps)`
    - `/api/setup` → `setupRoutes(deps)`
    - `/api/imports` → `importRoutes(deps)`
    - `/api/texting` → `textingRoutes(deps)`
- **`SCHEDULES` gains:**
  - `end-trials` `*/5 * * * *`
  - `report-usage` `* * * * *`
  - `provision-texting` `* * * * *`
  - `poll-texting` `0 * * * *`
  - `bill-monthly-fees` `0 9 1 * *`
- **`TestApp` gains** `geocoder: FakeGeocoder; billing: FakeBillingProvider; registrar: FakeTextingRegistrar; jobs: InlineJobs`.
- **`testConfig` adds** `STRIPE_WEBHOOK_SECRET: 'whsec_test_roofline'`, the example `BILLING_PLANS_FILE` and `POLICY_PAGES_DOMAIN: 'roofline.test'`.

- [ ] **Step 1: Write the failing tests**
  - `config.test.ts`:
    - `STRIPE_SECRET_KEY='sk_test_x'` without a webhook secret → `ConfigError` naming `STRIPE_WEBHOOK_SECRET`
    - `TWILIO_ACCOUNT_SID='ACxyz'` → names `TWILIO_ACCOUNT_SID`
    - `FAKE_PROVIDERS=1` with `NODE_ENV=production` → names `FAKE_PROVIDERS`
    - `buildDeps` with `FAKE_PROVIDERS=1` gives the four fakes
    - without it, the three seams report `configured === false`
  - `fakes.test.ts`:
    - one test per fake behaviour pinned above
    - `FakeGeocoder.geocode('1200 Farnam St, Omaha, NE 68102')` → `{street:'1200 Farnam St', city:'Omaha', state:'NE', zip:'68102', timezone:'America/Chicago'}`, the same `lng`/`lat` twice
  - `jobs.test.ts`:
    - `InlineJobs` drops a second send with the same pending `singletonKey`
    - a handler that throws twice then succeeds runs 3 times, and `lastAttempt` is true only on attempt 5
    - `SCHEDULES` has the five new names with the exact crons
  - `boundaries.test.ts`:
    - `apps/api/src/account/__fixture_ok_import.ts` and `apps/api/src/public/__fixture_ok_import.ts` may import `@roofline/db/system`
    - `apps/api/src/routes/imports.ts` may not

- [ ] **Step 2: Run them and see them fail.** `npx vitest run --project @roofline/api config fakes jobs boundaries`

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the full suite and lint.** `npm run lint && npm run typecheck && npx vitest run`. Expected: PASS.

- [ ] **Step 5: Commit.** `feat(api): F3 provider seams with fakes, config, job queues, schedules and route skeleton`

---

### Task 10: Inbound texts: atomic claim, carrier opt-out keywords, short codes, inactive numbers, HELP contact

**Split:**
- Builder 1: `repos/inbound.ts` (`insertInboundText`, `companyContact`).
- Builder 2: `system/routing.ts`.
- Builder 3: `hooks/twilio.ts` for `/sms`, plus the tests.

**Files:**
- Modify: `apps/api/src/hooks/twilio.ts` (the `/sms` path only), `packages/db/src/repos/inbound.ts`, `packages/db/src/system/routing.ts`
- Test: `apps/api/test/twilio-hooks.test.ts` (extend)

**Interfaces:**
- **`insertInboundText(tx, ctx, text, now): Promise<string | null>`:** `ON CONFLICT (company_id, provider_message_sid) WHERE direction = 'in' DO NOTHING`. It returns null for a repeat.
- **`companyContact(tx, ctx): Promise<{ name; phoneE164; email: string | null; website: string | null } | null>`**
- **`companyIdForNumber(system, e164, options?: { includeInactive?: boolean }): Promise<string | null>`:** with `includeInactive`, the number's company whatever its `status`.
- **`/sms` changes:**
  - Route with `includeInactive: true`.
  - The `webhook_events` claim (`once`) is removed. The tenant transaction is the claim: `handleInbound` inserts first (after the STOP/START locks), and a null insert returns no reply. A throw rolls everything back, so Twilio's retry is handled.
  - `From` may be E.164 or a short code `/^\d{3,8}$/`:
    - A short-code text is stored (`from_e164` = the raw value).
    - It is never classified and gets an empty `<Response/>`.
  - **`OptOutType` form field** (Twilio's own opt-out handling): `STOP`, `START` and `HELP` override `readInbound`. STOP uses the normalized body as the keyword.
  - **Replies:** with `OptOutType` STOP or START, our TwiML reply is omitted, because Twilio already sent one. HELP is always answered by us.
  - **HELP reply,** first available contact:
    - phone → `${name}: call us at (402) 555-0199. Reply STOP to opt out.`
    - email → `${name}: email us at ${email}. Reply STOP to opt out.`
    - website → `${name}: visit ${website}. Reply STOP to opt out.`
    - else the number they texted → `${name}: call or text us at ${display(To)}. Reply STOP to opt out.`
    - Each dynamic part is escaped with `escapeXml`.

- [ ] **Step 1: Write the failing tests** (signed as the existing ones are)
  - `test('a STOP whose work fails is handled on the retry')`:
    - The owner client creates a trigger on `opt_outs` that raises once (a one-row flag table decides).
    - The first POST → 500. No message row with that SID, no opt-out.
    - The second POST → 200 with the STOP reply.
    - One opt-out, one `customer.consent_revoked` audit row.
  - `test('two copies of one STOP at once make one opt-out and one reply')`: `Promise.all` of two → exactly one body contains `unsubscribed`; the other is `<Response/>`.
  - `test('texts that come in no longer use webhook_events')`: count of `provider = 'twilio-sms'` = 0.
  - `test('a short-code sender is stored and changes nothing')`: `From=72345`, `Body=STOP` → `<Response/>`; the row's `from_e164 = '72345'`; no opt-out.
  - `test('a STOP to a number that is no longer active still opts out')`.
  - `test('HELP falls back to email, website, then the number they texted')`: the three exact strings for Acme Roofing (`office@acme.test`, `https://acme.test`, `(402) 555-0100`).
  - `test("Twilio's own opt-out keyword counts and we don't answer twice")`:
    - `OptOutType=STOP` with `Body=OPTOUT` → opted out, `<Response/>`
    - `OptOutType=START` → restored, `<Response/>`
    - `OptOutType=HELP` → our HELP text

- [ ] **Step 2: Run them and see them fail.** `npx vitest run --project @roofline/api twilio-hooks`

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the API suite.** `npx vitest run --project @roofline/api && npm run lint`. Expected: PASS.

- [ ] **Step 5: Commit.** `fix(hooks): inbound dedupe inside the tenant transaction; carrier opt-outs, short codes, inactive numbers, HELP contact`

---

### Task 11: Delivery reports that arrive early, and reports routed by messaging service

**Split:**
- Builder 1: `repos/delivery.ts` and the `markTextSent` hook-in.
- Builder 2: `/status` routing and `system/routing.ts`.
- Builder 3: the tests.

**Files:**
- Modify: `apps/api/src/hooks/twilio.ts` (`/status`), `packages/db/src/repos/delivery.ts`, `packages/db/src/repos/messages.ts` (`markTextSent`), `packages/db/src/repos/inbound.ts` (`recordDeliveryOutcome`), `packages/db/src/system/routing.ts`
- Test: `apps/api/test/delivery-reports.test.ts`

**Interfaces:**
- **Early reports:**
```ts
export async function saveEarlyDeliveryReport(tx: Tx, ctx: TenantContext, r: { providerSid: string; status: 'delivered' | 'failed'; reason: string | null }, now: Date): Promise<void>;
export async function applyEarlyDeliveryReports(tx: Tx, ctx: TenantContext, messageId: string, providerSid: string, now: Date): Promise<'delivered' | 'failed' | null>;
```
  - `saveEarlyDeliveryReport` is `ON CONFLICT DO NOTHING`.
  - `applyEarlyDeliveryReports`:
    - `failed` wins over `delivered`.
    - A failed report makes the row `failed`, not retryable, with the stored reason.
    - Applied reports get `applied_at`.
- **`recordDeliveryOutcome(...)`** returns `'applied' | 'ignored' | 'unknown_sid'`. `unknown_sid` means no outbound row of the company has that SID.
- **`markTextSent`** calls `applyEarlyDeliveryReports` in its own transaction once the row is `sent`.
- **`companyIdForMessagingService(system, messagingServiceSid): Promise<string | null>`:** through `texting_registrations.messaging_service_sid`.
- **`/status` changes:**
  - The `once` claim is removed (the writes are idempotent).
  - Route by `From` with `includeInactive: true`; else by `MessagingServiceSid`; else 404.
  - The signature is checked with that company's token, as before.
  - `unknown_sid` → `saveEarlyDeliveryReport`.

- [ ] **Step 1: Write the failing tests**
  - `test('a delivered report that beats the saved SID is applied when the send is saved')`:
    - A held SMS adapter returns SID `SM` + 32×`b` only when released.
    - While it is held, POST `/status delivered` for that SID → 200.
    - Release → the row is `delivered`; the early report has `applied_at`.
  - `test('an early failed report fails the text')` → `failed`, `retryable false`, `block_reason "The carrier couldn't deliver this text."`.
  - `test('a repeated report changes nothing and stores nothing')`.
  - `test('a report for a number that is no longer active is applied')`.
  - `test('a report with no From is routed by its messaging service')`.
  - `test('delivery reports no longer use webhook_events')`.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the API suite.** Expected: PASS, including the F1 `twilio-hooks` tests.

- [ ] **Step 5: Commit.** `fix(hooks): keep delivery reports that arrive before the send is saved; route by messaging service`

---

### Task 12: Lease heartbeat for long batches

**Split:**
- Builder 1: `renewStepLease` and `leaseKeeper`.
- Builder 2: the `send-batch.ts` loop.
- Builder 3: the tests.

**Files:**
- Modify: `packages/db/src/repos/tasks.ts`, `packages/db/src/index.ts` (export), `apps/api/src/tasks/runner.ts`, `apps/api/src/messaging/send-batch.ts`
- Test: `apps/api/test/lease-heartbeat.test.ts`

**Interfaces:**
```ts
export async function renewStepLease(tx: Tx, ctx: TenantContext, stepId: string, runSeq: number, leaseExpiresAt: Date): Promise<boolean>;
// UPDATE ... SET lease_expires_at WHERE id, company, status='running', run_seq=runSeq, lease_expires_at IS NOT NULL
export const LEASE_RENEW_EVERY_MS = 60_000;
export function leaseKeeper(deps: AppDeps, ctx: TenantContext, step: StepRow): { keep(): Promise<boolean> };
```
- **`keep()`:**
  - It renews to `now + LEASE_MS` when at least `LEASE_RENEW_EVERY_MS` has passed (by `deps.clock`) since the claim or the last renewal.
  - It returns false once a renewal finds the step no longer this run's, and stays false.
- **`sendSmsBatch`** calls `keep()` before each customer. When it is false, the handler stops and returns `{ status: 'running', result: {} }`; the runner drops that outcome, since the run is stale.

- [ ] **Step 1: Write the failing tests**
  - `test('a batch that runs longer than the lease keeps it')`:
    - 15 attested customers; each `send` advances `t.clock` by 60 s.
    - After the 12th send (12 minutes in), `sweepQueued(deps, clock.now())` puts nothing back.
    - The step ends `done` with 15 sent.
  - `test('a run that lost its step stops texting')`: on the 3rd send the adapter bumps the step's `run_seq` by SQL and advances 61 s → 3 texts sent in all by that run, and nobody is texted twice when a second run finishes the batch.
  - `test('renewStepLease needs the run number')`: the wrong `runSeq` → false; the right one → true and the lease moved.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the API suite.** Expected: PASS.

- [ ] **Step 5: Commit.** `fix(tasks): lease heartbeat so long batches keep their step`

---

### Task 13: Twilio sending: HTTP client, SMS adapter, sender wiring, carrier opt-outs

**Split:**
- Builder 1: `providers/twilio/http.ts` and `providers/twilio/sms.ts`, plus `twilio-sms.test.ts`.
- Builder 2: the sender through `messages.ts`, `gate-request.ts`, `outbound.ts`, `send-batch.ts` and `dispatcher.ts`.
- Builder 3: `repos/opt-outs.ts` (`recordCarrierOptOut`) and the integration tests.

**Files:**
- Create: `apps/api/src/providers/twilio/http.ts`
- Modify:
  - `apps/api/src/providers/twilio/sms.ts` (replace Task 9's stub)
  - `packages/db/src/repos/messages.ts` (`textingCompanyFacts`), `packages/db/src/repos/opt-outs.ts`
  - `apps/api/src/messaging/{gate-request,outbound,send-batch,dispatcher}.ts`
- Test: `apps/api/test/twilio-sms.test.ts`, `apps/api/test/send-batch.test.ts` (extend)

**Interfaces:**
- **HTTP client:**
```ts
export const TWILIO_API = 'https://api.twilio.com/2010-04-01', TWILIO_MESSAGING = 'https://messaging.twilio.com/v1', TWILIO_TRUSTHUB = 'https://trusthub.twilio.com/v1';
export class TwilioApiError extends Error { readonly status: number; readonly code: number | null }    // message never includes Twilio's text
export class TwilioUnreachableError extends Error {}
export class TwilioHttp { constructor(o: { accountSid: string; authToken: string; fetch?: typeof fetch; timeoutMs?: number });
  as(sub: { accountSid: string; authToken: string }): TwilioHttp;
  request<T>(method: 'GET' | 'POST' | 'DELETE', url: string, params?: Record<string, string | string[] | undefined>): Promise<T> }
```
  - Basic auth.
  - POST is form-encoded (arrays repeat the key). GET puts the params in the query string.
  - The timeout is 10 s by default.
  - A status of 400–499 → `TwilioApiError` with the body's `code`.
  - Any network error, timeout, 5xx or unreadable body → `TwilioUnreachableError`.
- **SMS adapter:**
```ts
export class TwilioSmsAdapter implements SmsAdapter { constructor(o: { http: TwilioHttp; statusCallbackUrl: string }) }
```
  - **The request:** `POST ${TWILIO_API}/Accounts/${sender.accountSid}/Messages.json` with `To`, `MessagingServiceSid`, `Body` and `StatusCallback`, on the master credentials.
  - **The result:** `{providerSid: sid, segments: parseInt(num_segments) || countSegments(body)}`.
  - **Refusals:**
    - code 21610 → `SmsRefusedError` permanent + optedOut, reasonPlain "This person turned off texts from your number, so we stopped texting them."
    - codes 21211, 21612, 21614, 21408, 21265 → permanent, "This number can't get texts."
    - status 429 or code 20429 → refused, retryable
    - other 4xx → refused, retryable
    - unreachable → `new Error('Twilio did not confirm the text.')` (outcome unknown)
    - no `sender` → `SmsRefusedError("Texting isn't set up yet.")`
- **`twilioSmsFor(config)`:** `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN` → `TwilioSmsAdapter`, with status callback `${PUBLIC_BASE_URL}/hooks/twilio/status`; else `null`.
- **Sender wiring:**
  - `TextingCompanyFacts.sender: { accountSid; messagingServiceSid } | null` (both columns are tenant-readable).
  - `BuiltGateRequest.sender` and `QueuedText.sender` carry it into `deps.sms.send`.
- **`sendQueuedText`** uses `isSmsRefusedError`:
  - **Permanent** → `failed`, not retryable, `reasonPlain`. The result is `'failed'`, so the batch does not throw for it.
  - **Opted out** → also `recordCarrierOptOut` in the same transaction.
- **Carrier opt-outs:** `recordCarrierOptOut(tx, ctx, phoneE164, now): Promise<string[]>`
  - Locks every customer with the phone (`lockRecipients`), then their consent rows.
  - Upserts `opt_outs` with keyword `carrier` (`DO NOTHING`, so an earlier STOP keeps its keyword).
  - Revokes the non-revoked customers with source `text`.
  - Writes audit `customer.consent_revoked` with `after.via = 'carrier'`, and the activity "The texting service says this person opted out. Texting is turned off."

- [ ] **Step 1: Write the failing tests**
  - `twilio-sms.test.ts` (an injected `fetch` that records requests):
    - success → the SID and segments; the URL uses the subaccount SID; the Basic auth is the master account; the form has exactly the 4 fields
    - 21610, 21614, 20429, 500 and a timeout map as above
    - `err.message` never contains `+1402` or the body
  - `send-batch.test.ts`:
    - `test('a carrier opt-out turns texting off for that customer')`:
      - `sms.refuseNext(1, {permanent:true, optedOut:true, reasonPlain:R})`
      - → the row is `failed`, not retryable, with R
      - `opt_outs.keyword = 'carrier'`; the customer is `revoked`
      - the step is `done` (not retried)
    - `test("texts go out on the company's texting account")`: a registration row with `subaccount_sid` and `messaging_service_sid` → `sms.sent[0].sender` equals them

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the full suite.** `npx vitest run && npm run lint`. Expected: PASS.

- [ ] **Step 5: Commit.** `feat(texting): send through Twilio on the company's messaging service; honor carrier opt-outs`

---

### Task 14: Geocodio geocoder

**Split:**
- Builder 1: `geocodio.ts`.
- Builder 2: the fixtures and the tests.

**Files:**
- Create: `apps/api/test/fixtures/geocodio/{single.json,low-accuracy.json,batch.json}`
- Modify: `apps/api/src/providers/geocodio.ts` (replace Task 9's stub: `geocodioFor` returns a `GeocodioGeocoder` when `GEOCODIO_API_KEY` is set)
- Test: `apps/api/test/geocodio.test.ts`

**Interfaces:**
```ts
export class GeocodioGeocoder implements Geocoder { constructor(o: { apiKey: string; fetch?: typeof fetch; timeoutMs?: number; baseUrl?: string }) }
```
- **Options:** `baseUrl` defaults to `https://api.geocod.io/v1.7` (confirm the current version against Geocodio's docs). `timeoutMs` defaults to 8000.
- **`geocode`:**
  - Request: `GET {base}/geocode?q=&fields=timezone&limit=1&api_key=`.
  - Accept `results[0]` only when `accuracy >= 0.8` and `accuracy_type` is one of `rooftop`, `point`, `range_interpolation`, `nearest_rooftop_match`, `intersection` or `street_center`. Otherwise null.
  - Mapping:
    - `street` = `${number} ${formatted_street}` from `address_components`
    - `city`, `state` and `zip` from `address_components`
    - `timezone` = `fields.timezone.name`
  - Results:
    - 422 → null
    - 401, 403, 5xx, a timeout or a network error → `GeocoderUnavailableError("Geocodio didn't answer.")`
  - The request URL (which holds the key) is never put in an error.
- **`geocodeMany`:**
  - Request: `POST {base}/geocode?fields=timezone&limit=1&api_key=` with a JSON array, in chunks of 1,000.
  - The output keeps the input order.

- [ ] **Step 1: Write the failing tests** (the fixtures served by an injected `fetch`)
  - `single.json` → `{street:'1200 Farnam St', city:'Omaha', state:'NE', zip:'68102', timezone:'America/Chicago', lng:-95.9345, lat:41.2565}`
  - `low-accuracy.json` (accuracy_type `place`) → null
  - 500 and a timeout → `GeocoderUnavailableError`, whose message has no `api_key`
  - 2,500 addresses → 3 POSTs and 2,500 results in order

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the tests.** Expected: PASS.

- [ ] **Step 5: Commit.** `feat(geocode): Geocodio adapter for single and batch addresses`

---

### Task 15: Sign-up with company details; locate and service area

**Split:**
- Builder 1: `company/location.ts` and `repos/company-location.ts`.
- Builder 2: the `auth/routes.ts` signup and Google bodies, plus updating the F1 sign-up tests with `SIGNUP_COMPANY`.
- Builder 3: the `routes/company.ts` endpoints and the tests.

**Files:**
- Create: `apps/api/src/company/location.ts`
- Modify:
  - `packages/db/src/repos/company-location.ts`
  - `apps/api/src/auth/routes.ts` (the sign-up and Google bodies, plus `GET /config`), `apps/api/src/auth/middleware.ts` (`PUBLIC_ROUTES` gains `GET /auth/config`), `apps/api/src/routes/company.ts`
  - `apps/api/test/helpers.ts` (export `SIGNUP_COMPANY`)
  - `apps/api/test/auth-{password,email,google}.test.ts` (spread `SIGNUP_COMPANY` into every sign-up body)
- Test: `apps/api/test/signup-company.test.ts`, `apps/api/test/company-location.test.ts`, `apps/api/test/auth-config.test.ts`

**Interfaces:**
```ts
export type Located = { result: GeocodeResult };
export type LocateOutcome = { kind: 'located'; result: GeocodeResult } | { kind: 'not_found' } | { kind: 'unavailable' };
export async function locateAddress(geocoder: Geocoder, text: string): Promise<LocateOutcome>;   // GeocoderUnavailableError → unavailable
export const DEFAULT_SERVICE_AREA_MILES = 40; export const SERVICE_AREA_CHOICES = [10, 20, 40, 60] as const;
// repos/company-location.ts
export async function setCompanyLocation(tx: Tx, ctx: TenantContext, i: { street: string | null; city: string | null; state: string | null;
  zip: string | null; phoneE164?: string; timezone: string | null; point: { lng: number; lat: number } | null; serviceAreaMiles: number | null }): Promise<void>;
export async function setServiceAreaRadius(tx: Tx, ctx: TenantContext, miles: number): Promise<boolean>;   // false when the company has no location
```
- **Service area:** `ST_Multi(ST_Buffer(location::geography, miles * 1609.344)::geometry)`.
- **Time zone:** set only when the geocoder gives one that passes `isTimeZone`.
- **`SIGNUP_COMPANY` in tests:** `{ companyPhone: '(402) 555-0199', companyAddress: '1200 Farnam St, Omaha, NE 68102' }`.
- **Sign-up and Google bodies** gain `companyPhone` and `companyAddress`, both required for a new company:
  - `companyPhone` through `toE164` → field `companyPhone`, "That doesn't look like a US phone number."
  - `companyAddress`: 1–300 characters → field `companyAddress`, "Please enter your business address."
  - **Validation order for a new Google user:** `companyName`, then `companyPhone`, then `companyAddress`. A bare credential therefore gets field `companyName`, which the web uses to show step 2.
- **`GET /api/auth/config`:** public → `{ googleClientId: string | null }`, from `GOOGLE_CLIENT_ID`.
- **Geocoding happens before the account is created:**
  - `not_found` → 400, field `companyAddress`, "We couldn't find that address. Check the street, city and state." Nothing is created.
  - `located` → `setCompanyLocation` with the result and 40 miles, in the same tenant transaction as `insertDefaultSettings`.
  - `unavailable` → the account is still created; `address_street` is the typed text, no point, and no time zone change.
- **Company endpoints:**
  - `POST /api/company/locate` (`company_admin`) geocodes the saved address.
    - → 200 `{located: true}`
    - not found → 400 with the not-found message, field `addressStreet`
    - unavailable → 503 "We couldn't reach the map service. Try again in a minute."
  - `PUT /api/company/service-area {radiusMiles}` (`company_admin`):
    - a value not in `SERVICE_AREA_CHOICES` → 400, field `radiusMiles`, "Pick 10, 20, 40 or 60 miles."
    - no location → 409 "Place your address on the map first."
    - audit `company.service_area`
  - `GET /api/company` gains `located: boolean` and `serviceAreaMiles: number | null`.

- [ ] **Step 1: Write the failing tests**
  - `signup-company.test.ts`:
    - `test('sign-up sets the company up from the address')`:
      - 201
      - the company row: `phone_e164 '+14025550199'`, `address_street '1200 Farnam St'`, `address_city 'Omaha'`, `address_state 'NE'`, `address_zip '68102'`, `timezone 'America/Chicago'`, `service_area_miles 40`
      - `ST_Contains(service_area, location)` is true
      - `ST_Area(service_area::geography)` is within 2% of `π × 64373.76²`
    - `test('a New York address gets the New York time zone')`.
    - `test("an address we can't find is a field error and creates nothing")`.
    - `test('when the map service is down, sign-up still works')`: `'12 Outage Ave, Omaha, NE 68102'` → 201, `location` null, `address_street` = the typed text.
    - `test('a bad business phone is a field error')`.
    - `test('Google sign-up asks for the company details too')`: a new Google user with only `companyName` → 400, field `companyPhone`.
  - `company-location.test.ts`:
    - `locate` for the owner → 200; for office → 403
    - radius 20 → area within 2% of `π × 32186.88²`
    - 25 → 400; before locating → 409
    - `GET /api/company` → `located true`, `serviceAreaMiles 20`
  - `auth-config.test.ts`: answers without a session; gives the client id, or null when `GOOGLE_CLIENT_ID` is unset.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the API suite** (the F1 auth tests now send `SIGNUP_COMPANY`). Expected: PASS.

- [ ] **Step 5: Commit.** `feat(signup): company phone and address at sign-up; time zone and service area from the map`

---

### Task 16: Setup checklist API

**Split:**
- Builder 1: `repos/setup.ts`.
- Builder 2: `account/setup-routes.ts`.
- Builder 3: the tests.

**Files:**
- Modify: `packages/db/src/repos/setup.ts`, `apps/api/src/account/setup-routes.ts`
- Test: `apps/api/test/setup.test.ts`

**Interfaces:**
```ts
export async function setupFacts(tx: Tx, ctx: TenantContext): Promise<Omit<SetupFacts, 'pendingInvites'>>;
export async function saveSetupItems(tx: Tx, ctx: TenantContext, items: readonly SetupItemView[], now: Date): Promise<void>;   // upsert status + data
export async function setSetupSkipped(tx: Tx, ctx: TenantContext, key: SetupItemKey, skipped: boolean, now: Date): Promise<void>;
```
- **Where each fact comes from:**
  - the company columns (address, `location`, `service_area`, `stripe_subscription_id`)
  - `imports` statuses
  - the readable `texting_registrations` columns
  - the active members in `company_members`
  - the stored skips in `setup_items`
  - pending invites through `listPendingInvites(system, companyId, now)` in the route (allowed in `account/`)
  - `paymentMethod`: `stripe_subscription_id` is set and the status is `active` or `past_due`
- **Routes:**
  - `GET /api/setup`: any member. `deriveSetup(facts)`, then `saveSetupItems`. Returns the `SetupView`.
  - `POST /api/setup/:key/skip` and `/unskip`: `company_admin`.
    - an unknown key → 404
    - a key not in `SKIPPABLE` → 400 "This step can't be skipped."
    - success returns the `SetupView`; audit `setup.skip` / `setup.unskip`

- [ ] **Step 1: Write the failing tests**
  - `test('a new company starts with nine items, five to do')`: `progress {done:0,total:5}`; then 9 rows in `setup_items`.
  - `test('a located company has its basics done')` (set `location` and `service_area` by SQL) → `progress.done 1`.
  - `test('skipping the import counts toward progress, and unskip undoes it')`.
  - `test('texting cannot be skipped')` → 400 with the message.
  - `test('a pending invite shows the team step as started')`.
  - `test('a pending registration is waiting')`.
  - `test('office can read but not skip; reps can read')`.
  - `test("company B never sees A's checklist")`.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the API suite.** Expected: PASS.

- [ ] **Step 5: Commit.** `feat(setup): checklist API derived from the company's real records`

---

### Task 17: Hosted privacy and terms pages

**Split:**
- Builder 1: `policy-text.ts` (templates and escaping).
- Builder 2: `policies.ts`, `policy-urls.ts` and `system/policy.ts`.
- Builder 3: the tests.

**Files:**
- Create: `apps/api/src/public/policy-text.ts`
- Modify: `apps/api/src/public/policies.ts`, `apps/api/src/public/policy-urls.ts`, `packages/db/src/system/policy.ts`
- Test: `apps/api/test/policy-pages.test.ts`

**Interfaces:**
```ts
export type PolicyCompany = { name: string; legalName: string | null; street: string | null; city: string | null; state: string | null;
  zip: string | null; phoneE164: string | null; email: string | null; website: string | null };
export async function companyForPolicyPage(system: Db, slug: string): Promise<PolicyCompany | null>;
export function privacyPolicyHtml(c: PolicyCompany): string;   export function termsHtml(c: PolicyCompany): string;
export function policyUrls(config: Pick<Config, 'POLICY_PAGES_DOMAIN' | 'PUBLIC_BASE_URL'>, slug: string): { privacy: string; terms: string };
export function policyPages(deps: AppDeps): Router;
```
- **Where the pages answer:**
  - `Host: <slug>.<POLICY_PAGES_DOMAIN>`, case-insensitive, port ignored: `GET /privacy` and `/terms`. Any other path on such a host → 404.
  - Any host: `GET /policies/:slug/privacy|terms`.
  - Any other request passes through untouched.
- **Responses:**
  - `text/html; charset=utf-8`, `Cache-Control: public, max-age=300`.
  - A plain 404 page reading "We couldn't find that page."
  - Every company value is HTML-escaped.
- **`policyUrls`:** `https://<slug>.<domain>/privacy` when the domain is set; else `${PUBLIC_BASE_URL}/policies/<slug>/privacy`.
- **Privacy page** must contain (carrier requirements):
  - "No mobile information will be shared with third parties or affiliates for marketing or promotional purposes."
  - "Text messaging originator opt-in data and consent will not be shared with any third parties."
  - the company's legal name (else name), address, phone and email
- **Terms page** must contain "Message frequency varies.", "Message and data rates may apply.", "Reply STOP to opt out", "Reply HELP for help" and "Carriers are not liable for delayed or undelivered messages."
- **Template status:** the text is a draft until the owner's lawyer reviews it (spec §9). Mark it with `export const POLICY_TEMPLATE_VERSION = 'draft-2026-10'`, rendered in a `<meta name="policy-version">`.

- [ ] **Step 1: Write the failing tests**
  - `test('privacy on the company host')`: `Host: acme-roofing.roofline.test` → 200 with both privacy phrases and "Acme Roofing".
  - `test('terms carry the texting program terms')` → all five phrases.
  - `test('the path form works on any host')`.
  - `test('an unknown slug is a plain 404 page')`.
  - `test('company details are escaped')`: name `Acme <script>alert(1)</script>` → the body has `&lt;script&gt;` and no `<script>alert`.
  - `test('an uppercase host works and the app host passes through')`: `GET /health` with `Host: app.roofline.test` → `{ok:true}`.
  - `test('policyUrls')` → both forms.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the API suite.** Expected: PASS.

- [ ] **Step 5: Commit.** `feat(public): hosted privacy and terms pages per company`

---

### Task 18: Stripe adapter and the plan sync script

**Split:**
- Builder 1: `providers/stripe.ts`.
- Builder 2: `scripts/sync-stripe-plans.ts` and `planStripeSync`.
- Builder 3: the tests with a recording `fetch`.

**Files:**
- Create: `apps/api/src/scripts/sync-stripe-plans.ts`, `apps/api/src/billing/stripe-sync.ts`
- Modify: `apps/api/src/providers/stripe.ts` (replace Task 9's stub: `stripeFor` returns a `StripeBillingProvider` when `STRIPE_SECRET_KEY` is set), `apps/api/package.json` (script `sync:stripe-plans`)
- Test: `apps/api/test/stripe-provider.test.ts`, `apps/api/test/stripe-sync.test.ts`

**Interfaces:**
```ts
export class StripeBillingProvider implements BillingProvider { constructor(o: { secretKey: string; fetch?: typeof fetch }) }
export type StripeState = { meters: { id: string; eventName: string }[];
  products: { id: string; planKey: string; name: string }[];
  prices: { id: string; lookupKey: string; unitAmount: number | null; tiers: { up_to: number | null; unit_amount_decimal: string }[] | null; meterId: string | null }[] };
export type SyncAction = { kind: 'create_meter'; meter: Meter } | { kind: 'create_product' | 'rename_product'; planKey: string; name: string }
  | { kind: 'create_price'; lookupKey: string; planKey: string; spec: Record<string, unknown> };
export function planStripeSync(config: BillingConfig, state: StripeState): SyncAction[];
```
- **SDK setup:** `new Stripe(secretKey, { httpClient: Stripe.createFetchHttpClient(fetch), maxNetworkRetries: 2 })`.
- **Errors:** connection errors, 5xx and 429 → `BillingUnavailableError("Stripe didn't answer.")`.
- **Prices:** found by `lookup_keys` (`stripe.prices.list({ lookup_keys, active: true })`) and cached in memory per lookup key.
- **`ensureCustomer`:** `customers.create({ name, email, metadata: { company_id } }, { idempotencyKey: 'customer:' + companyId })`, unless `existingCustomerId`.
- **`createCheckout`:** `checkout.sessions.create` with:
  - `mode: 'subscription'`, `customer`, `client_reference_id: companyId`
  - `payment_method_collection: 'always'`
  - `line_items`: the monthly price with `quantity: 1`, then the two metered prices with no quantity
  - `subscription_data: { metadata: { company_id, plan_key }, trial_end? }`
  - `metadata`, `success_url`, `cancel_url`
- **`createPortal`:** `billingPortal.sessions.create({ customer, return_url })`.
- **`changePlan`:** retrieve the subscription, then `subscriptions.update` swapping each item's price by kind (monthly or meter), with `proration_behavior: 'create_prorations'` and `metadata.plan_key`.
- **`reportMeterEvent`:** `billing.meterEvents.create({ event_name, payload: { stripe_customer_id, value: String(value) }, identifier, timestamp: unix })`.
- **`createInvoiceItem`:** `invoiceItems.create({ customer, amount, currency: 'usd', description }, { idempotencyKey })`.
- **`planStripeSync`:**
  - A missing meter → `create_meter`:
    - `display_name`: "AI call minutes" or "Text segments"
    - `event_name`
    - `default_aggregation.formula: 'sum'`
    - `customer_mapping: { type: 'by_id', event_payload_key: 'stripe_customer_id' }`
    - `value_settings.event_payload_key: 'value'`
  - A product is matched by `metadata.roofline_plan`.
  - A missing price, or one whose amount or tiers differ → `create_price` with `transfer_lookup_key: true`:
    - monthly: `unit_amount`, `recurring.interval: 'month'`
    - metered: `billing_scheme: 'tiered'`, `tiers_mode: 'graduated'`, `tiers` from `meteredTiers`, `recurring: { interval: 'month', usage_type: 'metered', meter }`
  - Old prices stay active, because live subscriptions use them.
- **Script:**
  - `npm run sync:stripe-plans -w @roofline/api -- [--dry-run] [--live]`.
  - It refuses an `sk_live_` key without `--live`.
  - It prints one plain line per action.

- [ ] **Step 1: Write the failing tests**
  - `stripe-provider.test.ts` (a `fetch` that records method, URL, headers and form body, and answers canned JSON):
    - the checkout form has `line_items[0][price]` = the monthly price id and `subscription_data[trial_end]=<unix>` when given, with no `trial_end` key when null
    - `Idempotency-Key: customer:<id>` on customer create
    - the meter event body has `identifier`
    - the invoice item has `Idempotency-Key: usage:<id>`
    - a 503 → `BillingUnavailableError`
  - `stripe-sync.test.ts`:
    - empty state → 2 `create_meter`, 2 `create_product`, 6 `create_price`
    - a state matching the example config → `[]`
    - starter `sms_segment` overage changed from 3 to 4 → exactly one `create_price` for `roofline_starter_sms_segment`, with `transfer_lookup_key: true`

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the tests and lint.** Expected: PASS.

- [ ] **Step 5: Commit.** `feat(billing): Stripe adapter and a plan sync script driven by the plan config`

---

### Task 19: Billing API: summary, checkout, portal, change plan

**Split:**
- Builder 1: `repos/billing.ts` and `system/billing-customers.ts`.
- Builder 2: `account/billing-routes.ts`.
- Builder 3: the tests.

**Files:**
- Modify: `packages/db/src/repos/billing.ts`, `packages/db/src/system/billing-customers.ts`, `apps/api/src/account/billing-routes.ts`
- Test: `apps/api/test/billing-routes.test.ts`

**Interfaces:**
```ts
export type BillingFacts = { status: CompanyStatus; planKey: string | null; trialEndsAt: Date | null; stripeCustomerId: string | null;
  stripeSubscriptionId: string | null; billingPeriodStart: Date | null; createdAt: Date; name: string; email: string | null };
export async function billingFacts(tx: Tx, ctx: TenantContext): Promise<BillingFacts>;
export async function usageTotals(tx: Tx, ctx: TenantContext, since: Date): Promise<Record<Meter, number>>;   // meterUnits per row
export async function setStripeCustomerIfMissing(system: Db, companyId: string, customerId: string): Promise<string>;   // returns the stored id
// uses Task 9's hasPaymentMethod (billing/guards.ts)
```
- **`GET /api/billing`** (`billing` capability) → `BillingView`:
  - `periodStart` = `billing_period_start ?? created_at`
  - `usage` lists `ai_call_minute` then `sms_segment`, with `included` from the plan (null with no plan)
  - `canOpenPortal` = a Stripe customer exists
- **`POST /api/billing/checkout {planKey}`** (`billing` + `requireVerifiedEmail`):
  - an unknown plan → 400, field `planKey`, "Pick one of the plans."
  - already subscribed → 409 "You already have a plan. Use Change plan."
  - `ensureCustomer`, then `setStripeCustomerIfMissing`
  - `trialEnd` = `trial_ends_at` when it is at least 48 hours away, else null
  - `successUrl` = `${APP_ORIGIN}/settings/billing?checkout=done`; `cancelUrl` = `${APP_ORIGIN}/settings/billing`
  - → `{url}`
- **`POST /api/billing/portal`:** no customer → 409 "Add a card first."; else `{url}`.
- **`POST /api/billing/plan {planKey}`:** needs a subscription (409 "Pick a plan first."). Calls `changePlan`, then 200 `{ok: true}`. The state follows by webhook.
- **Provider problems:**
  - `configured === false` → 503 "Billing isn't set up yet."
  - `BillingUnavailableError` → 503 "We couldn't reach the payment service. Try again in a minute."
- **Audit:** `billing.checkout_started`, `billing.plan_change_requested`.

- [ ] **Step 1: Write the failing tests**
  - `test('owner sees the plan, trial and usage')`:
    - after usage rows sms 2, sms 1, mms 1 and ai 4
    - → `usage [{meter:'ai_call_minute', used:4, included:null}, {meter:'sms_segment', used:6, included:null}]`
    - `plans` = the two example plans in camelCase (starter `monthlyPriceCents 19900`)
  - `test("office and reps can't see billing")` → 403.
  - `test('checkout keeps the trial end')`:
    - `trial_ends_at` = now + 10 days → `{url:'https://checkout.stripe.test/c/cs_fake_1'}`
    - `billing.checkouts[0]` equals `{customerId:'cus_fake_1', companyId, planKey:'starter', priceLookupKeys:['roofline_starter_monthly','roofline_starter_ai_call_minute','roofline_starter_sms_segment'], trialEnd: <trial_ends_at>, successUrl:'https://app.roofline.test/settings/billing?checkout=done', cancelUrl:'https://app.roofline.test/settings/billing'}`
    - `companies.stripe_customer_id = 'cus_fake_1'`
  - `test('a trial ending within 48 hours bills at checkout')` → `trialEnd null`.
  - `test('two checkouts at once make one customer')`.
  - `test('unknown plan, already subscribed, unconfirmed email')` → 400, 409, 403.
  - `test('portal needs a customer')`.
  - `test('change plan asks the provider')`.
  - `test("billing that isn't set up says so")`.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the API suite.** Expected: PASS.

- [ ] **Step 5: Commit.** `feat(billing): plan and usage summary, Checkout with the trial kept, portal, change plan`

---

### Task 20: Stripe webhooks

**Split:**
- Builder 1: `stripe-signature.ts`, `stripe-events.ts` and their unit tests.
- Builder 2: `system/billing-events.ts` and `hooks/stripe.ts`.
- Builder 3: the integration tests and `test/stripe-helpers.ts`.

**Files:**
- Create: `apps/api/src/billing/stripe-signature.ts`, `apps/api/src/billing/stripe-events.ts`, `apps/api/test/stripe-helpers.ts`
- Modify: `apps/api/src/hooks/stripe.ts`, `packages/db/src/system/billing-events.ts`
- Test: `apps/api/test/stripe-hooks.test.ts`, `apps/api/test/stripe-events.test.ts`

**Interfaces:**
```ts
export class StripeSignatureError extends Error {}
export function verifyStripeSignature(rawBody: Buffer, header: string | undefined, secret: string, now: Date, toleranceSec = 300): { id: string; type: string; created: number; data: { object: Record<string, unknown> } };
export type BillingUpdate = { customerId: string; eventId: string; eventCreated: Date;
  set: { status?: CompanyStatus; stripeSubscriptionId?: string; planKey?: string; billingPeriodStart?: Date }; onlyIfPastDue?: boolean };
export function billingUpdateFor(event: { id: string; type: string; created: number; data: { object: Record<string, unknown> } }): BillingUpdate | null;
export function companyStatusFor(subscriptionStatus: string): CompanyStatus | null;
export async function companyIdForStripeCustomer(system: Db, customerId: string): Promise<string | null>;
export async function applyBillingEvent(system: Db, companyId: string | null, u: BillingUpdate):
  Promise<{ applied: boolean; before: CompanyStatus | null; after: CompanyStatus | null }>;
// test helper
export function signedStripe(event: object, o?: { secret?: string; at?: Date }): { body: string; header: string };
```
- **Signature:**
  - The header is `t=<unix>,v1=<hex>[,v1=…]`.
  - The expected value is HMAC-SHA256 with `secret` over `` `${t}.${rawBody}` ``, compared with `timingSafeEqual` against each `v1`.
  - `|now − t| ≤ 300` seconds.
- **`companyStatusFor`:**
  - `trialing`, `active` → `active`
  - `past_due`, `unpaid` → `past_due`
  - `canceled`, `incomplete_expired` → `canceled`
  - anything else → null (unchanged)
- **`billingUpdateFor`:**
  - `customer.subscription.created|updated`:
    - status from `companyStatusFor`
    - `stripeSubscriptionId`
    - `planKey` from `metadata.plan_key`, else `planFromLookupKey` of the items
    - `billingPeriodStart` from `items.data[0].current_period_start ?? current_period_start`
  - `customer.subscription.deleted` → `canceled`
  - `invoice.payment_failed` → `past_due`
  - `invoice.paid` → `active` with `onlyIfPastDue`
  - anything else → null
- **`applyBillingEvent`**, in one `app_system` transaction:
  1. Claim `webhook_events('stripe', eventId)`. A repeat → `applied: false`.
  2. With no company, stop there.
  3. Lock the company row.
  4. When `eventCreated < billing_event_at` → stale, `applied: false`.
  5. When `onlyIfPastDue` and the status isn't `past_due` → only `billing_event_at` moves.
  6. Otherwise update the columns and `billing_event_at`. `past_due_at` = now on entering `past_due`, null on leaving it.
- **`POST /hooks/stripe`:**
  - A bad signature → 400 `{error:'Signature check failed.'}`.
  - Otherwise 200 `{received: true}`.
  - When the status changed, an audit `billing.status_changed {from, to, event}` is written through `withTenant`.

- [ ] **Step 1: Write the failing tests**
  - `stripe-events.test.ts`:
    - `companyStatusFor` for all 8 statuses
    - `billingUpdateFor` for each event type, from canned objects (an item-level `current_period_start` is preferred)
  - `stripe-hooks.test.ts`:
    - `test('a bad or old signature is refused')`: a wrong secret → 400; `at` = now − 301 s → 400; nothing changes.
    - `test('trial → plan and card → active, with the trial end kept')`: `subscription.created {status:'trialing', metadata:{plan_key:'starter'}}` → `status active`, `plan_key 'starter'`, `stripe_subscription_id 'sub_1'`, `trial_ends_at` unchanged, one audit row.
    - `test('a failed payment makes the company past due and the gate blocks texts')`: then a `send_sms_batch` to an attested customer (registration approved) → `result.blocked {billing: 1}`, and the message's `block_reason` is "Texting is paused until billing is sorted out."
    - `test('a paid invoice clears past due, but never revives a canceled company')`.
    - `test('a deleted subscription cancels')`.
    - `test('the same event twice does nothing the second time')`: audit count 1.
    - `test('an older event after a newer one is ignored')`: `updated` (created 200, `past_due`), then `updated` (created 100, `active`) → `past_due`.
    - `test('an unknown customer or event type is acknowledged and ignored')` → 200.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the API suite.** Expected: PASS.

- [ ] **Step 5: Commit.** `feat(billing): verified, idempotent Stripe webhooks that keep company status true`

---

### Task 21: Trial end, read-only mode, and the company status on the session

**Split:**
- Builder 1: `system/auth.ts` and `sessions.ts` (`companyStatus`).
- Builder 2: `system/trials.ts` and `end-trials.ts`.
- Builder 3: `read-only.ts` and the tests.

**Files:**
- Modify: `packages/db/src/system/auth.ts` (`findLiveSession` joins companies), `packages/db/src/system/trials.ts`, `apps/api/src/auth/sessions.ts`, `apps/api/src/billing/read-only.ts`, `apps/api/src/jobs/scheduler/end-trials.ts`
- Test: `apps/api/test/read-only.test.ts`, `apps/api/test/end-trials.test.ts`

**Interfaces:**
```ts
// SessionRecord and SessionInfo gain: companyStatus: CompanyStatus
export async function endExpiredTrials(system: Db, now: Date): Promise<string[]>;   // trial with trial_ends_at <= now → trial_ended; returns ids
export async function endTrials(deps: AppDeps, now: Date): Promise<void>;           // + audit 'billing.trial_ended' per company (withTenant)
export const READ_ONLY_MESSAGE: Record<'trial_ended' | 'canceled', string>;
export const readOnlyGuard: RequestHandler;
```
- **`READ_ONLY_MESSAGE`:**
  - `trial_ended`: "Your free trial has ended, so Roofline is read-only for now. Pick a plan to keep going."
  - `canceled`: "Your plan was canceled, so Roofline is read-only for now. Pick a plan to keep going."
- **`readOnlyGuard`:** when the session's `companyStatus` is `trial_ended` or `canceled` and the method is not GET, HEAD or OPTIONS → 403 with the matching message. Exempt paths, relative to `/api`, by prefix: `/auth/`, `/billing/` and `/me/`.
- **`past_due` is not read-only.** The gate's `billing` rule pauses the texts.

- [ ] **Step 1: Write the failing tests**
  - `end-trials.test.ts`:
    - a trial with `trial_ends_at` = now − 1 minute → `trial_ended` with an audit row
    - a trial with time left, and an `active` company, are untouched
  - `read-only.test.ts`:
    - `test('reads work, writes are refused with the plain message')`:
      - `trial_ended`: `GET /api/customers` → 200
      - `POST /api/customers`, `PATCH /api/company` and `POST /api/approvals/:id/approve` → 403 with the exact trial message
    - `test('signing out, billing and today-shown still work')`:
      - `POST /api/auth/logout` → 200
      - `POST /api/billing/checkout` → status not 403 for the read-only reason
      - `POST /api/me/today-shown` → 200
    - `test('canceled has its own message')`.
    - `test('the next request sees a status change without signing in again')`.
    - `test('past due is not read-only')`: `POST /api/customers` → 201.
    - `test('the dispatcher blocks a scheduled text once the trial ended')`: a scheduled text, then the trial ends, then `dispatchDueMessages` → `blocked` with rule `billing`.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the full suite.** Expected: PASS.

- [ ] **Step 5: Commit.** `feat(billing): end trials on time; read-only mode after a trial or a cancel`

---

### Task 22: Usage reporting: meter batches and invoice items

**Split:**
- Builder 1: `repos/usage.ts` (batches and invoicing).
- Builder 2: `system/usage-fanout.ts` and `report-usage.ts`.
- Builder 3: the tests.

**Files:**
- Modify: `packages/db/src/repos/usage.ts`, `packages/db/src/system/usage-fanout.ts`, `apps/api/src/jobs/scheduler/report-usage.ts`
- Test: `apps/api/test/report-usage.test.ts`

**Interfaces:**
```ts
export type MeterBatch = { batchId: string; meter: Meter; value: number; rows: number };
export async function openMeterBatches(tx: Tx, ctx: TenantContext): Promise<MeterBatch[]>;
export async function markBatchReported(tx: Tx, ctx: TenantContext, batchId: string, now: Date): Promise<number>;
export type InvoiceUsageRow = { id: string; kind: UsageKind; quantity: number; unitCostCents: number; description: string };
export async function unbilledInvoiceUsage(tx: Tx, ctx: TenantContext): Promise<InvoiceUsageRow[]>;
export async function markInvoiced(tx: Tx, ctx: TenantContext, usageId: string, invoiceItemId: string, now: Date): Promise<void>;
export async function companiesWithUnreportedUsage(system: Db): Promise<string[]>;
export async function reportUsage(deps: AppDeps, now: Date): Promise<void>;
```
- **`openMeterBatches`:**
  - Unreported metered rows with no batch are given one new batch id per meter, in one statement.
  - It returns every open batch (batch id set, not reported) with `value` = Σ `meterUnits(kind, quantity).value`.
  - `mms` joins the `sms_segment` meter.
- **`reportUsage`,** per company, in a try/catch with `deps.logError`:
  1. Skip the company when `billingFacts.stripeCustomerId` is null.
  2. Batches: `reportMeterEvent({eventName: METER_EVENT_NAME[meter], customerId, value, identifier: batchId, timestamp: now})`, then `markBatchReported`.
  3. Invoice rows: `createInvoiceItem({customerId, amountCents: invoiceAmountCents(...), description, idempotencyKey: 'usage:' + id})`, then `markInvoiced`.
  
  A throw leaves the rest for the next minute.

- [ ] **Step 1: Write the failing tests**
  - `test('usage becomes one meter event per meter and invoice items with the right amounts')`:
    - The company has `stripe_customer_id 'cus_fake_1'`.
    - Rows:
      - `sms_segment` 2, `sms_segment` 1, `mms` 1, `ai_call_minute` 4
      - `exact_report` 1 × 4500 "Exact roof report — 812 Oak St"
      - `texting_registration_fee` 1 × 4400 "Texting registration: business check"
      - `phone_number_month` 1 × 115 "Texting number (402) 555-0100 — October 2026"
    - After `reportUsage`:
      - `billing.meterEvents`, sorted by event name: `[{eventName:'roofline_ai_call_minute', customerId:'cus_fake_1', value:4}, {eventName:'roofline_sms_segment', customerId:'cus_fake_1', value:6}]`
      - `billing.invoiceItems` amounts `[5400, 4400, 115]` with those descriptions and `usage:<id>` keys
      - every row has `reported_to_stripe_at`
      - the invoice rows have `stripe_invoice_item_id`
  - `test('a second run reports nothing new')`.
  - `test('a crash after reporting resends the same batch, which the provider ignores')`:
    - Call `openMeterBatches` and `reportMeterEvent` by hand, with no mark.
    - Then `reportUsage` → still 2 meter events in all; the rows are marked.
  - `test('companies without a customer are skipped; one failure does not stop the others')`.
  - `test("company B's usage never goes to A's customer")`.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the API suite.** Expected: PASS.

- [ ] **Step 5: Commit.** `feat(billing): batched meter events and invoice items, idempotent end to end`

---

### Task 23: Import API: upload, mapping, preview, start, skipped rows

**Split:**
- Builder 1: `repos/imports.ts`.
- Builder 2: `imports/preview.ts` and `imports/skipped-csv.ts`.
- Builder 3: `routes/imports.ts` and the tests.

**Files:**
- Create: `apps/api/src/imports/preview.ts`, `apps/api/src/imports/skipped-csv.ts`
- Modify: `packages/db/src/repos/imports.ts`, `apps/api/src/routes/imports.ts`
- Test: `apps/api/test/imports-api.test.ts`, `apps/api/test/skipped-csv.test.ts`

**Interfaces:**
```ts
// repos/imports.ts
export type ImportRow = typeof imports.$inferSelect;
export async function createImport(tx: Tx, ctx: TenantContext, i: { fileName: string; headers: string[]; mapping: ImportMapping; rowCount: number }, now: Date): Promise<ImportRow>;
export async function insertImportRows(tx: Tx, ctx: TenantContext, importId: string, rows: readonly string[][]): Promise<void>;   // chunks of 1000
export async function getImport(tx: Tx, ctx: TenantContext, id: string): Promise<ImportRow | null>;
export async function setImportMapping(tx: Tx, ctx: TenantContext, id: string, mapping: ImportMapping, counts: ImportCounts, now: Date): Promise<boolean>;   // only while 'uploaded'
export async function startImport(tx: Tx, ctx: TenantContext, id: string, i: { attested: boolean; text: string | null }, now: Date): Promise<boolean>;   // uploaded → queued
export async function retryImport(tx: Tx, ctx: TenantContext, id: string, now: Date): Promise<boolean>;   // failed → queued
export async function importCells(tx: Tx, ctx: TenantContext, id: string): Promise<string[][]>;
export async function existingIndexFor(tx: Tx, ctx: TenantContext, phones: readonly string[], emails: readonly string[]): Promise<ExistingIndex>;
export async function skippedImportRows(tx: Tx, ctx: TenantContext, id: string): Promise<{ row: number; reason: string; cells: string[] }[]>;
export async function listImports(tx: Tx, ctx: TenantContext, limit: number): Promise<ImportRow[]>;
// preview.ts
export async function buildImportView(tx: Tx, ctx: TenantContext, row: ImportRow, attestedPreview: boolean): Promise<ImportView>;
// skipped-csv.ts
export function skippedCsv(headers: readonly string[], rows: readonly { row: number; reason: string; cells: string[] }[]): string;
```
- **`existingIndexFor`:**
  - It uses `phones @> any(...)` and `emails ?| ...`, so the GIN indexes apply.
  - `optedOut` comes from `opt_outs`.
- **Routes,** all with the `import` capability (owner only):
  - **`POST /api/imports?fileName=`:** raw body, `express.raw({ type: '*/*', limit: '10mb' })`.
    - A 413 answers "That file is too big. The most we can take is 10 MB."
    - Flow: `parseUpload` → `autoMap` → create the import and its rows → 201 `ImportView`, with the preview unchecked.
    - An `ImportFileError` → 400 with its message, field `file`.
  - **`PATCH /api/imports/:id {mapping}`:**
    - Each index must be a column index; else 400, field `mapping`.
    - After `uploaded` → 409 "This import already started."
  - **`GET /api/imports/:id?attested=true|false`** → `ImportView`. After the start, its `counts` are the job's.
  - **`POST /api/imports/:id/start {consentAttested, consentText?}`:**
    - The mapping must have `name` or `firstName`/`lastName` (400 "Match a column to Name."), and `phone` or `email` (400 "Match a column to Phone or Email."), both on field `mapping`.
    - When attested, `consentText` must equal `consentAttestationText(company.name)`; else 400, field `consentText`, "Please confirm the consent statement as shown."
    - `startImport`. A false (second click, another tab) → 409 "This import already started."
    - Audit `import.started`, plus `import.consent_attested {text}` when attested.
    - `deps.jobs.send('import-customers', {companyId, importId}, {singletonKey: importId})` → 202 `ImportView`.
  - **`POST /api/imports/:id/retry`:** `failed` → `queued`, plus the job.
  - **`GET /api/imports/:id/skipped.csv`:**
    - Only when `done`; else 409 "This import isn't finished yet."
    - `text/csv; charset=utf-8` with `Content-Disposition: attachment; filename="skipped-rows.csv"`.
  - **`GET /api/imports`** → the last 10 as `ImportView`s without a preview.
- **`skippedCsv`:**
  - Header: `Row,Reason,<the file's headers>`.
  - RFC 4180 quoting.
  - Any cell (or header) starting with `=`, `+`, `-`, `@`, a tab or a carriage return is prefixed with `'`.
  - CRLF line endings.

- [ ] **Step 1: Write the failing tests**
  - `imports-api.test.ts`:
    - `test('upload the 1,000-row file: auto-mapped, with exact counts and 20 preview rows')`: `rowCount 1000`; `counts.new 850, updated 50, skipped 100`; `preview.length 20`. The 50 existing customers are seeded from `buildImportFixture().existing`.
    - `test('the checked preview shows the consent outcome')`: `?attested=true` → `consent {attested:870, express:0, unchanged:10, optedOutKept:20}`.
    - `test('changing the mapping changes the preview')`: unmap `phone` → `skippedBy {noName:15, noContact:985, badPhone:0, duplicate:0}`, because no fixture row has an email.
    - `test('start queues one job, even when clicked twice')`: the second → 409; `t.jobs.sent.length === 1`.
    - `test('the consent statement must match')` → 400.
    - `test('office and reps cannot import; company B cannot see it')` → 403, 403, 404.
    - `test('too big, wrong type, too many rows')` → 413 and 400 with the exact messages.
    - `test('an Excel file uploads too')`.
    - `test('skipped rows only after it finishes')` → 409.
  - `skipped-csv.test.ts`:
    - `=SUM(A1)` → `'=SUM(A1)`
    - `+1 402` → `'+1 402`
    - a cell with a comma and quotes is quoted
    - the first line is `Row,Reason,...`

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the API suite.** Expected: PASS.

- [ ] **Step 5: Commit.** `feat(import): upload, map, preview with consent counts, start once, skipped-rows download`

---

### Task 24: Import job: creating customers, homes and jobs

**Split:**
- Builder 1: `repos/import-apply.ts`.
- Builder 2: `imports/run.ts`.
- Builder 3: the tests.

**Files:**
- Modify: `packages/db/src/repos/import-apply.ts`, `apps/api/src/imports/run.ts`
- Test: `apps/api/test/import-run.test.ts`

**Interfaces:**
```ts
export const IMPORT_CHUNK = 250;
export async function claimImport(tx: Tx, ctx: TenantContext, id: string, now: Date): Promise<ImportRow | null>;     // queued → processing; processing stays; else null
export async function writePlannedSkips(tx: Tx, ctx: TenantContext, id: string, skips: readonly { row: number; reason: string }[]): Promise<void>;
export async function nextImportChunk(tx: Tx, ctx: TenantContext, id: string, size: number): Promise<{ rowNumber: number; cells: string[] }[]>;   // outcome null, row order
export type ChunkWrite = { rows: { rowNumber: number; normalized: NormalizedRow; match: ExistingCustomer | null; consent: ConsentStatus; consentChanged: boolean;
  geo: GeocodeResult | null }[]; createJobs: boolean; fileName: string; attested: { userId: string; text: string } | null; importId: string };
export async function applyImportChunk(tx: Tx, ctx: TenantContext, w: ChunkWrite, now: Date): Promise<{ created: number; updated: number; jobs: number; located: number; notLocated: number }>;
export async function finishImport(tx: Tx, ctx: TenantContext, id: string, counts: ImportCounts, now: Date): Promise<void>;
export async function failImport(tx: Tx, ctx: TenantContext, id: string, errorPlain: string, now: Date): Promise<void>;
export async function runImport(deps: AppDeps, companyId: string, importId: string, meta: JobMeta): Promise<void>;
```
- **`runImport`:**
  1. `claimImport`. Null → return.
  2. On the first claim (no planned skips yet): plan the whole file (`normalizeRow`, `planImport` against `existingIndexFor`) and `writePlannedSkips` for every skipped row.
  3. Loop:
     - `nextImportChunk(250)` in a short transaction.
     - `geocodeMany` the new addresses outside any transaction (an outage → no geo, counted as not located).
     - `applyImportChunk` in one transaction. It re-matches against the database, so customers added meanwhile are updated, not duplicated, and it re-takes the rows with `FOR UPDATE SKIP LOCKED`, so a second runner cannot write them.
     - Update `counts.processed`.
  4. `finishImport`:
     - `status done`, `finished_at`
     - `error_file_url = /api/imports/<id>/skipped.csv` when anything was skipped
     - audit `import.finished {counts}`
  5. A throw on `meta.lastAttempt` → `failImport` with "We couldn't finish this import. Rows already imported are saved. Try again from Setup." and the error is rethrown.
- **`applyImportChunk`:**
  - **New customers:**
    - `source: 'import'`, `created_by_user_id: null`
    - phones as `{e164, primary}` (the first is primary)
    - consent per the plan:
      - `attested`: source `import`, `by` = the attesting user, `at` now, evidence `{import_id, text}`
      - `express`: source `import`, by the user, at now, evidence `{import_id}`
  - **Matched customers:**
    - Add missing phones and emails; set `first_name`/`last_name` only when empty.
    - Raise consent only as planned. Never touch `do_not_contact`.
  - **Properties:**
    - Keyed by `normalizeAddressKey`.
    - An existing address with no customer is claimed; one of another customer is left alone.
    - Geo writes `geom`, `geocode_source 'geocodio'|'fake'`, `geocode_accuracy`, and `timezone` from the geocoder.
  - **Jobs:** only when `createJobs` (a stage column is mapped) and the row has a stage and a property with no open job: `stage` with `source: 'import'`.
  - **Timeline:**
    - activity `customer.imported` with the summary `Imported from ${fileName}`
    - activity `customer.note` with the summary = the note (at most 500 characters) when there is one
  - **Row outcomes:** `import_rows` get their outcome and `customer_id`.
  - **No per-customer audit rows.** The import's own audit rows cover it.

- [ ] **Step 1: Write the failing tests**
  - `test('the 1,000-row file gives the right new, updated and skipped counts')`:
    - Seed the 50 existing customers, upload, start attested, `t.jobs.drain(t.deps)`.
    - `imports.status 'done'`; counts `new 850, updated 50, skipped 100`.
    - 900 customers; 900 properties; 0 jobs.
  - `test('attested customers have a full consent record')`: a new one → `attested`, source `import`, by owner, at clock now, evidence `{import_id, text: consentAttestationText('Acme Roofing')}`.
  - `test('matched customers who were revoked, written or do-not-contact keep that status')`: the 10 / 10 / 10 unchanged, `do_not_contact` still true.
  - `test('an unchecked import gives express only')`.
  - `test('jobs only when a stage column is mapped')`:
    - a 5-row file with Stage `Lead, Sold, Inspection, weird, ''` → 4 jobs (`lead`, `won`, `inspection`, `lead`), all `source 'import'`
    - the same file with Stage unmapped → 0 jobs
  - `test('addresses are placed on the map in batches')`:
    - after the 1,000-row import, every `t.geocoder.batches` entry has ≤ 250 addresses
    - a separate 3-row file with one `12 Outage Ave, Omaha, NE 68102` address → that home has no `geom`; `counts.notLocated 1`, `counts.located 2`
  - `test('a crash halfway resumes without duplicates')`:
    - The owner client adds a trigger on `import_rows` that raises once (a one-row flag table) when a row numbered above 252 gets its outcome. That is the second chunk's write.
    - The job runs twice; final customers 900; `jobs.errors.length 1`.
  - `test('running it again does nothing')`.
  - `test('the skipped-rows file lists every skipped row')`: GET → 101 lines; the line for row 902 reads `902,Duplicate of row 2,...`.
  - `test('the audit has the import and the consent confirmation')`.
  - `test('the last failed attempt marks it failed with a plain reason')`.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the API suite.** Expected: PASS.

- [ ] **Step 5: Commit.** `feat(import): background import with geocoded homes, consent rules and resumable chunks`

---

### Task 25: Twilio registrar: subaccounts, messaging services, numbers

**Split:**
- Builder 1: `accounts.ts`.
- Builder 2: the fixtures and `twilio-fixtures.ts`.
- Builder 3: the tests and the factory wiring.

**Files:**
- Create:
  - `apps/api/test/twilio-fixtures.ts`
  - `apps/api/test/fixtures/twilio/{accounts-empty,account-create,services-empty,service-create,service-numbers-empty,service-numbers-one,available-402,available-empty,incoming-create,service-number-add}.json`
- Modify: `apps/api/src/providers/twilio/accounts.ts` (replace Task 9's stub: `twilioAccountsFor` returns a `TwilioAccounts` when `TWILIO_ACCOUNT_SID` and `TWILIO_AUTH_TOKEN` are set)
- Test: `apps/api/test/twilio-accounts.test.ts`

**Interfaces:**
```ts
export class TwilioAccounts implements TextingAccounts { constructor(o: { http: TwilioHttp }) }
export function fixtureFetch(routes: Record<string, string>): typeof fetch & { requests: { method: string; url: string; auth: string; form: URLSearchParams | null }[] };
// routes key: 'METHOD <url prefix>' → fixture file name; any unmatched request throws (fails the test)
```
- **`ensureSubaccount`:**
  - `GET ${TWILIO_API}/Accounts.json?FriendlyName=roofline:<companyId>&Status=active` → reuse the first.
  - Else `POST /Accounts.json {FriendlyName}`.
  - → `{accountSid: sid, authToken: auth_token}`
- **`ensureMessagingService`** (as the subaccount):
  - `GET ${TWILIO_MESSAGING}/Services?PageSize=50`, matched by `friendly_name = 'Roofline <companyId>'`.
  - Else `POST /Services {FriendlyName, InboundRequestUrl, InboundMethod: 'POST', StatusCallback, UseInboundWebhookOnNumber: 'false'}`.
  - A found service is updated with the current URLs.
- **`ensureNumber`** (as the subaccount):
  1. A number already on the service (`GET /Services/{MG}/PhoneNumbers`) is returned.
  2. Else search `GET ${TWILIO_API}/Accounts/{sub}/AvailablePhoneNumbers/US/Local.json?SmsEnabled=true&VoiceEnabled=true&PageSize=1`:
     - first with `AreaCode`
     - then `InRegion=<state>`
     - then with no filter
     - nothing at all → `RegistrarUnavailableError('No numbers were available.')`
  3. `POST IncomingPhoneNumbers.json {PhoneNumber}`, then `POST /Services/{MG}/PhoneNumbers {PhoneNumberSid}`.
- **Credentials:** every Messaging and TrustHub call authenticates as the subaccount (`http.as(sub)`). Calls on the 2010 API use the subaccount path.

- [ ] **Step 1: Write the failing tests**
  - `test('creates a subaccount once')`: an empty list → one `POST /Accounts.json`; a list with one → no POST.
  - `test('the messaging service points at our hooks')`: the form has `InboundRequestUrl=https://app.roofline.test/hooks/twilio/sms` and `StatusCallback=.../hooks/twilio/status`.
  - `test("a number in the company's area code")`: `AreaCode=402` → `{e164:'+14025550123', capabilities:['sms','voice']}`.
  - `test('falls back to the state, then anywhere')`.
  - `test('reuses a number already on the service')`.
  - `test("messaging calls use the subaccount's own credentials")`: the Authorization header is Basic with the subaccount SID.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the tests.** Expected: PASS.

- [ ] **Step 5: Commit.** `feat(texting): Twilio subaccounts, messaging services and local numbers`

---

### Task 26: Twilio registrar: business profile, brand and campaign

**Split:**
- Builder 1: `brands.ts` (submit and status).
- Builder 2: `brands.ts` (campaign).
- Builder 3: the fixtures and tests.

**Files:**
- Create: `apps/api/test/fixtures/twilio/{profile-create,enduser-create,address-create,document-create,assignment-create,evaluation-compliant,evaluation-noncompliant,profile-submit,trust-create,brand-create,brand-pending,brand-approved,brand-failed,campaign-create,campaign-pending,campaign-verified,campaign-failed}.json`
- Modify: `apps/api/src/providers/twilio/brands.ts` (replace Task 9's stub: `twilioBrandsFor` returns a `TwilioBrands` when `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_PRIMARY_PROFILE_SID` are all set)
- Test: `apps/api/test/twilio-brands.test.ts`

**Interfaces:**
```ts
export const SECONDARY_PROFILE_POLICY = 'RNdfbf3fae0e1107f8aded0e7cead80bf5';   // confirm against Twilio's ISV guide in the manual smoke
export const A2P_PROFILE_POLICY = 'RNb0d4771c2c98518d916a3d4cd70a8f8b';
export class TwilioBrands implements TextingBrands { constructor(o: { http: TwilioHttp; primaryProfileSid: string }) }
```
- **`submitBrand`,** as the subaccount, in order:
  1. `POST ${TWILIO_TRUSTHUB}/CustomerProfiles {FriendlyName:'Roofline <companyId>', Email: contactEmail, PolicySid: SECONDARY_PROFILE_POLICY, StatusCallback}`, or reuse `previous.customerProfileSid`.
  2. `POST /EndUsers {Type:'customer_profile_business_information', Attributes}`:
     - `business_name` = `legalName`
     - `business_identity: 'direct_customer'`
     - `business_type`:
       - `llc` → `Limited Liability Corporation`
       - `corporation` → `Corporation`
       - `partnership` → `Partnership`
       - `non_profit` → `Non-profit Corporation`
     - `business_industry: 'CONSTRUCTION'`
     - `business_registration_identifier: 'EIN'`
     - `business_registration_number` = the EIN digits
     - `business_regions_of_operation: 'USA_AND_CANADA'`
     - `website_url`
     
     Then `POST /CustomerProfiles/{BU}/EntityAssignments {ObjectSid}`.
  3. `POST /EndUsers {Type:'authorized_representative_1', Attributes: {first_name, last_name, email, phone_number, business_title: contactTitle, job_position: 'Other'}}`, then assign it.
  4. `POST ${TWILIO_API}/Accounts/{sub}/Addresses.json {CustomerName, Street, City, Region, PostalCode, IsoCountry:'US'}`, then `POST /SupportingDocuments {Type:'customer_profile_address', Attributes:{address_sids}}`, then assign it.
  5. Assign `primaryProfileSid`.
  6. `POST /CustomerProfiles/{BU}/Evaluations {PolicySid}`. A non-compliant result → `RegistrarRejectedError` with the first failing requirement's `friendly_name`.
  7. `POST /CustomerProfiles/{BU} {Status:'pending-review'}`.
  8. `POST /TrustProducts {FriendlyName, Email, PolicySid: A2P_PROFILE_POLICY}`, the EndUser `us_a2p_messaging_profile_information {company_type:'private'}`, assign the customer profile, evaluate, then submit with `pending-review`.
  9. `POST ${TWILIO_MESSAGING}/a2p/BrandRegistrations {CustomerProfileBundleSid, A2PProfileBundleSid, BrandType:'STANDARD'}`. With `previous.brandSid` (a failed brand), `POST /a2p/BrandRegistrations/{BN}` resubmits instead.
- **`brandStatus`:**
  - `GET /a2p/BrandRegistrations/{BN}`
  - `APPROVED` → `approved`
  - `FAILED` → `failed`, with `failure_reason`
  - anything else → `pending`
- **`submitCampaign`:**
  - With `previousCampaignSid`, first `DELETE /Services/{MG}/Compliance/Usa2p/{QE}`.
  - `POST /Services/{MG}/Compliance/Usa2p`:
    - `BrandRegistrationSid`, `Description`, `MessageFlow`
    - `MessageSamples`, repeated
    - `UsAppToPersonUsecase:'MIXED'`
    - `HasEmbeddedLinks:'true'`, `HasEmbeddedPhone:'true'`
    - `OptInMessage`, `OptOutMessage`, `HelpMessage`
    - `OptInKeywords:'START'`, `OptOutKeywords:'STOP'`, `HelpKeywords:'HELP'`
- **`campaignStatus`:**
  - `GET .../Usa2p/{QE}`
  - `campaign_status` `VERIFIED` → `approved`
  - `FAILED` or `EXPIRED` → `failed`, with `errors[0].description`
  - anything else → `pending`
- **Errors:** a `TwilioApiError` on a POST of steps 1–9 → `RegistrarRejectedError` with the error code as text (no Twilio message). Unreachable → `RegistrarUnavailableError`.

- [ ] **Step 1: Write the failing tests** (`fixtureFetch`)
  - `test('submits the business profile, the messaging profile and the brand, in order')`: assert the exact list of method + path.
  - `test('maps the business type and EIN')`: the EndUser `Attributes` JSON.
  - `test('a non-compliant evaluation is a rejection with a plain reason')`.
  - `test('brand statuses')`: pending, approved, and failed with its reason.
  - `test('the campaign uses the mixed use case and our samples')`: the form has two `MessageSamples` equal to `buildCampaign(...).samples`.
  - `test('resubmitting a failed campaign deletes the old one first')`.
  - `test('campaign statuses')`.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the tests.** Expected: PASS.

- [ ] **Step 5: Commit.** `feat(texting): Twilio business profile, A2P brand and mixed campaign`

---

### Task 27: Texting provisioning at sign-up, and the registration submit

**Split:**
- Builder 1: `system/texting.ts` and `provision-texting.ts`.
- Builder 2: `account/texting-routes.ts` and `account/texting/view.ts`.
- Builder 3: `account/texting/advance.ts` (stage 1) and the tests.

**Files:**
- Create: `apps/api/src/account/texting/view.ts`
- Modify: `packages/db/src/system/texting.ts`, `apps/api/src/jobs/scheduler/provision-texting.ts`, `apps/api/src/account/texting-routes.ts`, `apps/api/src/account/texting/advance.ts`
- Test: `apps/api/test/texting-provision.test.ts`, `apps/api/test/texting-submit.test.ts`

**Interfaces:**
```ts
export type RegistrationRecord = typeof textingRegistrations.$inferSelect;
export async function companiesNeedingSubaccount(system: Db, limit: number): Promise<string[]>;   // not canceled, no row or no subaccount_sid
export async function saveSubaccount(system: Db, companyId: string, sid: string, tokenEncrypted: Buffer): Promise<void>;   // only fills a null sid
export async function loadRegistration(system: Db, companyId: string): Promise<RegistrationRecord | null>;
export async function saveSubmission(system: Db, companyId: string, brand: BrandInfo, now: Date): Promise<'saved' | 'already_waiting'>;
export async function updateRegistration(system: Db, companyId: string, patch: Partial<RegistrationRecord>): Promise<void>;
export async function withRegistrationLock<T>(system: Db, companyId: string, fn: (tx: Db) => Promise<T>): Promise<T | 'busy'>;   // FOR UPDATE NOWAIT
export async function provisionTexting(deps: AppDeps, now: Date): Promise<void>;
export async function textingView(deps: AppDeps, ctx: TenantContext, session: SessionInfo): Promise<TextingView>;
export async function advanceRegistration(deps: AppDeps, companyId: string): Promise<void>;
export function subaccountRef(row: RegistrationRecord, encryptionKey: string): SubaccountRef;   // decrypts the stored token
```
- **`provisionTexting`:**
  - Returns at once when `!deps.registrar.configured`.
  - Up to 20 companies per tick, each in a try/catch: `ensureSubaccount`, encrypt the token with `ENCRYPTION_KEY`, then `saveSubaccount`.
- **`saveSubmission`:**
  - Allowed only when `campaign_status` is `none` or `rejected`.
  - Sets `brand_info`, `submitted_at`, `campaign_status 'pending'`, `rejected_fields '{}'`, `rejection_reason_plain null`.
- **`GET /api/texting`** (any member) → `TextingView`:
  - **`state`:**
    - `not_started` before a submission
    - `waiting` while `pending`
    - `approved`
    - `needs_fix` when `rejected`
  - **`defaults`** (for the form):
    - `legalName` = the company's `legal_name ?? name`
    - street, city, state and ZIP from the company
    - `website`
    - `contactEmail` = the user's email
    - `contactPhone` = the company phone
  - **`hostedPolicyUrls`** = `policyUrls(config, slug)`.
  - **`needsPaymentMethod`** = `!hasPaymentMethod(...)`; **`needsVerifiedEmail`** = `!session.emailVerified`.
- **`POST /api/texting/registration {brand, useHostedPolicyPages}`** (`company_admin`):
  - **Checks:**
    - unverified → 403 with the existing `verifyEmailFirst` message
    - no payment method → 403 "Add a card first. Texting registration has a carrier fee."
    - `brand` → `BrandInfoSchema`; field errors come back as `brand.<field>`
  - **Hosted pages:** with `useHostedPolicyPages` and an empty website, `website` = the privacy URL's origin.
  - **Saving:** `saveSubmission`. `already_waiting` → 409 "Your registration is already with the phone carriers."
  - **Audit:** `texting.registration_submitted`, with the EIN masked as `**-***6789`.
  - **Job:** `jobs.send('texting-registration', {companyId}, {singletonKey: companyId})` → 202 `TextingView`.
- **`advanceRegistration`, stage 1,** under `withRegistrationLock` (`busy` → return):
  - Only when submitted and `brand_sid` is null (or the brand failed and a new submission came): `registrar.submitBrand(subaccountRef(row), { companyId, brand, statusCallback: PUBLIC_BASE_URL + '/hooks/twilio-registration', previous })`.
  - Save the three sids and `brand_status 'pending'`.
  - Record the fee: `recordUsage` `texting_registration_fee`, quantity 1, unit `pass_through_cents.brand_registration`, ref `('texting_brand', brandSid)`, description "Texting registration: business check".
  - `RegistrarRejectedError` → `campaign_status 'rejected'`, with `rejection_reason_plain` and `rejected_fields` from `plainRejection(err.reasonText)`.
  - `RegistrarUnavailableError` → rethrown, so the job retries.
  - Then `continueRegistration(deps, companyId)` (Task 28; a no-op stub until then).

- [ ] **Step 1: Write the failing tests**
  - `texting-provision.test.ts`:
    - `test('a new company gets a texting subaccount, once')`:
      - two ticks → one `ensureSubaccount` call
      - the stored token decrypts to `fake-token-<8>`
      - `signingTokenFor` returns it
    - `test("nothing happens when texting isn't set up")`.
    - `test('canceled companies are skipped')`.
  - `texting-submit.test.ts`:
    - `test('submitting needs the owner, a confirmed email and a card')` → 403 ×3 with the exact messages.
    - `test('submit saves, queues and answers waiting')` → 202 `state 'waiting'`; `t.jobs.sent` equals `[{name:'texting-registration', data:{companyId}}]`.
    - `test('a second submit while waiting is refused')` → 409.
    - `test('the job submits the brand and records the fee once')`:
      - drain → `registrar.calls` has `submitBrand` with `statusCallback 'https://app.roofline.test/hooks/twilio-registration'`
      - one `texting_registration_fee` row: 4400, "Texting registration: business check"
      - draining again adds no fee
    - `test('a refused brand needs a fix')`: `failNext('submitBrand', {rejected:'EIN does not match'})` → `GET` → `state 'needs_fix'`, `rejectedFields ['legalName','ein']`, and the EIN reason.
    - `test('fix and resubmit sends the previous ids')`.
    - `test('the form defaults come from the company')`.
    - `test('a field error names the brand field')`: `ein '12'` → field `brand.ein`.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the API suite.** Expected: PASS.

- [ ] **Step 5: Commit.** `feat(texting): subaccount at sign-up; submit the registration and send the brand`

---

### Task 28: Registration progress: callbacks, poll, number, fees

**Split:**
- Builder 1: `account/texting/progress.ts`.
- Builder 2: `hooks/twilio-registration.ts`, `poll-texting.ts` and `system/texting.ts` additions.
- Builder 3: `bill-monthly-fees.ts` and the tests.

**Files:**
- Modify: `apps/api/src/account/texting/progress.ts`, `apps/api/src/hooks/twilio-registration.ts`, `apps/api/src/jobs/scheduler/{poll-texting,bill-monthly-fees}.ts`, `packages/db/src/system/texting.ts`
- Test: `apps/api/test/texting-progress.test.ts`, `apps/api/test/texting-recorded.test.ts`

**Interfaces:**
```ts
export async function continueRegistration(deps: AppDeps, companyId: string): Promise<void>;
export async function companyIdForTextingSid(system: Db, sid: string): Promise<string | null>;   // any of subaccount, profile, trust, brand, campaign, service sid
export async function registrationsToCheck(system: Db, now: Date): Promise<string[]>;
export async function addMainNumber(system: Db, companyId: string, n: { e164: string; providerSid: string; capabilities: string[] }): Promise<void>;
export async function companiesWithTextingFees(system: Db): Promise<string[]>;
export async function pollTexting(deps: AppDeps, now: Date): Promise<void>;
export async function billMonthlyFees(deps: AppDeps, now: Date): Promise<void>;
```
- **`continueRegistration`,** under the lock; every step sets `last_checked_at`:
  1. **Brand pending** → `brandStatus`:
     - `failed` → `rejected`, with `plainRejection(failureReason)`
     - `approved` → `brand_status 'approved'`
  2. **Brand approved, no `campaign_sid`:**
     - `ensureMessagingService(sub, companyId, {inbound: PUBLIC_BASE_URL + '/hooks/twilio/sms', status: PUBLIC_BASE_URL + '/hooks/twilio/status'})`
     - then `submitCampaign` with `buildCampaign({companyName, companyPhone, ...policyUrls})` and `previousCampaignSid`
     - save `messaging_service_sid` and `campaign_sid`
     - record the fee: `texting_registration_fee`, `campaign_vetting`, ref `('texting_campaign', campaignSid)`, "Texting registration: carrier review"
  3. **Campaign pending** → `campaignStatus`:
     - `failed` → `rejected`, with `plainRejection(failureReason)`
  4. **Campaign approved, no main number:**
     - Only while `hasPaymentMethod`.
     - `ensureNumber({messagingServiceSid, areaCode: the company phone's NPA, state: address_state})`.
     - `addMainNumber` with purpose `main`, status `active`.
     - Record the fee: `phone_number_month`, `phone_number_monthly`, ref `(phone_number, <PN sid>:<YYYY-MM>)`, `Texting number (402) 555-0100 — October 2026`, with the number and the month (company zone) filled in.
     - `campaign_status 'approved'`, `approved_at`.
  
  A resubmission after a campaign failure only re-runs from step 2.
- **`POST /hooks/twilio-registration`:**
  - Accepts form or JSON bodies.
  - Every string value matching `/^(AC|BU|BN|QE|MG)[0-9a-f]{32}$/` is tried with `companyIdForTextingSid`. None → 404.
  - The signature (`X-Twilio-Signature`) is checked with `signingTokenFor(company)`. A failure → 403.
  - Then `jobs.send('texting-registration', {companyId}, {singletonKey: companyId})` → 200.
  - The payload's statuses are never used: the job asks the provider.
- **`registrationsToCheck`:** `pending` registrations whose `last_checked_at` is null or older than:
  - 1 hour in the brand stage (no `campaign_sid`)
  - 24 hours in the campaign stage
  
  It also includes registrations submitted with no `brand_sid` for over 1 hour (a stuck stage 1).
- **`pollTexting`** runs `advanceRegistration` for each, in a try/catch.
- **`billMonthlyFees`**, per company and month (the unique ref makes a second run a no-op):
  - each active main number: `phone_number_month`, ref `<PN>:<YYYY-MM>`
  - each approved campaign: `texting_registration_fee`, `campaign_monthly`, ref `('texting_campaign_month', <QE>:<YYYY-MM>)`, `Texting registration: monthly carrier fee — October 2026`

- [ ] **Step 1: Write the failing tests**
  - `test("brand approved → campaign submitted with the company's details, fee once")`: the `ensureMessagingService` URLs, the `submitCampaign` campaign equals `buildCampaign(...)`, and one 1500 fee after two advances.
  - `test('campaign approved → a number in the area code, saved as main, texting on')`:
    - company phone `+14025550199` → `ensureNumber {areaCode:'402', state:'NE'}`
    - the `company_phone_numbers` row has `capabilities ['sms','voice']` and `purpose 'main'`
    - `GET /api/texting` → `state 'approved'`, `number '+14025550100'`
    - `textingCompanyFacts(...).campaignStatus === 'approved'`
  - `test('a failed campaign shows Fix and resubmit')` → `needs_fix`; the resubmit passes `previousCampaignSid`.
  - `test('buying the number waits for a working card')`: `past_due` → no `ensureNumber`; `active` → bought.
  - `test('a signed callback wakes the registration')`:
    - a signed POST with `BrandRegistrationSid` → `t.jobs.sent` gains one
    - a bad signature → 403
    - an unknown sid → 404
  - `test('the poll checks brands hourly and campaigns daily')`.
  - `test('monthly fees are recorded once per month')`: two runs on 2026-11-01 → one number row and one campaign row; 2026-12-01 → two more.
  - `texting-recorded.test.ts`: `test("with Twilio's recorded answers, a registration goes from submitted to approved, and a rejection to Fix and resubmit")` (spec §5.6, "a recorded fake of Twilio's registration API"):
    - `deps.registrar` is built from the real `TwilioAccounts` + `TwilioBrands` over Task 25's `fixtureFetch`, serving Tasks 25–26's fixtures in sequence.
    - The `brand-*` and `campaign-*` fixtures play the pending → approved path, then the failed path.
    - Expect the states `waiting` → `approved` and a `company_phone_numbers` main row; on the failed path, `needs_fix` with the plain reason.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the full suite.** `npm run lint && npm run typecheck && npx vitest run`. Expected: PASS.

- [ ] **Step 5: Commit.** `feat(texting): registration progress by callback and poll; main number and monthly fees`

---

### Task 29: Design kit additions: Checkbox, ProgressBar, ProgressRing, FilePicker, Banner

**Split:**
- Builder 1: Checkbox and FilePicker.
- Builder 2: ProgressBar and ProgressRing.
- Builder 3: Banner and the tests.

**Files:**
- Create: `packages/ui/src/components/{Checkbox,ProgressBar,ProgressRing,FilePicker,Banner}/*`
- Modify: `packages/ui/src/index.ts`
- Test: `packages/ui/test/f3-components.test.tsx`

**Interfaces:**
```ts
Checkbox(props: { checked: boolean; onChange(next: boolean): void; label: ReactNode; description?: string; error?: string; disabled?: boolean })
ProgressBar(props: { value: number; max: number; label: string })
ProgressRing(props: { done: number; total: number; label: string; size?: 24 | 32 })
FilePicker(props: { label: string; buttonLabel: string; dropLabel: string; accept: string; onFile(file: File): void; help?: string; error?: string; busy?: boolean })
Banner(props: { tone: 'info' | 'warning' | 'danger'; children: ReactNode; action?: ReactNode })
```
- **Checkbox:**
  - a native `input type="checkbox"` inside a `<label>`
  - `data-state="checked"` or `"unchecked"`
  - the error has `role="alert"`, and `aria-invalid` is set with it
  - a 40px hit area
- **ProgressBar:** `role="progressbar"` with `aria-valuenow`, `aria-valuemax` and `aria-label`.
- **ProgressRing:** an SVG with `role="img"` and `aria-label={label}`, plus `data-complete` when `done >= total`.
- **FilePicker:**
  - a visually hidden file input, opened by a kit `Button`
  - the drop zone sets `data-state="over"` while a file is dragged over it
  - it calls `onFile` with the first file
- **Banner:**
  - `role="status"`, or `role="alert"` for `danger`
  - it takes the full width with no horizontal overflow at 375px

- [ ] **Step 1: Write the failing tests**
  - clicking the Checkbox label calls `onChange(true)`
  - the ProgressBar `aria-valuenow` is 40
  - the ProgressRing label, and `data-complete` at 5/5
  - FilePicker: `userEvent.upload` calls `onFile` with the file
  - Banner: `danger` is an alert and `warning` a status

- [ ] **Step 2: Run them and see them fail.** `npx vitest run --project @roofline/ui`

- [ ] **Step 3: Implement** with tokens only.

- [ ] **Step 4: Run the tests and lints.** `npx vitest run --project @roofline/ui && npm run lint && npm run lint:css`. Expected: PASS.

- [ ] **Step 5: Commit.** `feat(ui): checkbox, progress bar and ring, file picker, banner`

---

### Task 30: Web skeleton for the F3 screens

**Split:**
- Builder 1: the router and Settings wiring.
- Builder 2: the Shell and UserMenu slots, plus the placeholders.
- Builder 3: the copy files and the tests.

**Files:**
- Create:
  - placeholder components (each renders `EmptyState` with its copy's `comingSoon` line):
    - `features/signup/SignUp.tsx`
    - `features/setup/{SetupTab,SetupRing}.tsx`
    - `features/billing/{BillingTab,ShellBanners}.tsx`
    - `features/imports/ImportWizard.tsx`
    - `features/texting/TextingSetup.tsx`
  - `apps/web/src/features/{signup,setup,billing,imports,texting}/api.ts` (empty modules)
  - `apps/web/src/copy/import.ts`, `apps/web/src/copy/texting.ts`
- Modify (all F2 files):
  - `apps/web/src/app/router.tsx`
  - `apps/web/src/features/settings/Settings.tsx`
  - `apps/web/src/shell/Shell.tsx` (desktop and phone)
  - `apps/web/src/shell/topbar/UserMenu.tsx`
- Test: `apps/web/test/f3-routes.test.tsx`

**Interfaces:**
- **Routes:**
  - public: `/sign-up` → `SignUp`
  - under the session: `settings/setup/import` and `settings/setup/import/:importId` → `ImportWizard`; `settings/setup/texting` → `TextingSetup`. All three render inside the Settings window with the Setup tab current.
- **Settings tabs:** `billing` → `BillingTab` and `setup` → `SetupTab`. `connections` keeps F2's `LaterTab`.
- **Shell:** `<ShellBanners />` sits directly under the top bar on desktop and phone.
- **UserMenu:** `<SetupRing />` sits beside the avatar.
- **Placeholders:** `SetupRing` and `ShellBanners` render nothing until their tasks.

- [ ] **Step 1: Write the failing tests**
  - each new URL renders its placeholder text inside the right window or tab
  - `/settings/connections` still shows F2's text
  - `/sign-up` renders without a session

- [ ] **Step 2: Run them and see them fail.** `npx vitest run --project @roofline/web f3-routes`

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the tests, the lints and the build.** `npx vitest run --project @roofline/web && npm run lint && npm run build:web`. Expected: PASS, with the copy-rules test included.

- [ ] **Step 5: Commit.** `feat(web): routes and slots for sign-up, setup, billing, import and texting`

---

### Task 31: Web: sign-up wizard and the Google button

**Split:**
- Builder 1: `SignUp.tsx`, the two steps and `api.ts`.
- Builder 2: `GoogleButton.tsx` and the CSP.
- Builder 3: `copy/auth.ts`, the SignIn link and the tests.

**Files:**
- Create: `apps/web/src/features/signup/{AccountStep,CompanyStep,GoogleButton}.tsx`
- Modify:
  - `apps/web/src/features/signup/{SignUp.tsx,api.ts}`
  - `apps/web/src/copy/auth.ts`
  - `apps/web/src/features/auth/SignIn.tsx` (a "Create an account" link and the Google button)
  - `apps/api/src/web.ts` (CSP)
- Test: `apps/web/test/signup.test.tsx`, `apps/api/test/web.test.ts` (extend)

**Interfaces:**
- **Consumes:**
  - Task 15's `GET /api/auth/config` → `{ googleClientId: string | null }`.
  - The sign-up and Google body fields `companyName`, `companyPhone`, `companyAddress`.
- **CSP additions:**
  - `script-src https://accounts.google.com/gsi/client`
  - `frame-src https://accounts.google.com/gsi/`
  - `connect-src https://accounts.google.com/gsi/`
  - `style-src https://accounts.google.com/gsi/style`
- **Hooks in `features/signup/api.ts`:** `useAuthConfig()`, `useSignUp()` (POST `/api/auth/signup`), `useGoogleSignIn()` (POST `/api/auth/google`).
- **`SignUp`:**
  - **Step 1** has three inputs (Your name, Email, Password with at least 10 characters) and a Continue button, or the Google button.
  - **Step 2** has exactly three inputs (Company name, Business phone, Business address) and "Start my free trial".
  - **On success:** `invalidateQueries(keys.me)`, then `navigate('/settings/setup', {replace: true})`.
  - **Field errors:**
    - `email` or `password` returns to step 1 with the error under that field
    - `companyName`, `companyPhone` or `companyAddress` stays on step 2
  - **Google:**
    - POST `{credential}` → 200 → `navigate('/')`.
    - A 400 on field `companyName` → step 2, holding the credential in memory. Then POST `{credential, companyName, companyPhone, companyAddress}`.
- **`GoogleButton({ clientId, onCredential })`:**
  - Loads `https://accounts.google.com/gsi/client` once.
  - Calls `google.accounts.id.initialize({client_id, callback})` and `renderButton`.
  - Renders nothing when `clientId` is null.
- **Copy (`auth.ts`):**
  - `signUpTitle` "Start your free trial"
  - `trialNote` "14 days free. No card needed."
  - `yourName` "Your name"
  - `continue` "Continue"
  - `companyName` "Company name"
  - `businessPhone` "Business phone"
  - `businessAddress` "Business address"
  - `addressHelp` "Street, city, state and ZIP"
  - `startTrial` "Start my free trial"
  - `haveAccount` "Already have an account? Sign in"
  - `createAccount` "Create an account"
  - `googleFallback` "Sign in with Google"

- [ ] **Step 1: Write the failing tests**
  - `signup.test.tsx` (stubbed `fetch`):
    - `it('signs up in two steps and opens Setup')`: the POST body has exactly `name, email, password, companyName, companyPhone, companyAddress`, and the location is `/settings/setup`.
    - `it('shows a taken email back on step 1')`: 409 field `email`.
    - `it('shows an address problem on step 2')`.
    - `it('Google: an existing account goes to the map, a new one asks for the company')` (a fake `window.google.accounts.id`).
    - `it('step 2 has three inputs')`.
  - `web.test.ts`: the CSP contains `https://accounts.google.com/gsi/client`.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the tests, lints and build.** Expected: PASS.

- [ ] **Step 5: Commit.** `feat(web): self-serve sign-up in two short steps, with Sign in with Google`

---

### Task 32: Web: the Setup window and the progress ring

**Split:**
- Builder 1: `SetupTab.tsx` and `SetupRow.tsx`.
- Builder 2: `CompanyBasicsSheet.tsx` and `SetupRing.tsx`.
- Builder 3: `copy/setup.ts`, `api.ts` and the tests.

**Files:**
- Create: `apps/web/src/features/setup/{SetupRow,CompanyBasicsSheet}.tsx`
- Modify: `apps/web/src/features/setup/{SetupTab,SetupRing,api}.tsx|ts`, `apps/web/src/copy/setup.ts`
- Test: `apps/web/test/setup.test.tsx`

**Interfaces:**
- **Hooks:** `useSetup()` (GET `/api/setup`, refetched on focus and every 60 s), `useSkip(key)`, `useUnskip(key)`, `useLocateCompany()`, `useServiceArea()`.
- **Rows,** in API order. Each shows its title, description, the "Unlocks …" line, a status chip and one primary action.
- **Status chips:**
  - `todo` "To do", `in_progress` "Started", `done` "Done", `skipped` "Skipped"
  - `waiting` "Waiting on phone carriers (usually 10–15 days)"
  - a rejected registration "Needs a fix"
  - `comingWith` → "Coming with the Estimator", "Coming with the calendar", "Coming with Front Desk", "Coming with Storm Scout"
- **Actions:**
  - `company_basics` → "Check details" opens `CompanyBasicsSheet`:
    - "Place on map" when not located
    - a radius `Select` of 10/20/40/60 miles
    - "Edit company details" → `/settings/company`
  - `import_customers` → "Import customers" → `/settings/setup/import`
  - `texting_registration` → "Start", or "Fix and resubmit" → `/settings/setup/texting`; none while waiting or done
  - `invite_team` → "Invite" → `/settings/team`
  - `payment_method` → "Add a card" → `/settings/billing`
  - skippable rows also offer "Skip for now" or "Undo skip"
- **Who acts:** only the owner. Others get no action buttons and the note "Your owner finishes setup."
- **`SetupRing`:** `ProgressRing done/total` with the label `${done} of ${total} setup steps done`. Hidden when complete. Clicking it goes to `/settings/setup`.
- **Copy:** titles, descriptions and "Unlocks" lines (vendor names allowed here):
  - `company_basics`: "Your company on the map" — "Your name, address and the area you work in."
  - `import_customers`: "Bring in your customers" — "Upload a spreadsheet from your old system." — "Unlocks storm texts to your existing customers"
  - `texting_registration`: "Register for texting" — "Phone carriers approve your business before you can text customers." — "Unlocks all texting"
  - `invite_team`: "Invite your team" — "Add your office staff and reps."
  - `payment_method`: "Add a card" — "Needed before anything that costs money, like texting. Card payments run through Stripe." — "Unlocks texting registration and exact roof reports"
  - `prices_and_tiers`: "Prices and Good/Better/Best" — "Your pricebook for estimates." — "Unlocks the Estimator"
  - `connect_calendar`: "Connect your calendar" — "Google or Outlook, so bookings land on your calendar." — "Unlocks Front Desk booking"
  - `phone_number`: "Your Roofline phone number" — "Forward your business line so every call is answered." — "Unlocks Front Desk"
  - `connect_ads`: "Connect your ad accounts" — "Link Google Ads and share your Meta ad account." — "Unlocks storm ads"

- [ ] **Step 1: Write the failing tests**
  - `it('lists nine steps with their chips')`: the `waiting` text is exact.
  - `it('later steps say what they come with')`.
  - `it('the owner skips the import and the ring moves')`: 1 of 5, then 2 of 5.
  - `it('office sees no buttons')`.
  - `it('a rejected registration offers Fix and resubmit')`.
  - `it('the ring hides when setup is done')`.
  - `it('the basics sheet places the company and sets the radius')`: PUT body `{radiusMiles: 20}`.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the tests, lints and build.** Expected: PASS.

- [ ] **Step 5: Commit.** `feat(web): Setup window with live statuses and a progress ring`

---

### Task 33: Web: the Billing tab and the banners

**Split:**
- Builder 1: `BillingTab.tsx`, `PlanPicker.tsx` and `UsageMeters.tsx`.
- Builder 2: `ShellBanners.tsx`.
- Builder 3: `copy/billing.ts`, `api.ts` and the tests.

**Files:**
- Create: `apps/web/src/features/billing/{PlanPicker,UsageMeters}.tsx`
- Modify: `apps/web/src/features/billing/{BillingTab,ShellBanners,api}.tsx|ts`, `apps/web/src/copy/billing.ts`
- Test: `apps/web/test/billing.test.tsx`

**Interfaces:**
- **Hooks:** `useBilling()`, `useCheckout()`, `usePortal()`, `useChangePlan()`. Each returned URL is followed with `window.location.assign(url)`.
- **`BillingTab`:**
  - **Owner:**
    - the plan and status (trial: `Free trial until ${date}`)
    - `UsageMeters`: `${used} of ${included} text segments` or `${used} of ${included} AI call minutes`; with no plan, `${used} so far`
    - `PlanPicker`: each plan's name, `$199/month` (whole-dollar `Intl` formatting) and its included amounts
      - "Pick this plan" → checkout
      - "Switch to this plan" when subscribed → change plan
    - "Invoices and card" → portal, shown when `canOpenPortal`
  - **`?checkout=done`** → the toast "Thanks! Your plan is set up." and a refetch of `keys.me` and billing.
  - **Others:** `EmptyState` "Only the owner can see billing."
- **`ShellBanners`,** from `useMe().company.status`:
  - **`trial_ended`:** "Your free trial has ended. Your data is safe and you can still look around." plus the button "Pick a plan to keep going" → `/settings/billing`.
  - **`canceled`:** "Your plan was canceled. Your data is safe and you can still look around." with the same button.
  - **`past_due`:** "Your payment didn't go through. Texts and calls are paused until it's fixed." For the owner, the button "Fix payment" → portal; for others, "Ask your owner to update the card."
  - Nothing for `trial` or `active`.
- **Copy:** in `billing.ts`, where "Stripe" is allowed, e.g. `cardNote` "Card payments run through Stripe."

- [ ] **Step 1: Write the failing tests**
  - `it('owner sees the plan, usage and plans')`: "6 so far", "$199/month".
  - `it('Pick this plan goes to checkout')`: `location.assign` is called with the fake URL.
  - `it('subscribed owners switch plans in place')`.
  - `it('office sees the owner-only note')`.
  - `it('trial ended shows the pick-a-plan banner')`: the button text is exact.
  - `it('past due shows the payment banner')`: the text is exact; the owner gets "Fix payment".
  - `it('no banner while in trial or active')`.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the tests, lints and build.** Expected: PASS.

- [ ] **Step 5: Commit.** `feat(web): billing page, plan picker and the trial and payment banners`

---

### Task 34: Web: the import wizard

**Split:**
- Builder 1: the Upload and Mapping steps.
- Builder 2: the Preview and Consent steps.
- Builder 3: the Progress and Summary step, `api.ts`, the copy and the tests.

**Files:**
- Create: `apps/web/src/features/imports/{UploadStep,MappingStep,PreviewStep,ConsentStep,ProgressStep}.tsx`
- Modify: `apps/web/src/features/imports/{ImportWizard,api}.tsx|ts`, `apps/web/src/copy/import.ts`
- Test: `apps/web/test/import-wizard.test.tsx`

**Interfaces:**
- **Hooks:**
  - `uploadImport(file: File): Promise<ImportView>`: `fetch('/api/imports?fileName=' + encodeURIComponent(file.name), { method: 'POST', body: file, credentials: 'same-origin', headers: { 'Content-Type': file.type || 'application/octet-stream' } })`, with errors mapped to `ApiError` the way `apiFetch` maps them
  - `useImport(id, attested)`: polls every 2 s while `queued` or `processing`
  - `useSetMapping(id)`, `useStartImport(id)`, `useRetryImport(id)`
- **`ImportWizard`:**
  - Step from the URL: `/settings/setup/import` is the upload; `/settings/setup/import/:importId` derives the step from the status, plus local step state.
  - **Upload:** `FilePicker` accepting `.csv,.xlsx`, with the help "CSV or Excel, up to 20,000 rows." After the upload → `navigate(':importId')`.
  - **Mapping:** one `Select` per `IMPORT_FIELDS` entry, with the file's columns and "Don't import".
  - **Preview:**
    - a table of the 20 preview rows (no horizontal page scroll at 375px: the table scrolls inside its own box)
    - the count lines: `${n} new customers`, `${n} already in Roofline (we'll fill in what's missing)`, `${n} will be skipped`, with the reasons listed
  - **Consent:**
    - `Checkbox`, unchecked by default, with the label `consentAttestationText(company.name)`
    - unchecked note: "Without this, imported customers only get texts about their own jobs, like appointment reminders. Storm check-ins and offers won't go to them."
    - the counts update from `?attested=`: `optedOutKept(n)` → `${n} customers previously opted out, and their texting stays off`, or `1 customer previously opted out, and their texting stays off`
    - the "Import" button sends `{consentAttested, consentText}` (the text only when checked) and is `busy` while pending
  - **Progress:** `ProgressBar processed/total` with the label "Importing your customers".
  - **Summary:**
    - the counts
    - "Download skipped rows" (an anchor to `skippedDownloadUrl` with `download`), shown when there are skipped rows
    - `failed` → its `errorPlain` and "Try again"

- [ ] **Step 1: Write the failing tests**
  - `it('uploads, maps, previews and imports')`: the start body is `{consentAttested:false}`.
  - `it('the consent box is unchecked and sends the exact text when checked')`.
  - `it('shows how many opted-out customers stay off')`: "12 customers previously opted out, and their texting stays off".
  - `it('shows progress, then the summary with the download link')`.
  - `it('a double click starts one import')`.
  - `it('shows the server message for a bad file')`.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the tests, lints and build.** Expected: PASS.

- [ ] **Step 5: Commit.** `feat(web): customer import wizard with the consent confirmation`

---

### Task 35: Web: the texting registration form and status

**Split:**
- Builder 1: `TextingForm.tsx`.
- Builder 2: `TextingStatus.tsx` and `TextingSetup.tsx`.
- Builder 3: `copy/texting.ts`, `api.ts` and the tests.

**Files:**
- Create: `apps/web/src/features/texting/{TextingForm,TextingStatus}.tsx`
- Modify: `apps/web/src/features/texting/{TextingSetup,api}.tsx|ts`, `apps/web/src/copy/texting.ts`
- Test: `apps/web/test/texting.test.tsx`

**Interfaces:**
- **Hooks:** `useTexting()`, `useSubmitRegistration()`.
- **`TextingSetup`:** `not_started` and `needs_fix` → the form; `waiting` and `approved` → the status.
- **`TextingForm`:**
  - one `Field`/`Select` per `BRAND_FIELDS` entry, prefilled from `brand ?? defaults`
  - the business type options: LLC, Corporation, Partnership, Non-profit
  - the `Checkbox` "Use the Roofline page for your privacy policy and terms", on by default when the website is empty; it shows the two hosted URLs
  - the line "What you'll text: Customer care + marketing (mixed)"
  - `needsPaymentMethod` → a `Banner` "Add a card first. Texting registration has a carrier fee." with a link to `/settings/billing`, and submit disabled
  - `needsVerifiedEmail` → a `Banner` "Please confirm your email first. We sent you a link."
  - **In `needs_fix`:**
    - the reason sits at the top
    - every field in `rejectedFields` shows `error={copy.texting.checkThis}` ("Please check this.")
    - the button reads "Fix and resubmit"
  - **Server field errors** `brand.<field>` show under that field.
- **`TextingStatus`:**
  - `waiting`: "Waiting on phone carriers (usually 10–15 days)" and the submitted date
  - `approved`: "Texting is on. Your number is (402) 555-0100."

- [ ] **Step 1: Write the failing tests**
  - `it('prefills from the company and submits')`: the body is `{brand:{…13 fields…}, useHostedPolicyPages:true}`.
  - `it('needs a card first')`: submit is disabled.
  - `it('shows the reason and highlights fields on a rejection')`: EIN and legal name have errors, and the button is "Fix and resubmit".
  - `it('shows waiting after submit')`.
  - `it('shows the number once approved')`.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run the tests, lints and build.** Expected: PASS.

- [ ] **Step 5: Commit.** `feat(web): texting registration form, carrier status, Fix and resubmit`

---

### Task 36: End-to-end tests, the acceptance map and the docs

**Split:**
- Builder 1: `stack.ts`/`fixtures.ts` changes, plus `signup.spec.ts` and `setup.spec.ts`.
- Builder 2: `import.spec.ts`, `billing.spec.ts`, and the phone and axe additions.
- Builder 3: `f3-acceptance.md`, `f1-followups.md` and the README deploy notes.

**Files:**
- Create: `apps/web/e2e/{signup,setup,import,billing}.spec.ts`, `apps/web/e2e/fixtures/customers-25.csv`, `docs/superpowers/f3-acceptance.md`
- Modify:
  - `apps/web/e2e/stack.ts` (`FAKE_PROVIDERS=1` for both children), `apps/web/e2e/fixtures.ts` (`setCompanyStatus(status)`)
  - `apps/web/e2e/phone.spec.ts`, `apps/web/e2e/a11y.spec.ts`
  - `docs/superpowers/f1-followups.md`, `README.md`

**Interfaces:**
- **`customers-25.csv`:** 25 data rows:
  - rows 1–20 valid and unique
  - rows 21–23 bad phones
  - rows 24–25 repeat the phones of rows 1–2
  
  → new 20, updated 0, skipped 5.
- **`setCompanyStatus(status)`:** SQL `update companies set status = $1 where slug = 'acme-roofing'`.

- [ ] **Step 1: Write the failing tests**
  - **`signup.spec.ts`:** `test('a new roofer reaches the map with Setup open in under 2 minutes, no card')`:
    1. `const start = Date.now()`; `goto('/sign-up')`.
    2. Fill Your name, Email (unique per run) and Password; click Continue.
    3. Assert the company step has exactly 3 inputs; fill `Acme Test Roofing`, `(402) 555-0177` and `1200 Farnam St, Omaha, NE 68102`; click "Start my free trial".
    4. Expect `toHaveURL(/\/settings\/setup$/)`, the dialog "Settings", and "Your company on the map" with "Done".
    5. `expect(Date.now() - start).toBeLessThan(120_000)`; `getByText(/card number/i)` has count 0.
  - **`setup.spec.ts`:**
    - `test('skip the import and the ring moves')`
    - `test('later steps say Coming with')`
  - **`import.spec.ts`:** `test('import a spreadsheet, with consent, and download the skipped rows')`:
    1. As the owner: `/settings/setup/import`, `setInputFiles` the CSV.
    2. The preview shows "20 new customers" and "5 will be skipped"; check the consent box; Import.
    3. The summary appears within 30 s.
    4. `waitForEvent('download')` → `suggestedFilename() === 'skipped-rows.csv'`, with 6 lines.
  - **`billing.spec.ts`:**
    - `test('trial ended: banner, read-only message on a save')`: `setCompanyStatus('trial_ended')`, reload → the banner button "Pick a plan to keep going"; saving the company phone → the toast with the trial message.
    - `test('past due: the payment banner')`.
  - **`phone.spec.ts`:** `/sign-up`, `/settings/setup`, `/settings/billing` and `/settings/setup/import` → `scrollWidth <= 375`.
  - **`a11y.spec.ts`:** `/sign-up` and `/settings/setup` have no serious or critical violations.

- [ ] **Step 2: Run them and see them fail.** `npm run e2e`

- [ ] **Step 3: Implement the stack change** and fix whatever the runs expose.

- [ ] **Step 4: Write the docs.**
  - **`f3-acceptance.md`:** map every §5.6 bullet to its test (file and test name), as `f1-acceptance.md` does. The manual smoke bullets point at Task 37's runbook.
  - **`f1-followups.md`:** move each F3 blocker to a "Done in F3" list with its task number.
  - **README "Running in production":**
    - Boot order adds `npm run sync:stripe-plans -w @roofline/api` before the first deploy and after every price change.
    - The Stripe webhook endpoint `/hooks/stripe` with its five events.
    - The Twilio registration callback `/hooks/twilio-registration`.
    - A wildcard DNS `*.<POLICY_PAGES_DOMAIN>` pointing at the API service.
    - Owner to-dos:
      - keep Twilio Advanced Opt-Out on with its default keywords
      - have the lawyer review the policy templates and the consent sentence
      - set the real `BILLING_PLANS_FILE`
      - set `TWILIO_PRIMARY_PROFILE_SID`

- [ ] **Step 5: Run everything.** `npm run lint && npm run lint:css && npm run typecheck && npx vitest run && npm run e2e && (cd v1 && npm test)`. Expected: all PASS.

- [ ] **Step 6: Commit.** `test(e2e): sign-up under 2 minutes, setup, import and billing banners; F3 acceptance map`

---

### Task 37: The manual smoke suite (Stripe test clock, a real test brand)

**Split:**
- Builder 1: `stripe-test-clock.ts`.
- Builder 2: `texting-real-brand.ts` and `guards.ts`.
- Builder 3: the runbook and the guard tests.

**Files:**
- Create: `apps/api/src/scripts/smoke/{guards,stripe-test-clock,texting-real-brand}.ts`, `docs/superpowers/f3-manual-smoke.md`
- Modify: `apps/api/package.json` (scripts `smoke:stripe` and `smoke:texting`)
- Test: `apps/api/test/smoke-guards.test.ts`

**Interfaces:**
```ts
export function assertStripeTestKey(key: string | undefined): string;   // throws unless it starts with sk_test_
export function assertConfirmed(argv: readonly string[], flag: '--confirm-real-registration'): void;
```
- **`smoke:stripe`:**
  1. Create a test clock at now, and a customer on it with `pm_card_visa`.
  2. Subscribe to the starter prices (by lookup key) with `trial_end` = clock + 14 days.
  3. Report meter events (`sms_segment` 6, `ai_call_minute` 4) and an invoice item of 5400 "Exact roof report — 812 Oak St (smoke)".
  4. Advance the clock 15 days and wait for it to be ready.
  5. Print the latest invoice's lines and amounts and the dashboard links.
- **`smoke:texting`:** with `--confirm-real-registration` and `SMOKE_BRAND_JSON` (Roofline's own brand), run `TwilioAccounts`/`TwilioBrands` against a dedicated subaccount.
  - `--submit` submits the brand.
  - `--status` prints the brand and campaign statuses.
  - `--campaign` submits the campaign once the brand is approved.
- **Runbook (`f3-manual-smoke.md`):** each step, its command, and the expected result.
  - The Stripe dashboard shows the meter events and the invoice item on the clock's invoice.
  - One real registration of Roofline's test brand moves to approved.
  - The hosted pages render on the real domain.
  - Geocodio answers for one known address.
  - Postmark delivers a test email.
  - The TrustHub policy SIDs in `brands.ts` match Twilio's ISV guide.

- [ ] **Step 1: Write the failing tests.**
  - `assertStripeTestKey('sk_live_x')` throws.
  - `assertConfirmed([], '--confirm-real-registration')` throws.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement the scripts and write the runbook.**

- [ ] **Step 4: Run the tests and lint.** Expected: PASS. The scripts themselves are run only by hand.

- [ ] **Step 5: Commit.** `test(smoke): Stripe test-clock run and a real test-brand registration, by hand only`

---

## Rulings

1. **All F3 schema is in Task 1's two migrations (0010, 0011).** No later task adds a migration, which keeps the drizzle journal and snapshots conflict-free.
2. **Task 1 installs every new npm dependency** (`stripe`, `csv-parse`, `exceljs`). No later task edits `package-lock.json`.
3. **Skeleton tasks pre-create the shared hotspots:**
   - Task 1: placeholder modules and barrel lines
   - Task 9: config, deps, mounts, schedules and job queues
   - Task 30: routes and slots
   
   Feature tasks then edit only their own files.
4. **Two new folders may import `@roofline/db/system`:**
   - `apps/api/src/account/**`: owner-only billing, setup and registration work that writes `app_system`-only company state
   - `apps/api/src/public/**`: the hosted policy pages
5. **The plan config is a JSON file** named by `BILLING_PLANS_FILE`, with the spec's snake_case keys.
   - The repo commits only `config/billing-plans.example.json` with placeholder values for dev and tests; a test proves no price appears in source.
   - Stripe prices are found by lookup key, never by stored IDs.
6. **Company status from a Stripe subscription status:**
   - `trialing`/`active` → `active`
   - `past_due`/`unpaid` → `past_due`
   - `canceled`/`incomplete_expired` → `canceled`
   - anything else unchanged
   
   The newest event wins, by `companies.billing_event_at`. `invoice.paid` only clears `past_due`.
7. **Checkout passes `trial_end` only when `trial_ends_at` is at least 48 hours away** (Stripe's minimum). Otherwise billing starts at checkout.
8. **Read-only mode** (`trial_ended`, `canceled`): every non-GET under `/api` gets 403 with a plain message, except `/api/auth/*`, `/api/billing/*` and `/api/me/*`.
   - `past_due` is not read-only: the send gate's `billing` rule pauses texts, as the spec says.
   - A customer CSV export waits for Core CRM; every GET keeps working.
9. **Plans and invoices:** a first plan goes through Checkout; a plan change for an existing subscription is a server-side subscription update; invoices are reached through the Stripe portal.
10. **The Stripe customer is created at the first checkout,** not at sign-up, so trials that never pay leave nothing in Stripe.
11. **Meter values and keys:**
    - Meter values are whole numbers (`ceil` per usage row); MMS counts ×3.
    - Each (company, meter) batch is one meter event, with the batch id as Stripe's `identifier`.
    - Invoice items carry the idempotency key `usage:<usage id>`.
12. **Fee bookkeeping:**
    - `usage_events` gets a unique `(company_id, kind, ref_type, ref_id)` index, so each fee is recorded once.
    - Monthly number and campaign fees are recorded by a job on the 1st, with ref `<sid>:<YYYY-MM>`.
    - Unit costs come from the config's `pass_through_cents`, since Twilio's API doesn't return them per resource.
13. **Sign-up is one POST at the end of a two-step wizard.**
    - Step 2 is exactly three inputs: company name, business phone, and the business address as one line.
    - A no-match address is a field error.
    - A geocoder outage still lets sign-up succeed with the typed address; the checklist then offers "Place on map".
14. **Company basics:**
    - "Adjust on the map" ships as a radius choice (10/20/40/60 miles, default 40); freehand drawing waits for Storm Scout.
    - Logo upload waits for object storage (Core CRM), so `company_basics` is name + located address + service area.
15. **Setup statuses are derived from the real records on every read** and stored back into `setup_items`.
    - Only `import_customers` and `invite_team` can be skipped.
    - Progress counts the five Foundation items.
16. **Import rows:**
    - An in-file duplicate is skipped as "Duplicate of row N".
    - A filled but invalid phone is skipped "Bad phone number", as the spec lists, even with an email; an invalid email is dropped.
    - A phone match beats an email match.
17. **Import merging:**
    - Matched customers are filled in, never overwritten.
    - Unknown stage words become `lead`.
    - No job is created on an address that already has an open job.
    - Notes go on the customer's timeline.
18. **Uploaded rows are kept in `import_rows`** (no object storage yet). The skipped-rows CSV is generated on request. Uploads are capped at 10 MB.
19. **Property time zones on import come from the geocoder.** F1's ruling I3 leaves a zone null unless one is given, and the geocoder gives the real one.
20. **Texting registration supports businesses with an EIN** (LLC, corporation, partnership, non-profit). Sole proprietors wait for Twilio's separate sole-proprietor flow.
21. **Registration is asynchronous.**
    - The route saves the details and queues a `texting-registration` job; every provider call happens there, with retries.
    - Callbacks only wake the job: status always comes from asking the provider.
    - The job holds the registration row lock across provider calls (low volume), so callbacks and the poll never double-buy a number or double-charge a fee.
22. **The registration poll runs hourly.** The brand stage is checked at most hourly and the campaign stage at most daily (the spec's daily poll); a stuck submit is retried after an hour.
23. **Twilio's Advanced Opt-Out `OptOutType` is authoritative.** It opts a number out or in even when our classifier disagrees, and our STOP/START TwiML confirmation is omitted then, keeping a single confirmation. HELP is always answered by us.
24. **Webhook dedupe:**
    - Inbound dedupe moves into the tenant transaction: a unique `(company_id, provider_message_sid)` on inbound rows.
    - `/status` drops the global claim, because its writes are idempotent.
    - Early delivery reports are kept and applied when the send is saved.
25. **The HELP reply's contact,** in order: company phone, then email, then website, then the number they texted.
26. **Textable means a +1 number** that is not toll-free or premium (800, 833, 844, 855, 866, 877, 888, 900), not Canadian, and not in another NANP country. US territories are textable. This is enforced inside the gate's `contact` rule, so the rule order is unchanged.
27. **`SmsRefusedError` gains `permanent`, `optedOut` and `reasonPlain`,** plus a symbol brand checked by `isSmsRefusedError`.
    - Permanent refusals are never retried.
    - Twilio 21610 writes an opt-out with keyword `carrier` and revokes consent, so our records match Twilio's.
28. **Sending uses the master account credentials** on the company's subaccount path, with its Messaging Service. Messaging and TrustHub management calls use the subaccount's own credentials.
29. **`FAKE_PROVIDERS=1`** (development and test only; refused in production) swaps in deterministic fakes for Geocodio, Stripe, Twilio sending and registration. The end-to-end stack and local development use it.
30. **The hosted pages answer on `<slug>.<POLICY_PAGES_DOMAIN>`** and on `/policies/<slug>/privacy|terms`. Their text is a marked draft until the owner's lawyer reviews it.
31. **Geocodio:** only street-level results count (accuracy ≥ 0.8 and a street-level type). The base URL is a constructor option defaulting to v1.7, to be confirmed against Geocodio's docs at implementation.
32. **Long step handlers keep their lease** with `leaseKeeper` (a renewal every 60 s). A run that lost its step stops at once.
33. **Web feature hooks live in `features/<feature>/api.ts`,** not in F2's shared `api/hooks.ts`. F3 API messages live in their own modules, not in `errors.ts` `MESSAGES`.
34. **The web tasks (31–35) depend only on the shared response types,** not on the API tasks, because their unit tests stub `fetch`. Task 36's end-to-end run is what joins them to the real API.
