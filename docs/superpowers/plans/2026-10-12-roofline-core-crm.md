# Roofline Core CRM (C1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. In this repo the team script (`ops/team/roofline-team.js`) runs each task with one Sonnet lead and up to three Haiku builders on the **Split** packages.

**Goal:** Turn Foundation into the roofer's only CRM: the Jobs pipeline board with stage rules, customer and job windows with a merged timeline, creating and editing records from the screens, the built-in calendar with an availability model and per-person two-way Google/Outlook sync, ⌘K actions, the ported pricebook with single-option job quotes and their PDF, CSV export, and the Today and setup-checklist hooks.

**Architecture:**
- **Skeletons first, as F3 did.** Task 1 lays down all C1 schema (one generated and one custom migration), the npm dependency (`pdfkit`), placeholder modules and barrel lines. Task 5 lays down the API: the calendar provider seam with a deterministic fake, config keys, the `calendar-push` job queue, the `calendar-pull` schedule, and every new router mounted as a stub. Task 18 lays down the web routes, dock flags, Settings tabs and empty feature modules. Feature tasks then touch only their own files.
- **Pure rules in `@roofline/shared`:** the stage rules (`pipeline.ts`), the availability model (`availability.ts`), the view types (`crm.ts`) and CSV writing (`csv.ts`) are pure and shared by the API and the web app.
- **Calendar sync** is a provider seam (`apps/api/src/providers/calendar.ts`) with Google Calendar and Microsoft Graph adapters over plain `fetch` (tested against recorded JSON), a pg-boss job that pushes one appointment, and a 5-minute pull schedule with incremental sync cursors.
- **Everything tenant-scoped** goes through `packages/db` repos inside `withTenant`, applying `jobScope`/`customerScope`/`propertyScope`.

**Tech Stack:** as Foundation (Express 5, Drizzle, pg-boss 12, zod 4, Vitest 5, Testcontainers PostGIS, React 19, React Router 7, TanStack Query 5, MapLibre, Playwright). New: `pdfkit` (server-side PDF, already used by v1). Google Calendar API v3 and Microsoft Graph v1.0 over plain `fetch` (no SDKs).

**Spec:** `docs/superpowers/specs/2026-10-12-roofline-core-crm-design.md` (all of it; decisions are numbered there). Parents: master spec §5, §7, §8 row 2, §9, §14; Foundation spec F1–F3 for every existing rule.

**Branch:** integration branch `c1-crm`, created from `f3-setup` once F3 is complete. Task branches `c1-t<N>` from it.

---

## Global Constraints

**Code and repo (F1–F3 rules, unchanged)**
- **Language and modules:** Node ≥ 22.13, TypeScript strict, ESM; relative imports carry `.ts`/`.tsx`.
- **Enum columns:** `text` with drizzle `{ enum }` plus `enumCheck`, never `pgEnum`.
- **Tenant tables:** `company_id uuid not null`, listed in `TENANT_TABLES`, `ENABLE` + `FORCE ROW LEVEL SECURITY`, the `tenant_isolation` policy using exactly `company_id = nullif(current_setting('app.company_id', true), '')::uuid`, composite `(company_id, x_id)` foreign keys, and a `unique (company_id, id)` for anything referenced.
- **`app_system` on tenant tables:** column-level SELECT only, plus an `app_system_all` policy (the `rls.test.ts` rule).
- **`@roofline/db/system`:** only from `apps/api/src/{auth,hooks,jobs/scheduler,scripts,account,public}/**`, `apps/worker/**`, `packages/db/**` and tests. No C1 route needs it.
- **No raw query path from routes.** Every read applies the F1 scope helpers for reps.
- **Errors:** `{ error: "<plain English>", field? }`; no stack traces, codes, provider text, phone numbers or message bodies. C1 messages are constants in their own route modules (F3 Ruling 33), not in `errors.ts` `MESSAGES`.
- **Secrets:** only from env via `config.ts`; OAuth tokens encrypted with `encrypt(plain, ENCRYPTION_KEY)` from `@roofline/db`; never in a URL we log or an error.
- **Provider calls** only on the server, through the seams; tests and the end-to-end stack use fakes (`FAKE_PROVIDERS=1`).
- **Lockfile:** only Task 1 edits `package-lock.json`.

**Web (F2/F3 rules)**
- Every UI string lives in `apps/web/src/copy/*.ts` (unquoted camelCase keys); no literal text in JSX; no raw `<button>`; banned words (`JSON`, `API`, `sandbox`, `env`, `webhook`, `null`, `undefined`, and every snake_case value of an `as const` array exported by `@roofline/shared` — C1 adds `no_show`, `front_desk` etc.).
- **Vendor names** (`Google`, `Outlook`, `Microsoft`, …) only in `copy/connections.ts`, `copy/setup.ts`, `copy/auth.ts`, `copy/billing.ts`, `copy/legal.ts`. Calendar screens import vendor strings from `copy/connections.ts`.
- **Feature hooks** in `apps/web/src/features/<feature>/api.ts` on F2's `apiFetch`/`ApiError`; query keys local to the feature module (do not edit `api/keys.ts` or `api/hooks.ts`).
- **Shared response types** come from `@roofline/shared` (`crm.ts`), not from `apps/web/src/api/types.ts` (left untouched by C1 except Task 18).
- At least 12px type, WCAG AA contrast, keyboard reachable, 40px touch targets on phone, no horizontal scroll at 375px, state via `data-*` attributes, no third-party UI or calendar library (spec Decisions 7, 16).
- Windows render through `AppWindow`; every view has its own URL.

**Time**
- Instants are `timestamptz` and ISO strings on the wire. Calendar days and work hours are in the **company time zone** (`companies.timezone`), converted with `Intl` and the F1 `localDate` helpers in `packages/shared/src/time-zone.ts`; tests cover DST change days.

**Tests (spec §13)**
- No live provider calls in tests or CI. Google and Microsoft adapters are tested with recorded JSON through an injected `fetch`.
- The api/db suites run on CI (Testcontainers); locally only focused pure files run. Playwright runs desktop 1440×900 and phone 375×812 through F2's `apps/web/e2e/stack.ts`.

## Review Focus

Implied by the spec but easy to miss; each has its test in the owning task.

1. **Reps through the side doors.** A rep must not reach another rep's job, customer or address through the board, the timeline, an appointment, availability, a quote, a PDF, export or search. Every new route has a rep test and a company-B test (404). (Tasks 6–9, 15–17)
2. **Time zones.** Work hours, all-day installs, "today" and "days in stage" use the company zone, including on DST change days; the browser's zone never decides a slot. (Tasks 2, 3, 8, 9, 23)
3. **Two writers on one appointment.** A Roofline move and a Google move of the same appointment within one pull: the newer wins, the other is not lost silently (activity line), and no push/pull loop starts. (Tasks 13, 14)
4. **Tokens that die.** A revoked refresh token turns the connection to `error` once, stops pushes and pulls for it, and never blocks saving an appointment. (Tasks 12–14)
5. **Spreadsheet injection.** Exported CSV cells starting with `=`, `+`, `-`, `@`, tab or CR are neutralized. (Tasks 4, 17)
6. **Frozen quotes.** A final quote never reprices when the pricebook changes; its PDF matches its stored numbers. (Tasks 15, 16)

---

## Parallel lanes

C1 starts when F3 is merged into `f3-setup` (in particular F3 Tasks 9, 14, 16, 21, 30 and 36's e2e stack changes).

| Task | Depends on (C1) | Notes |
|---|---|---|
| 1 Schema, migrations, dependency, skeleton | — | the only lockfile and migration edits |
| 2 Shared pipeline rules | 1 | |
| 3 Shared availability model | 1 | |
| 4 Shared view types and CSV | 1 | |
| 5 API skeleton: calendar seam, config, queues, mounts | 1, 4 | the only `app.ts`/`config.ts`/`deps.ts`/`test/helpers.ts` edits |
| 6 Jobs: stage rules, next step, board, job view | 2, 4, 5 | `repos/jobs.ts`, `routes/jobs.ts` |
| 7 Customers: view, timeline, notes, server geocoding | 4, 5 | `routes/customers.ts`, `routes/properties.ts` |
| 8 Appointments API and Today | 3, 4, 5 | |
| 9 Schedule settings and availability | 3, 4, 5 | |
| 10 Google Calendar adapter | 5 | |
| 11 Microsoft Graph adapter | 5 | |
| 12 Calendar connect and the setup item | 4, 5 | `shared/setup.ts`, `repos/setup.ts` |
| 13 Calendar push job | 8, 12 | |
| 14 Calendar pull schedule | 8, 12 | uses Task 8's `updateAppointment` |
| 15 Pricebook and quotes API | 4, 5 | |
| 16 Quote PDF | 15 | |
| 17 CSV export | 4, 5 | |
| 18 Web skeleton | 4 | the only `router.tsx`/`apps.ts`/`Settings.tsx`/`tabs.ts` edits |
| 19 Web: pipeline board and list | 2, 18 | |
| 20 Web: job window | 19 | imports T19's move menu and timeline |
| 21 Web: customers list and customer window | 19, 22 | imports T19's timeline and T22's `AddHomeSheet` | |
| 22 Web: new customer, new job, add a home | 18 | |
| 23 Web: calendar views | 3, 18 | |
| 24 Web: appointment sheet with suggested times | 18 | |
| 25 Web: Settings Prices, Schedule, Your calendar; setup row | 18 | |
| 26 Web: quote editor and PDF link | 18 | |
| 27 Web: Today, ⌘K actions and recents, map focus, export buttons | 18 | `features/today`, `shell/topbar/SearchDialog*`, `shell/map` |
| 28 End-to-end tests, acceptance map, docs | 6–27 | |
| 29 Manual smoke: real Google and Outlook calendars | 10–14 | |

**Lanes that run at the same time (proposed team groups of three):**
- **Wave 1:** T1 alone (then merge).
- **Wave 2:** G1 = T2, T3, T4 (shared, file-disjoint).
- **Wave 3:** G2 = T5, T18 (API and web skeletons, disjoint).
- **Wave 4:** G3 = T6, T7, T17 · G4 = T8, T9, T15 · G5 = T10, T11, T12 · G6 = T19, T22, T23.
- **Wave 5:** G7 = T13, T14, T16 · G8 = T20, T21, T24 · G9 = T25, T26, T27.
- **Wave 6:** T28; T29 by hand.

**Shared files.** Barrels (`packages/db/src/index.ts`, `system/index.ts`, `packages/shared/src/index.ts`) get all C1 lines in Task 1. Tasks that edit the same file are chained in the table: T19 → T20/T21 (`features/jobs/MoveJob*.tsx` and `features/timeline/*` are imported, not edited); T12 is the only task editing `shared/setup.ts` and `repos/setup.ts`; T25 the only one editing `features/setup/SetupRow.tsx` and `copy/setup.ts`.

---

## File structure

```
packages/db/
  migrations/0012_crm_schema.sql  0013_crm_grants_rls.sql                                   T1
  src/schema/tenant.ts (appointments, calendar_*, member_schedules, pricebooks, quotes, quote_counters; jobs + company_settings columns)  T1
  src/repos/ board.ts (T6) timeline.ts notes.ts (T7) appointments.ts today.ts (T8) schedules.ts (T9)
             calendar.ts (T12) calendar-links.ts (T13) calendar-busy.ts (T14) quotes.ts pricebook.ts (T15) export.ts (T17)
  src/system/calendar-sync.ts (T14)
packages/shared/src/ pipeline.ts (T2) availability.ts (T3) crm.ts csv.ts (T4) setup.ts (T12 edits)
apps/api/src/
  providers/calendar.ts providers/fakes/calendar.ts (T5) providers/google-calendar.ts (T10) providers/microsoft-calendar.ts (T11)
  calendar/ oauth-state.ts tokens.ts (T12) push.ts event-text.ts (T13) pull.ts (T14)
  jobs/scheduler/calendar-pull.ts (T14)
  routes/ appointments.ts today.ts (T8) calendar.ts (T9) calendar-connect.ts (T12) timeline.ts notes.ts (T7)
          pricebook.ts quotes.ts (T15) export.ts (T17)   jobs.ts (T6) customers.ts properties.ts (T7)
  quotes/pdf.ts (T16)
apps/web/src/
  features/jobs/ features/timeline/ (T19)  features/job/ (T20)  features/customers/ (T21)  features/create/ (T22)
  features/calendar/ (T23)  features/appointments/ (T24)  features/settings/{PricesTab,ScheduleTab,CalendarConnection}.tsx (T25)
  features/quotes/ (T26)  features/today/ (T27 extends)  shell/topbar/SearchDialog.tsx searchOptions.ts (T27)
  copy/ jobs.ts job.ts customers.ts create.ts calendar.ts appointments.ts prices.ts schedule.ts quotes.ts (new), connections.ts setup.ts today.ts search.ts (extended)
apps/web/e2e/ crm.spec.ts calendar.spec.ts (T28), phone.spec.ts a11y.spec.ts (T28 extends)
docs/superpowers/ c1-acceptance.md c1-manual-smoke.md (T28, T29)
```

---

### Task 1: Dependency, C1 schema and the module skeleton

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

- [ ] **Step 1: Write the failing tests.**
  - `migrations.test.ts`: `test('C1 tables are tenant tables with RLS forced')` (the eight tables); `test('an appointment cannot end before it starts')` → `23514`; `test('one calendar connection per person per company')` → `23505`; `test('quote numbers are unique per company')` → `23505` in A, success in B; `test('stuck_after_days accepts 3 to 90')` → 2 is `23514`.
  - `rls.test.ts`: extend the grants lists (app_tenant relations incl. the two DELETE grants, the `app_system` column grant and `app_system_all` table list now including `calendar_connections`).
- [ ] **Step 2: Run them and see them fail.** `npx vitest run --project @roofline/db` (CI: `ops/bin/ci-check`).
- [ ] **Step 3: Implement.** Generate `0012`; write `0013` by hand; `npm install pdfkit -w @roofline/api && npm install -D @types/pdfkit -w @roofline/api`.
- [ ] **Step 4: Run the db suite, then everything.** `npx vitest run --project @roofline/db && npm run typecheck && npm run lint && npx vitest run`. Expected: PASS; F1–F3 counts unchanged except the extended lists.
- [ ] **Step 5: Commit.** `feat(db): C1 schema (appointments, calendar sync, schedules, pricebook, quotes) and module skeleton`

---

### Task 2: Shared pipeline rules

**Split:** Builder 1 the rules; Builder 2 the tests.

**Files:**
- Modify: `packages/shared/src/pipeline.ts`
- Test: `packages/shared/test/pipeline.test.ts`

**Interfaces:**
```ts
export const BOARD_STAGES = ['lead', 'inspection', 'proposal', 'won', 'installed'] as const;   // Lost is the drawer
export type BoardStage = (typeof BOARD_STAGES)[number];
export const STUCK_STAGES: readonly JobStage[] = ['lead', 'inspection', 'proposal'];
export const BOARD_INSTALLED_DAYS = 30;
export const NEXT_STEP_MAX = 120;
export const LOST_REASON_MAX = 200;
export type StageMove = { from: JobStage; to: JobStage; valueCents: number | null; lostReason: string | null };
export type StageMoveProblem = { field: 'stage' | 'lostReason' | 'valueCents'; problem: 'installed_needs_won' | 'lost_needs_reason' | 'won_needs_value' };
export function stageMoveProblem(m: StageMove): StageMoveProblem | null;
export function daysInStage(stageChangedAt: Date, now: Date, timeZone: string): number;   // whole calendar days in the zone (same day → 0)
export function isStuck(stage: JobStage, days: number, stuckAfterDays: number): boolean;   // STUCK_STAGES and days > stuckAfterDays
```
- **Rules (spec §3.2):** `from === to` → null. `to === 'installed'` and `from !== 'won'` and `from !== 'installed'` → `installed_needs_won` (field `stage`). `to === 'lost'` and `lostReason` blank → `lost_needs_reason`. `to === 'won'` and not `valueCents > 0` → `won_needs_value` (field `valueCents`). Everything else → null.
- No UI text here; the API maps `problem` to its message constants and the web to copy.

- [ ] **Step 1: Write the failing tests:** every rule both ways (lead→won with and without value; inspection→installed refused; won→installed ok; any→lost needs reason, whitespace-only counts as blank; lost→lead ok; same stage null); `daysInStage` across midnight in `America/Chicago` and across the 2026-11-01 DST change; `isStuck` at 14 and 15 days, and never for won/installed/lost.
- [ ] **Step 2–4:** `npx vitest run --project @roofline/shared pipeline` → PASS; `npx vitest run --project @roofline/web copy-rules` (new `as const` arrays) → PASS.
- [ ] **Step 5: Commit.** `feat(shared): pipeline stage rules and stuck days`

---

### Task 3: Shared availability model

**Split:** Builder 1 `WorkHoursSchema` and helpers; Builder 2 `findSlots`; Builder 3 the tests.

**Files:**
- Modify: `packages/shared/src/availability.ts` (below Task 1's constants)
- Test: `packages/shared/test/availability.test.ts`

**Interfaces:**
```ts
export const WEEKDAYS = ['mon','tue','wed','thu','fri','sat','sun'] as const; export type Weekday = (typeof WEEKDAYS)[number];
export type WorkHours = Record<Weekday, [string, string][]>;      // local 'HH:MM' ranges, sorted, non-overlapping, at most 3 per day
export const DEFAULT_WORK_HOURS: WorkHours;                         // Mon–Fri 08:00–18:00, Sat 08:00–12:00, Sun none (spec Decision 17)
export const WorkHoursSchema: z.ZodType<WorkHours>;                 // issues name the day: "mon: ..." ; '24:00' allowed as an end
export const DEFAULT_DURATION_MINUTES: Record<'inspection' | 'adjuster' | 'other', number>;   // 60, 60, 30 (install is all-day)
export const SLOT_STEP_MINUTES = 30;
export const MAX_AVAILABILITY_DAYS = 14;
export type Interval = { start: Date; end: Date };
export type BusyItem = Interval & { propertyId: string | null };
export type SlotQuery = { workHours: WorkHours; busy: readonly BusyItem[]; propertyId: string | null; durationMinutes: number;
  bufferMinutes: number; from: Date; to: Date; timeZone: string; stepMinutes?: number; minNoticeMinutes: number; now: Date };
export function findSlots(q: SlotQuery): Interval[];
export function workIntervals(hours: WorkHours, from: Date, to: Date, timeZone: string): Interval[];   // the work hours as instants
export function mergeIntervals(list: readonly Interval[]): Interval[];
```
- **`findSlots`:** candidate starts every `stepMinutes` (default 30) aligned to the local hour, inside `workIntervals`, with `start >= now + minNoticeMinutes`, `start >= from`, `end <= to`, the whole slot inside one work interval; a candidate is free when, for each busy item, `[start − buf, end + buf)` does not overlap it, where `buf = 0` if `propertyId !== null && propertyId === busy.propertyId`, else `bufferMinutes`. Returns slots in time order.
- All local-time math goes through `Intl.DateTimeFormat` with `timeZone` (no `Date` local-time methods).

- [ ] **Step 1: Write the failing tests:** default hours parse; overlapping ranges, `'25:00'` and 4 ranges in a day are refused naming the day; a free Monday in Chicago gives 08:00–17:00 starts for 60 minutes (19 slots); a 10:00–11:00 busy item at another home blocks 09:30–11:30 with a 30-minute buffer (so 09:00 is not offered for 60 minutes, 11:30 is); the same home needs no buffer (11:00 offered); minimum notice of 120 minutes at 08:15 → first slot 10:30; an all-day busy item blocks the day; Sunday gives none; the 2026-03-08 and 2026-11-01 DST days give correct UTC instants; `from`/`to` clipping.
- [ ] **Step 2–4:** `npx vitest run --project @roofline/shared availability` → PASS.
- [ ] **Step 5: Commit.** `feat(shared): work hours and the slot finder`

---

### Task 4: Shared view types and CSV writing

**Split:** Builder 1 `crm.ts`; Builder 2 `csv.ts`; Builder 3 the tests.

**Files:**
- Modify: `packages/shared/src/crm.ts`, `packages/shared/src/csv.ts`
- Test: `packages/shared/test/csv.test.ts`, `packages/shared/test/crm-types.test.ts` (type-level checks with `expectTypeOf`)

**Interfaces (`crm.ts`, types only — the API returns exactly these, the web reads them):**
```ts
export type MemberRef = { userId: string; name: string };
export type JobCard = { id: string; customerId: string; customerName: string; propertyId: string; addressLine: string; stage: JobStage;
  valueCents: number | null; assigned: MemberRef | null; daysInStage: number; stuck: boolean; nextStep: string | null; nextStepOn: string | null; updatedAt: string };
export type BoardColumn = { stage: BoardStage; count: number; totalCents: number | null; jobs: JobCard[] };
export type BoardView = { columns: BoardColumn[]; lost: { count: number } };
export type HomeSummary = { id: string; addressLine: string; city: string; state: string; zip: string; located: boolean; jobs: { id: string; stage: JobStage }[] };
export type AppointmentView = { id: string; kind: AppointmentKind; title: string; status: AppointmentStatus; startsAt: string; endsAt: string; allDay: boolean;
  assigned: MemberRef | null; jobId: string | null; customerId: string | null; customerName: string | null; propertyId: string | null; addressLine: string | null;
  notes: string | null; source: AppointmentSource; sync: 'none' | 'synced' | 'pending' | 'failed'; canEdit: boolean };
export type QuoteSummary = { id: string; number: string; status: QuoteStatus; totalCents: number; updatedAt: string };
export type JobView = { job: JobCard & { source: JobSource; lostReason: string | null; stageChangedAt: string; archived: boolean; createdAt: string };
  customer: { id: string; displayName: string; phone: string | null; email: string | null };
  home: HomeSummary; appointments: AppointmentView[]; quotes: QuoteSummary[]; tasks: { id: string; title: string; status: TaskStatus }[];
  can: { edit: boolean; seeValue: boolean; archive: boolean } };
export type CustomerView = { customer: { id: string; displayName: string; firstName: string | null; lastName: string | null;
  phones: { e164: string; label: string | null; primary: boolean }[]; emails: string[]; tags: string[]; consent: ConsentStatus; doNotContact: boolean;
  source: CustomerSource; archived: boolean; createdAt: string };
  homes: HomeSummary[]; jobs: JobCard[]; upcoming: AppointmentView[]; can: { edit: boolean; changeConsent: boolean; archive: boolean } };
export type TimelineItem = { id: string; at: string; type: 'activity' | 'text'; kind: string; summary: string;
  actor: { type: 'user' | 'agent' | 'system'; name: string | null }; subject: { type: ActivitySubjectType; id: string };
  text: { direction: 'in' | 'out'; body: string; status: MessageStatus } | null };
export type TimelinePage = { items: TimelineItem[]; nextBefore: string | null };
export type TodayView = { appointments: AppointmentView[]; followUps: JobCard[] };
export type CalendarConnectionView = { provider: CalendarProvider | null; status: CalendarConnectionStatus | null; accountEmail: string | null;
  calendarId: string | null; calendarName: string | null; lastSyncedAt: string | null; configured: Record<CalendarProvider, boolean> };
export type ScheduleSettings = { workHours: WorkHours; travelBufferMinutes: number; minNoticeMinutes: number; stuckAfterDays: number };
export type PricebookView = { prices: Pricebook; defaults: QuoteDefaults; isExample: boolean };
export type QuoteDefaults = { wastePercent: number; markupPercent: number; taxPercent: number; material: Scope['material'] };
export type QuoteMeasurement = { source: 'manual'; areaSqFt: number; areaType: 'surface' | 'footprint'; pitch: number; notes: string | null };
export type QuoteView = { id: string; jobId: string; number: string; status: QuoteStatus; measurement: QuoteMeasurement; scope: Scope; prices: Pricebook;
  calculation: Calculation; notes: string | null; validUntil: string; createdAt: string; finalizedAt: string | null; canEdit: boolean };
```
(`CalendarProvider` here is the shared type from `CALENDAR_PROVIDERS`; the API's provider *interface* in Task 5 is named `CalendarApi` to avoid the clash.)
- **`csv.ts`:**
```ts
export function csvCell(value: string | number | boolean | null | undefined): string;   // '' for null; formula guard (=,+,-,@,\t,\r → leading '); RFC 4180 quoting
export function toCsv(headers: readonly string[], rows: readonly (readonly (string | number | boolean | null | undefined)[])[]): string;   // CRLF, trailing CRLF
```
- [ ] **Step 1: Write the failing tests:** `csvCell('=SUM(A1)') === "'=SUM(A1)"`, `csvCell('+1 402') === "'+1 402"`, `csvCell('Lee, "Ann"') === '"Lee, ""Ann"""'`, `csvCell('-5')` guarded, `csvCell(5)` → `'5'` (numbers are not guarded), `toCsv` line endings; type-level: `expectTypeOf<BoardView['columns'][number]['stage']>().toEqualTypeOf<BoardStage>()`.
- [ ] **Step 2–4:** `npx vitest run --project @roofline/shared` → PASS.
- [ ] **Step 5: Commit.** `feat(shared): CRM view types and formula-safe CSV`

---

### Task 5: API skeleton: calendar seam, config, queues, mounts

**Split:**
- Builder 1: `config.ts` keys, `deps.ts`, `test/helpers.ts` (`TestApp.calendars`), `.env.example` and the README env table.
- Builder 2: `providers/calendar.ts` (interface, errors, factory), `providers/fakes/calendar.ts`, the two adapter stubs, `test/calendar-fake.test.ts`.
- Builder 3: route/job/scheduler stubs, the three repo placeholders (Ruling 4), mounts in `app.ts`, `JOB_NAMES`/`JOB_HANDLERS`/`SCHEDULES` additions, `index.ts` exports, `test/jobs.test.ts` extension.

**Files:**
- Create: `apps/api/src/providers/calendar.ts`, `apps/api/src/providers/fakes/calendar.ts`, `apps/api/src/providers/{google-calendar,microsoft-calendar}.ts` (stubs: `googleCalendarFor(config): CalendarApi | null`, `microsoftCalendarFor(config): CalendarApi | null`, returning null), `apps/api/src/routes/{appointments,today,calendar,calendar-connect,timeline,notes,pricebook,quotes,export}.ts` (stubs), `apps/api/src/calendar/{push,pull}.ts` (stubs), `apps/api/src/jobs/scheduler/calendar-pull.ts` (stub), `apps/api/test/calendar-fake.test.ts`
- Modify: `apps/api/src/{config,deps,app,index}.ts`, `apps/api/src/jobs/{queue,handlers,worker}.ts`, `apps/api/test/helpers.ts`, `apps/api/test/{config,jobs}.test.ts`, `.env.example`, `README.md` (env table), `packages/db/src/repos/{appointments,quotes}.ts` (the three placeholder functions of Ruling 4: `listAppointmentsForJob(tx, ctx, jobId): Promise<AppointmentView[]>`, `listAppointmentsForCustomer(tx, ctx, customerId, limit, now): Promise<AppointmentView[]>`, `listQuoteSummaries(tx, ctx, jobId): Promise<QuoteSummary[]>`, each `return []`)

**Interfaces:**
- **Config** (optional, blank = unset): `GOOGLE_CLIENT_SECRET` (requires `GOOGLE_CLIENT_ID`), `MICROSOFT_CLIENT_ID` and `MICROSOFT_CLIENT_SECRET` (both or neither; issue names the missing one).
- **Seam (`providers/calendar.ts`):**
```ts
export type OAuthTokens = { refreshToken: string; accessToken: string; expiresAt: Date; scopes: string[]; accountEmail: string };
export type ExternalCalendar = { id: string; name: string; primary: boolean; canWrite: boolean };
export type ExternalEventInput = { title: string; location: string | null; description: string; start: Date; end: Date; allDay: boolean; timeZone: string };
export type ExternalEvent = { id: string; etag: string | null; start: Date; end: Date; allDay: boolean; updatedAt: Date; cancelled: boolean; busy: boolean };
export type SyncPage = { events: ExternalEvent[]; nextCursor: string; fullResync: boolean };
export interface CalendarApi {
  readonly provider: CalendarProvider; readonly configured: boolean;
  authUrl(i: { state: string; redirectUri: string }): string;
  exchangeCode(i: { code: string; redirectUri: string }): Promise<OAuthTokens>;
  refresh(refreshToken: string): Promise<{ accessToken: string; expiresAt: Date; refreshToken?: string }>;
  listCalendars(accessToken: string): Promise<ExternalCalendar[]>;
  createEvent(accessToken: string, calendarId: string, e: ExternalEventInput): Promise<{ id: string; etag: string | null }>;
  updateEvent(accessToken: string, calendarId: string, eventId: string, etag: string | null, e: ExternalEventInput): Promise<{ etag: string | null } | 'gone' | 'conflict'>;
  deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<void>;          // 404/410 count as done
  getEvent(accessToken: string, calendarId: string, eventId: string): Promise<ExternalEvent | null>;
  syncEvents(accessToken: string, calendarId: string, cursor: string | null, window: { from: Date; to: Date }): Promise<SyncPage>;   // an expired cursor → fullResync true from the window
}
export class CalendarUnavailableError extends Error {}   // retry later
export class CalendarAuthError extends Error {}          // the grant is gone: reconnect
export type CalendarApis = Record<CalendarProvider, CalendarApi>;
export function createCalendarApis(config: Config): CalendarApis;   // FAKE_PROVIDERS → a FakeCalendarApi per provider; else googleCalendarFor/microsoftCalendarFor ?? an unconfigured api (configured false; methods throw CalendarUnavailableError("Calendar connections aren't set up yet."))
```
- **`FakeCalendarApi`** (`providers/fakes/calendar.ts`, deterministic): constructor `(provider)`; `authUrl` → `https://calendar.fake.test/${provider}/auth?state=<state>`; `exchangeCode(code)` → tokens with `refreshToken: 'refresh-' + code`, `accountEmail: code + '@example.test'`; one in-memory account per refresh token with calendars `[{id:'primary', name:'My calendar', primary:true, canWrite:true}]`; events with ids `evt-<n>`, etags `"<version>"`; `syncEvents` returns changes since the cursor (cursor = an internal change counter string); helpers `externalMove(eventId, start, end)`, `externalDelete(eventId)`, `addOutsideEvent({start, end, allDay?, busy?})`, `revoke(refreshToken)` (later calls throw `CalendarAuthError`), `expireCursor()` (next sync returns `fullResync: true`), `failNext(n)` (throws `CalendarUnavailableError`), and `calls`.
- **`AppDeps` gains** `calendars: CalendarApis`; `buildDeps` uses `createCalendarApis`.
- **Jobs:** `JOB_NAMES` gains `'calendar-push'`; `JobData` gains `appointmentId?: string`; `JOB_HANDLERS['calendar-push']` → `pushAppointment(deps, data.companyId, data.appointmentId!, meta)` (stub in `calendar/push.ts`, no-op).
- **Schedule:** `SCHEDULES` gains `{ name: 'calendar-pull', cron: '*/5 * * * *', run: pullCalendars }` (stub in `jobs/scheduler/calendar-pull.ts`, delegating later to `calendar/pull.ts`).
- **Route stubs** (each `(deps: AppDeps) => Router`, empty): `appointmentRoutes`, `todayRoutes`, `calendarRoutes`, `calendarConnectRoutes`, `timelineRoutes`, `noteRoutes`, `pricebookRoutes`, `quoteRoutes` (with `Router({ mergeParams: true })`), `jobQuoteRoutes` (same file, `mergeParams`), `exportRoutes`.
- **Mounts** (after `/api/weather`, in this order; `/api/jobs/:jobId/quotes` **before** `/api/jobs`):
  `/api/jobs/:jobId/quotes` → `jobQuoteRoutes`, `/api/appointments` → `appointmentRoutes`, `/api/today` → `todayRoutes`, `/api/calendar` → `calendarRoutes` and `calendarConnectRoutes`, `/api/timeline` → `timelineRoutes`, `/api/notes` → `noteRoutes`, `/api/pricebook` → `pricebookRoutes`, `/api/quotes` → `quoteRoutes`, `/api/export` → `exportRoutes`.
- **`TestApp` gains** `calendars: { google: FakeCalendarApi; microsoft: FakeCalendarApi }`.

- [ ] **Step 1: Write the failing tests:** `config.test.ts` (Microsoft pair rule; Google secret needs the id); `calendar-fake.test.ts` (the fake reports every change, its own writes included — Task 14 filters linked events by etag: create then sync shows the event; `externalMove` shows in the next sync with a newer `updatedAt`; `externalDelete` shows `cancelled`; `expireCursor` gives `fullResync`; `revoke` makes later calls throw `CalendarAuthError`); `jobs.test.ts` (`SCHEDULES` has `calendar-pull` `*/5 * * * *`; `JOB_NAMES` includes `calendar-push`); `buildDeps` with `FAKE_PROVIDERS=1` gives fakes, without it `configured === false`.
- [ ] **Step 2–4:** typecheck and lint locally; CI via `ops/bin/ci-check`.
- [ ] **Step 5: Commit.** `feat(api): C1 skeleton — calendar seam with a fake, config, calendar-push queue, calendar-pull schedule, route stubs`

---

### Task 6: Jobs: stage rules, next step, board and job view

**Split:**
- Builder 1: `packages/db/src/repos/jobs.ts` (rules hook-in, next step) and `packages/db/src/repos/board.ts`.
- Builder 2: `apps/api/src/routes/jobs.ts` (`/board`, `/:id/view`, PATCH body additions, messages).
- Builder 3: `apps/api/test/{jobs-board,jobs-stage-rules,job-view}.test.ts`.

**Files:**
- Modify: `packages/db/src/repos/jobs.ts`, `packages/db/src/repos/board.ts`, `apps/api/src/routes/jobs.ts`
- Test: `apps/api/test/jobs-board.test.ts`, `apps/api/test/jobs-stage-rules.test.ts`, `apps/api/test/job-view.test.ts`

**Interfaces:**
- **`JobInput`/`JobPatch` gain** `nextStep?: string | null` (trimmed, ≤ `NEXT_STEP_MAX`), `nextStepOn?: string | null` (`YYYY-MM-DD`). Setting or clearing them writes an activity "Next step: <text> (Oct 14)" / "Next step cleared".
- **Stage rules in `updateJob`:** before writing, `stageMoveProblem({ from: before.stage, to, valueCents: patch.valueCents ?? before.valueCents, lostReason: patch.lostReason ?? before.lostReason })`; a problem throws `StageRuleError(problem)` (new, exported). `createJob` applies the same rules with `from: 'lead'` when `stage` is given.
- **Route messages** (constants in `routes/jobs.ts`): `installed_needs_won` → 400 field `stage` "Mark the job Won first."; `lost_needs_reason` → 400 field `lostReason` "Pick why the job was lost."; `won_needs_value` → 400 field `valueCents` "Enter the job value to mark it Won."; next step too long → field `nextStep` "Keep the next step under 120 characters."; bad date → field `nextStepOn` "Please pick a date.".
- **Board (`repos/board.ts`):**
```ts
export type BoardFilter = { assigned?: 'me' | 'unassigned' | { userId: string }; source?: JobSource; q?: string; archived?: boolean };
export async function boardColumns(tx: Tx, ctx: TenantContext, f: BoardFilter, opts: { now: Date; timeZone: string; stuckAfterDays: number; perColumn: number; showTotals: boolean }): Promise<BoardView>;
export async function boardColumnPage(tx: Tx, ctx: TenantContext, f: BoardFilter, stage: BoardStage, offset: number, opts: …same…): Promise<BoardColumn>;
```
  - `jobScope(ctx)` applied; archived excluded unless `archived`; `installed` limited to `stage_changed_at >= now − 30 days`; ordered by `stage_changed_at desc, id`; `q` matches customer name or address with the F2 `customerMatch`/`escapeLike` helpers (`repos/search.ts`); `totalCents` = sum of `value_cents` over the whole filtered column (not the page) when `showTotals`, else null; `valueCents` per card through `canSeeJobValue`; member names from `company_members`.
- **Routes:**
  - `GET /api/jobs/board?assigned=me|unassigned|<uuid>&source=&q=&archived=true|false[&stage=&offset=]` → `BoardView`, or one `BoardColumn` when `stage` is given. `showTotals` = `can(ctx, 'view_money_totals')`. The company zone and `stuck_after_days` come from `companies`/`company_settings`.
  - `GET /api/jobs/:id/view` → `JobView` (404 when out of scope). `appointments` and `quotes` come from `listAppointmentsForJob` and `listQuoteSummaries`, Task 5's placeholders returning `[]` until Tasks 8 and 15 replace their bodies (Ruling 4). `tasks` = `agent_tasks` with `subject_type='job' and subject_id=id`, newest first, 10.
  - `PATCH /api/jobs/:id` accepts `nextStep`, `nextStepOn`; the rules errors above.

- [ ] **Step 1: Write the failing tests** (`makeTestApp`, `seedShowcase` for Acme):
  - `jobs-board.test.ts`: `test('the showcase jobs land in their columns with counts')` (lead 8, inspection 7, proposal 6, won 4, installed 2 within 30 days, lost drawer 1 — with the showcase's `stage_changed_at` = seed time); `test('totals for owner and office, none for reps')`; `test('a rep sees their jobs and unassigned leads only')`; `test('installed jobs older than 30 days leave the board')`; `test('paging a column')` (perColumn 50 vs `?stage=lead&offset=…` with 60 leads); `test('filters by assignee, source and text')`; `test('stuck cards')` (clock +15 days); `test("company B's board never shows A's jobs")`.
  - `jobs-stage-rules.test.ts`: each rule through `PATCH /api/jobs/:id` with the exact message and field; `lead→won` with a value succeeds; reopening a lost job clears the reason; the activity and audit rows for a move.
  - `job-view.test.ts`: owner sees value and `can.edit`; a rep on an unassigned lead sees `valueCents: null` and `can.seeValue false`; out-of-scope → 404; tasks listed.
- [ ] **Step 2–4:** CI via `ops/bin/ci-check`; locally typecheck, lint.
- [ ] **Step 5: Commit.** `feat(jobs): stage rules, next step, the pipeline board and the job view`

---

### Task 7: Customers: view, timeline, notes, server geocoding

**Split:**
- Builder 1: `packages/db/src/repos/timeline.ts` and `packages/db/src/repos/notes.ts`, `routes/timeline.ts`, `routes/notes.ts`.
- Builder 2: `routes/customers.ts` (`/:id/view`) and `routes/properties.ts` (server geocoding, `/:id/locate`).
- Builder 3: the tests.

**Files:**
- Modify: `packages/db/src/repos/{timeline,notes}.ts`, `apps/api/src/routes/{customers,properties,timeline,notes}.ts`
- Test: `apps/api/test/{customer-view,timeline,notes,property-geocode}.test.ts`
- Do not touch: `repos/customers.ts` and `repos/properties.ts` internals beyond adding a `setPropertyLocation` (if absent) in `properties.ts`.

**Interfaces:**
```ts
// repos/timeline.ts
export type TimelineQuery = { customerId?: string; jobId?: string; before?: Date; limit?: number };   // exactly one of customerId/jobId
export async function timelinePage(tx: Tx, ctx: TenantContext, q: TimelineQuery): Promise<TimelinePage>;
// repos/notes.ts
export const NOTE_MAX = 2000;
export async function addNote(tx: Tx, ctx: TenantContext, n: { subjectType: 'customer' | 'job'; subjectId: string; body: string }, now: Date): Promise<TimelineItem>;
```
- **Timeline merge:** for a customer — activities whose subject is the customer, any of its properties, any of its jobs (scoped by `jobScope` for reps), plus `messages` with `customer_id` = it; for a job — the job's activities, its property's, and messages whose `step_id` belongs to a task with `subject_id` = the job **or** whose customer is the job's customer and `created_at` ≥ the job's `created_at` (texts about the job). One `UNION ALL` ordered by `at desc, id desc`, `limit + 1` to compute `nextBefore` (the last item's `at` ISO). Actor names from `company_members`; agent names from `AGENT_LABEL`-equivalent server map (`activities.actor_agent` as stored). Activity `kind = 'note'` items carry the note body as `summary`.
- **`POST /api/notes`** `{ subjectType, subjectId, body }`: the subject must be visible (404); `body` trimmed 1–2000 → else 400 field `body` "Write a note, up to 2,000 characters."; inserts an activity `kind 'note'`, `summary = body`; returns the `TimelineItem` (201). Allowed for anyone who can see the subject.
- **`GET /api/timeline?customerId=|jobId=&before=&limit=`** → `TimelinePage`; neither or both → 400.
- **`GET /api/customers/:id/view`** → `CustomerView`: homes with their jobs (scoped), jobs as `JobCard`s, `upcoming` = next 5 scheduled appointments (`listAppointmentsForCustomer`, Task 5's placeholder until Task 8, Ruling 4), `can.changeConsent` = owner or office.
- **Server geocoding (`routes/properties.ts`):** `POST /api/properties` without `lat`/`lng` geocodes `"line, city, ST zip"` with `deps.geocoder` **before** the insert (outside the transaction): located → `location`, and `timezone` when `isTimeZone`; not found or unavailable → saved without a point. `POST /api/properties/:id/locate` (anyone who can edit it) re-tries: 200 `{ located: true }`, 400 field `addressLine` "We couldn't find that address. Check the street, city and state.", 503 "We couldn't reach the map service. Try again in a minute."

- [ ] **Step 1: Write the failing tests:** `customer-view.test.ts` (homes and jobs, rep scope, B → 404); `timeline.test.ts` (a stage move, a note and an inbound text appear newest first; paging with `before`; a rep doesn't see activities of a job they can't see on a shared customer); `notes.test.ts` (2001 characters → 400; out-of-scope subject → 404); `property-geocode.test.ts` (`'1200 Farnam St'` with the fake → `geom` set and `timezone 'America/Chicago'`; `'1 Nowhere Rd'` → saved, no point; `locate` 200/400/503 with `t.geocoder.failNext`).
- [ ] **Step 2–4:** CI.
- [ ] **Step 5: Commit.** `feat(crm): customer view, merged timeline, notes and server-side geocoding for new homes`

---

### Task 8: Appointments API and Today

**Split:**
- Builder 1: `packages/db/src/repos/appointments.ts` and `packages/db/src/repos/today.ts`.
- Builder 2: `routes/appointments.ts` and `routes/today.ts`.
- Builder 3: the tests.

**Files:**
- Modify: `packages/db/src/repos/{appointments,today}.ts` (replacing Task 5's placeholder bodies), `apps/api/src/routes/{appointments,today}.ts`
- Test: `apps/api/test/{appointments,today}.test.ts`

**Interfaces:**
```ts
export type AppointmentInput = { kind: AppointmentKind; title?: string | null; jobId?: string | null; customerId?: string | null; propertyId?: string | null;
  assignedUserId?: string | null; startsAt: Date; endsAt: Date; allDay?: boolean; notes?: string | null; source?: AppointmentSource };
export type AppointmentPatch = Partial<Omit<AppointmentInput, 'source'>>;
export async function createAppointment(tx: Tx, ctx: TenantContext, i: AppointmentInput, now: Date): Promise<{ row: AppointmentRow; warnings: string[]; jobMoved: boolean }>;
export type ChangeOrigin = { origin?: 'user' | 'pull'; activitySummary?: string };   // 'pull' = applied from the person's calendar: no calendar-push is queued (Ruling 7)
export async function updateAppointment(tx: Tx, ctx: TenantContext, id: string, p: AppointmentPatch, now: Date, o?: ChangeOrigin): Promise<{ row: AppointmentRow; warnings: string[] } | null>;
export async function setAppointmentStatus(tx: Tx, ctx: TenantContext, id: string, status: 'completed' | 'canceled' | 'no_show', now: Date, o?: ChangeOrigin & { note?: string }): Promise<AppointmentRow | null>;
export async function listAppointments(tx: Tx, ctx: TenantContext, q: { from: Date; to: Date; userIds?: string[]; includeCanceled?: boolean }): Promise<AppointmentView[]>;
export async function listAppointmentsForJob(tx: Tx, ctx: TenantContext, jobId: string): Promise<AppointmentView[]>;
export async function listAppointmentsForCustomer(tx: Tx, ctx: TenantContext, customerId: string, limit: number, now: Date): Promise<AppointmentView[]>;
export async function getAppointmentView(tx: Tx, ctx: TenantContext, id: string): Promise<AppointmentView | null>;
export function appointmentScope(ctx: TenantContext): SQL | undefined;   // rep: assigned to them, or job_id in a job they can see
// repos/today.ts
export async function todayView(tx: Tx, ctx: TenantContext, now: Date, timeZone: string, stuckAfterDays: number): Promise<TodayView>;
```
- **Rules (spec §5.1):** links must agree (job's customer and property; property's customer) → 400 field `jobId`/`propertyId` "That home isn't this customer's."; an install defaults to all-day; all-day snaps to company-zone midnights; `endsAt > startsAt` → else field `endsAt` "The end must be after the start."; a rep may only assign to themselves (else 403 role message); **conflict warnings** (plain strings, from the route's constants) for overlap with the assignee's other appointments (not canceled) and busy blocks (read directly from `calendar_busy_blocks`): `${name} already has ${kind label} ${h:mm}–${h:mm}` / `${name}'s calendar shows busy ${h:mm}–${h:mm}`.
- **Auto-move (Decision 3):** creating an `inspection` on a job in `lead` calls `updateJob(…{ stage: 'inspection' })` in the same transaction with the activity summary "Moved to Inspection — inspection booked"; `jobMoved: true`.
- **Activities** on the job (else customer): "Inspection booked for Tue, Oct 13 · 2:00 PM with Sam", "… moved to …", "… canceled", "… marked done", "… no-show". Audit rows `appointment.created|updated|canceled|completed|no_show`.
- **Sync hook:** the repo functions return whether a push is due (`origin !== 'pull'`); after each committed create/update/status change of an appointment that has an assignee (or had one), `deps.jobs.send('calendar-push', { companyId, appointmentId }, { singletonKey: appointmentId })` — Task 13 implements the handler; also when the assignee changes (the handler reads both old link and new assignee).
- **Routes:** `GET /api/appointments?from=&to=&userIds=a,b&includeCanceled=&withBusy=` (window ≤ 62 days, else 400) → `{ appointments: AppointmentView[] }`, plus `busy: { userId, start, end, allDay }[]` from `calendar_busy_blocks` when `withBusy=true` (Ruling 6; only for users the caller may see); `POST /api/appointments` → 201 `{ appointment, warnings, jobMoved }`; `GET /api/appointments/:id`; `PATCH /api/appointments/:id` → `{ appointment, warnings }`; `POST /api/appointments/:id/cancel|complete|no-show` (`{ note? }`). `AppointmentView.sync` from `calendar_event_links` (`synced` with a link and no `push_error_plain`; `failed` with an error; `pending` when the assignee has a connection but no link yet; `none` otherwise).
- **`GET /api/today`** → `TodayView`: the caller's appointments today in the company zone (not canceled), and `followUps` = their visible jobs with `next_step_on <= today` (owner/office: jobs assigned to them, or unassigned they created).

- [ ] **Step 1: Write the failing tests:** `appointments.test.ts` — create/move/cancel/complete/no-show with activities and audit; the inspection auto-move (and none for a job already in proposal); link mismatch 400s; install all-day midnight snapping in Chicago; conflict warnings (overlap, busy block) but 201; rep visibility (own + their jobs; not another rep's on a hidden job) and rep can't assign others; `calendar-push` sent once per change (`t.jobs.sent`); window > 62 days → 400; company B 404. `today.test.ts` — today's appointments only, follow-ups due today and overdue, DST day.
- [ ] **Step 2–4:** CI.
- [ ] **Step 5: Commit.** `feat(calendar): appointments with conflict warnings, the inspection auto-move, and today's view`

---

### Task 9: Schedule settings and availability

**Split:**
- Builder 1: `packages/db/src/repos/schedules.ts`.
- Builder 2: `routes/calendar.ts` (settings, hours, availability).
- Builder 3: the tests.

**Files:**
- Modify: `packages/db/src/repos/schedules.ts`, `apps/api/src/routes/calendar.ts`
- Test: `apps/api/test/{schedule-settings,availability}.test.ts`
- Do not touch: `routes/calendar-connect.ts` (Task 12; mounted at the same prefix — keep paths disjoint: this file owns `/settings`, `/my-hours`, `/hours/:userId`, `/availability`).

**Interfaces:**
```ts
export async function scheduleSettings(tx: Tx, ctx: TenantContext): Promise<ScheduleSettings>;
export async function saveScheduleSettings(tx: Tx, ctx: TenantContext, s: ScheduleSettings, now: Date): Promise<ScheduleSettings>;
export async function memberHours(tx: Tx, ctx: TenantContext, userId: string): Promise<{ workHours: WorkHours; custom: boolean }>;   // falls back to the company hours
export async function saveMemberHours(tx: Tx, ctx: TenantContext, userId: string, hours: WorkHours | null, now: Date): Promise<void>;   // null = back to company hours
export async function busyFor(tx: Tx, ctx: TenantContext, userIds: readonly string[], from: Date, to: Date): Promise<Map<string, BusyItem[]>>;   // appointments (not canceled) + busy blocks; all-day as whole local days
export async function bookableMembers(tx: Tx, ctx: TenantContext, kind: AppointmentKind): Promise<MemberRef[]>;   // active; inspection → owner and reps; others → everyone
```
- **Routes:**
  - `GET /api/calendar/settings` (any member) → `ScheduleSettings`; `PUT` (`company_admin`) validates with `WorkHoursSchema` (field `workHours.<day>`), `travelBufferMinutes` 0–120, `minNoticeMinutes` 0–4320, `stuckAfterDays` 3–90; audit `calendar.settings`.
  - `GET /api/calendar/my-hours` → `{ workHours, custom }`; `PUT /api/calendar/my-hours { workHours | null }`; `PUT /api/calendar/hours/:userId` (`company_admin`).
  - `GET /api/calendar/availability?userId=&kind=&propertyId=&from=&to=` → `{ slots: { start: string; end: string; userIds: string[] }[] }`: duration from `DEFAULT_DURATION_MINUTES[kind]` (`install` → 400 field `kind` "Installs are booked by the day."); window ≤ `MAX_AVAILABILITY_DAYS` (else 400); with `userId`: that member (a rep may only ask for themselves); without: `bookableMembers` visible to the caller, slots merged by start time with each free `userIds`. `findSlots` with the company zone, the member's hours, `busyFor`, buffer, notice, `now = deps.clock.now()`.

- [ ] **Step 1: Write the failing tests:** settings round-trip and validation messages; office can't PUT company settings (403) but can PUT its own hours; availability with a seeded 10:00 appointment at another home (buffer respected) and a busy block; a rep asking for another member → 403; union across two reps with `userIds`; DST Sunday 2026-11-01 Monday after; minimum notice from the test clock; company B 404 for its member id.
- [ ] **Step 2–4:** CI.
- [ ] **Step 5: Commit.** `feat(calendar): work hours, travel buffer, minimum notice and suggested times`

---

### Task 10: Google Calendar adapter

**Split:** Builder 1 `google-calendar.ts` (OAuth and tokens); Builder 2 `google-calendar.ts` (events and sync; bottom half, the lead joins); Builder 3 fixtures and tests.

**Files:**
- Create: `apps/api/test/fixtures/google-calendar/{token-exchange,token-refresh,token-invalid-grant,userinfo,calendar-list,event-insert,event-patch,event-get,events-sync-full,events-sync-incremental,events-sync-gone}.json`
- Modify: `apps/api/src/providers/google-calendar.ts` (replace the stub)
- Test: `apps/api/test/google-calendar.test.ts`

**Interfaces:**
```ts
export class GoogleCalendarApi implements CalendarApi { constructor(o: { clientId: string; clientSecret: string; fetch?: typeof fetch; timeoutMs?: number }) }
export function googleCalendarFor(config: Config): CalendarApi | null;   // GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET → GoogleCalendarApi; else null
export const GOOGLE_CALENDAR_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly'];
```
- **OAuth:** `authUrl` → `https://accounts.google.com/o/oauth2/v2/auth?client_id&redirect_uri&response_type=code&scope=<space-joined>&access_type=offline&prompt=consent&include_granted_scopes=true&state`; `exchangeCode` → `POST https://oauth2.googleapis.com/token` (form) then `GET https://openidconnect.googleapis.com/v1/userinfo` for the email; `refresh` → token POST with `grant_type=refresh_token`; `invalid_grant` → `CalendarAuthError("Reconnect your calendar.")`.
- **Calendars:** `GET https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=writer` → `ExternalCalendar[]`.
- **Events:** `POST /calendars/{id}/events` (`summary`, `location`, `description`, `start`/`end` as `{dateTime, timeZone}` or `{date}` for all-day with an exclusive end date, `transparency: 'opaque'`, `extendedProperties.private.roofline = 'appointment'`); `PATCH …/events/{eventId}` with `If-Match: <etag>` (412 → `'conflict'`, 404/410 → `'gone'`); `DELETE` (404/410 fine); `GET` one.
- **Sync:** `GET …/events?singleEvents=true&showDeleted=true&maxResults=250` with `syncToken=<cursor>` (incremental) or `timeMin`/`timeMax` from the window (full); follow `nextPageToken`; the last page's `nextSyncToken` is `nextCursor`; HTTP 410 → restart full with `fullResync: true`. Map `status: 'cancelled'` → `cancelled`, `transparency: 'transparent'` → `busy: false`, `updated` → `updatedAt`.
- **Errors:** 401 → refresh once is the caller's job (Task 12's `accessTokenFor`); here 401/403 → `CalendarAuthError`; 429/5xx/network/timeout (10 s) → `CalendarUnavailableError("Couldn't reach Google Calendar.")` — **the message is never shown in the UI** (UI strings live in copy); tokens and event bodies never appear in an error.

- [ ] **Step 1: Write the failing tests** (an injected `fetch` serving the fixtures and recording requests): the auth URL params; exchange + userinfo → tokens with the email; refresh; `invalid_grant` → `CalendarAuthError`; calendar list mapping; insert body for a timed and an all-day event (exclusive end date); patch with `If-Match` and the 412/410 mappings; full then incremental sync (cursor carried, pages followed, cancelled and transparent mapped); 410 → `fullResync`; 503 → `CalendarUnavailableError` whose message has no token.
- [ ] **Step 2–4:** CI.
- [ ] **Step 5: Commit.** `feat(calendar): Google Calendar adapter with incremental sync`

---

### Task 11: Microsoft Graph adapter

**Split:** as Task 10.

**Files:**
- Create: `apps/api/test/fixtures/microsoft-calendar/{token-exchange,token-refresh,token-invalid-grant,me,calendars,event-create,event-patch,event-get,delta-full,delta-incremental,delta-gone}.json`
- Modify: `apps/api/src/providers/microsoft-calendar.ts` (replace the stub)
- Test: `apps/api/test/microsoft-calendar.test.ts`

**Interfaces:**
```ts
export class MicrosoftCalendarApi implements CalendarApi { constructor(o: { clientId: string; clientSecret: string; fetch?: typeof fetch; timeoutMs?: number }) }
export function microsoftCalendarFor(config: Config): CalendarApi | null;   // MICROSOFT_CLIENT_ID + MICROSOFT_CLIENT_SECRET → MicrosoftCalendarApi; else null
export const MICROSOFT_CALENDAR_SCOPES = ['offline_access', 'User.Read', 'Calendars.ReadWrite'];
```
- **OAuth:** `https://login.microsoftonline.com/common/oauth2/v2.0/authorize` / `/token`; `GET https://graph.microsoft.com/v1.0/me` (`mail ?? userPrincipalName`); `invalid_grant` → `CalendarAuthError`.
- **Calendars:** `GET /me/calendars?$select=id,name,isDefaultCalendar,canEdit`.
- **Events:** `POST /me/calendars/{id}/events` (`subject`, `body {contentType:'text'}`, `location {displayName}`, `start/end {dateTime, timeZone}` — all-day with `isAllDay: true` and midnight times, `showAs: 'busy'`, `singleValueExtendedProperties` marking Roofline); `PATCH /me/events/{id}` with `If-Match` (`@odata.etag`); 412 → `'conflict'`, 404 → `'gone'`; `DELETE`.
- **Sync:** `GET /me/calendars/{id}/calendarView/delta?startDateTime&endDateTime` (full) or the stored `@odata.deltaLink` (incremental), header `Prefer: odata.maxpagesize=200`; follow `@odata.nextLink`; `@removed` → `cancelled`; `showAs: 'free'` → `busy: false`; `lastModifiedDateTime` → `updatedAt`; HTTP 410 or `syncStateNotFound` → full with `fullResync: true`.
- **Errors:** as Task 10 ("Couldn't reach Outlook.").

- [ ] **Step 1: Write the failing tests:** mirror Task 10's list for Graph shapes, including `@removed` and the delta link as cursor.
- [ ] **Step 2–4:** CI.
- [ ] **Step 5: Commit.** `feat(calendar): Outlook calendar adapter with delta sync`

---

### Task 12: Calendar connect and the setup item

**Split:**
- Builder 1: `apps/api/src/calendar/{oauth-state,tokens}.ts` and `packages/db/src/repos/calendar.ts` (connections).
- Builder 2: `apps/api/src/routes/calendar-connect.ts`.
- Builder 3: `packages/shared/src/setup.ts` + `packages/db/src/repos/setup.ts` (the `connect_calendar` rule) and the tests.

**Files:**
- Create: `apps/api/src/calendar/{oauth-state,tokens}.ts`
- Modify: `packages/db/src/repos/calendar.ts`, `apps/api/src/routes/calendar-connect.ts`, `packages/shared/src/setup.ts`, `packages/db/src/repos/setup.ts`
- Test: `apps/api/test/calendar-connect.test.ts`, `packages/shared/test/setup.test.ts` (extend), `apps/api/test/setup.test.ts` (extend)

**Interfaces:**
```ts
// calendar/oauth-state.ts — signed with HMAC-SHA256 over ENCRYPTION_KEY-derived key; single use via an in-row nonce
export function makeOAuthState(i: { companyId: string; userId: string; provider: CalendarProvider; now: Date }, key: string): string;   // base64url(json).sig, 10-minute expiry
export function readOAuthState(state: string, key: string, now: Date): { companyId: string; userId: string; provider: CalendarProvider } | null;
// repos/calendar.ts (connections only; links are Task 13's calendar-links.ts, busy blocks Task 14's calendar-busy.ts)
export type CalendarConnectionRow = typeof calendarConnections.$inferSelect;
export async function getConnection(tx: Tx, ctx: TenantContext, userId: string): Promise<CalendarConnectionRow | null>;
export async function saveConnection(tx: Tx, ctx: TenantContext, c: { userId: string; provider: CalendarProvider; accountEmail: string; encryptedCredentials: Buffer; scopes: string[]; calendarId: string; calendarName: string }, now: Date): Promise<CalendarConnectionRow>;   // upsert on (company_id, user_id); resets cursor, status connected
export async function setConnectionCalendar(tx: Tx, ctx: TenantContext, userId: string, calendarId: string, calendarName: string, now: Date): Promise<void>;   // resets cursor and busy blocks
export async function markConnectionError(tx: Tx, ctx: TenantContext, connectionId: string, errorPlain: string, now: Date): Promise<void>;
export async function deleteConnection(tx: Tx, ctx: TenantContext, userId: string): Promise<boolean>;   // busy blocks and links cascade
export async function connectedMemberCount(tx: Tx, ctx: TenantContext): Promise<number>;   // status 'connected' and the member active (company_members)
// calendar/tokens.ts
export async function accessTokenFor(deps: AppDeps, ctx: TenantContext, conn: CalendarConnectionRow): Promise<string>;   // decrypt, api.refresh, cache in memory until expiry − 60 s; CalendarAuthError → markConnectionError(..., 'Reconnect your calendar.') then rethrow
```
- **Routes (`calendar-connect.ts`, any member, for themselves):**
  - `GET /api/calendar/connection` → `CalendarConnectionView` (with `configured` per provider).
  - `GET /api/calendar/connect/:provider` → 302 to `api.authUrl({ state, redirectUri })`, `redirectUri = ${PUBLIC_BASE_URL}/api/calendar/oauth/${provider}/callback`; unconfigured → 302 to `${APP_ORIGIN}/settings/connections?calendar=not-set-up`.
  - `GET /api/calendar/oauth/:provider/callback?code&state[&error]` → state must match the session's company and user (else `?calendar=failed`); `exchangeCode`; `listCalendars` → the primary writable one; `saveConnection` with `encrypt(JSON.stringify({ refreshToken }), ENCRYPTION_KEY)`; audit `calendar.connected { provider }`; activity none; 302 to `${APP_ORIGIN}/settings/connections?calendar=connected`. A user `error=access_denied` → `?calendar=canceled`.
  - `GET /api/calendar/connection/calendars` → `ExternalCalendar[]` (writable only); `PATCH /api/calendar/connection { calendarId }` (must be in that list) → view.
  - `DELETE /api/calendar/connection` → 204; audit `calendar.disconnected`.
  - `POST /api/calendar/sync` → queues an immediate pull for the caller (Task 14 fills the function it calls: `pullConnection(deps, ctx, conn)`; until then a no-op) → 202.
- **Setup (`connect_calendar`):** `SetupFacts` gains `calendarsConnected: number`; `deriveSetup`: `connect_calendar` is `done` when `calendarsConnected > 0`, else `todo`, with `comingWith: null` (it is no longer a later-spec item; `COMING_WITH` keeps `calendar` only if still used elsewhere — remove it otherwise and update the tests); `progress.total` stays 5 (`FOUNDATION_ITEMS` unchanged). `setupFacts` fills it with `connectedMemberCount`.

- [ ] **Step 1: Write the failing tests:** connect → 302 to the fake auth URL with a state; callback with the fake code saves a connection (token stored encrypted; decrypts to the refresh token), picks `primary`, audits, redirects `?calendar=connected`; a state for another user or company, an expired state (clock +11 min) and a reused state → `?calendar=failed`; change calendar; disconnect; `accessTokenFor` after `revoke` → connection `error` with "Reconnect your calendar."; `GET /api/setup` shows `connect_calendar` done after one connection; shared `deriveSetup` tests updated.
- [ ] **Step 2–4:** CI; `npx vitest run --project @roofline/shared setup` locally.
- [ ] **Step 5: Commit.** `feat(calendar): connect a Google or Outlook calendar per person; the checklist item turns real`

---

### Task 13: Calendar push job

**Split:** Builder 1 `calendar/event-text.ts`; Builder 2 `calendar/push.ts` + `repos/calendar-links.ts`; Builder 3 the tests.

**Files:**
- Create: `apps/api/src/calendar/event-text.ts`
- Modify: `apps/api/src/calendar/push.ts` (replace the stub), `packages/db/src/repos/calendar-links.ts`
- Test: `apps/api/test/calendar-push.test.ts`

**Interfaces:**
```ts
// calendar/event-text.ts — the only place event text is written (no customer phone or email, spec §5.4)
export function eventInputFor(a: AppointmentView, o: { jobUrl: string | null; timeZone: string }): ExternalEventInput;   // title "Inspection — Maria Lopez" (kind label + customer, or the title), location = address, description = "Open in Roofline: <jobUrl>"
// repos/calendar-links.ts
export async function getEventLink(tx: Tx, ctx: TenantContext, appointmentId: string): Promise<(typeof calendarEventLinks.$inferSelect) | null>;
export async function saveEventLink(tx: Tx, ctx: TenantContext, l: { appointmentId: string; connectionId: string; providerEventId: string; etag: string | null }, now: Date): Promise<void>;
export async function setPushError(tx: Tx, ctx: TenantContext, appointmentId: string, errorPlain: string | null): Promise<void>;
export async function deleteEventLink(tx: Tx, ctx: TenantContext, appointmentId: string): Promise<void>;
// calendar/push.ts
export async function pushAppointment(deps: AppDeps, companyId: string, appointmentId: string, meta: JobMeta): Promise<void>;
```
- **`pushAppointment`** (ctx = `systemContext(companyId)`):
  1. Read the appointment (any status), its link, the assignee's connection (status `connected`).
  2. **Link on another connection** (reassigned, or the assignee disconnected) → delete the old event (old connection's token) and the link.
  3. **Canceled/archived or no assignee/connection** → delete the event if linked; done.
  4. **No link** → `createEvent`; save the link.
  5. **Linked** → `updateEvent(etag)`: `{etag}` → save; `'gone'` → create a new event and relink; `'conflict'` → `getEvent`, and if the external `updatedAt` > the appointment's `updated_at`, leave it (the pull applies it), else retry the update once without `If-Match`.
  6. Provider calls happen **outside** any transaction; each DB write is its own short `withTenant`.
  7. `CalendarAuthError` → connection `error` (Task 12's `accessTokenFor` does it) and `setPushError(appointmentId, 'reconnect')` (a reason key; the UI words come from copy), no rethrow. `CalendarUnavailableError` → rethrow (pg-boss retries); on `meta.lastAttempt` store `push_error_plain = 'unavailable'` first.
- **Loop guard:** after a successful create/update, store the returned etag; Task 14 skips events whose etag equals the stored one.

- [ ] **Step 1: Write the failing tests** (`makeTestApp`, connect Sam with the fake, create appointments through the API, `await t.jobs.drain(t.deps)`): create → one fake event with the expected title/location and no phone/email in any field; move → the same event updated; cancel → deleted and link gone; reassign Sam → Pat (both connected) → removed from Sam's, created on Pat's; assignee without a connection → nothing; `revoke` → connection `error`, appointment `sync 'failed'`, no throw; `failNext(5)` → 5 attempts then `failed`; a 412 conflict where the external change is newer → no overwrite.
- [ ] **Step 2–4:** CI.
- [ ] **Step 5: Commit.** `feat(calendar): push appointments to each person's calendar`

---

### Task 14: Calendar pull schedule

**Split:** Builder 1 `calendar/pull.ts`; Builder 2 `system/calendar-sync.ts`, `jobs/scheduler/calendar-pull.ts` and `repos/calendar-busy.ts`; Builder 3 the tests.

**Files:**
- Modify: `apps/api/src/calendar/pull.ts`, `apps/api/src/jobs/scheduler/calendar-pull.ts`, `packages/db/src/system/calendar-sync.ts`, `packages/db/src/repos/calendar-busy.ts`, `apps/api/src/routes/calendar-connect.ts` (only the body of `POST /sync`, to call `pullConnection`)
- Test: `apps/api/test/calendar-pull.test.ts`

**Interfaces:**
```ts
// system/calendar-sync.ts
export async function connectionsDueForPull(system: Db, now: Date, limit: number): Promise<{ companyId: string; userId: string }[]>;   // status connected; last_synced_at null or ≤ now − 5 min; oldest first
// repos/calendar-busy.ts (linkByEventId reads calendar_event_links directly; it does not import Task 13's file)
export async function upsertBusyBlocks(tx: Tx, ctx: TenantContext, connectionId: string, userId: string, events: readonly ExternalEventLike[]): Promise<void>;   // only start/end/allDay/id
export async function removeBusyBlocks(tx: Tx, ctx: TenantContext, connectionId: string, providerEventIds: readonly string[]): Promise<void>;
export async function replaceBusyBlocks(tx: Tx, ctx: TenantContext, connectionId: string, userId: string, events: readonly ExternalEventLike[]): Promise<void>;   // full resync
export async function linkByEventId(tx: Tx, ctx: TenantContext, connectionId: string, providerEventId: string): Promise<{ appointmentId: string; etag: string | null } | null>;
export async function saveCursor(tx: Tx, ctx: TenantContext, connectionId: string, cursor: string, now: Date): Promise<void>;
// calendar/pull.ts
export async function pullConnection(deps: AppDeps, ctx: TenantContext, conn: CalendarConnectionRow): Promise<{ moved: number; canceled: number; busy: number }>;
// jobs/scheduler/calendar-pull.ts
export async function pullCalendars(deps: AppDeps, now: Date): Promise<void>;   // up to 50 connections per tick, each in try/catch (deps.logError)
```
- **`pullConnection`:** window = now − 1 day … now + 60 days; `accessTokenFor`; `syncEvents(cursor)`; for each event:
  - **Linked** (`linkByEventId`): skip when `etag` equals the stored one (our own write); `cancelled` → `setAppointmentStatus(…'canceled')` with the activity "Canceled in <provider word>" (the provider word passed as a key `google|microsoft`; the summary is built from a server-side map `PROVIDER_WORD = { google: 'Google Calendar', microsoft: 'Outlook' }` — server text, not UI copy) and delete the link; times differ and external `updatedAt` > appointment `updated_at` → `updateAppointment` times with "Moved in <provider word>" (no `calendar-push` is queued for a pull-originated change: pass `{ origin: 'pull' }` through a new optional argument on `updateAppointment`, which Task 8's function accepts and ignores for activities but uses to skip the push); older external change → ignore (our push wins next).
  - **Not linked:** `busy` and not `cancelled` → upsert a busy block (times only); `cancelled` or not busy → remove it.
  - `fullResync` → `replaceBusyBlocks` with the full set.
  - Save `nextCursor` and `last_synced_at`.
- **`POST /api/calendar/sync`** runs `pullConnection` for the caller inline (max once per 30 s per user; a second call within 30 s → 202 without pulling).

- [ ] **Step 1: Write the failing tests:** an external move of a linked event → the appointment moves with the activity; external delete → canceled; an outside event → one busy block with no title stored (assert the table has no text column but times) and it blocks availability (Task 9 route); a transparent event → no block; our own push echo is skipped (no activity); cursor expiry → full resync replaces blocks; a revoked token → connection `error`, the tick continues with other connections; the 5-minute due rule; company isolation of the fan-out.
- [ ] **Step 2–4:** CI.
- [ ] **Step 5: Commit.** `feat(calendar): pull calendar changes every five minutes; busy times without details`

---

### Task 15: Pricebook and quotes API

**Split:** Builder 1 `repos/pricebook.ts` and `routes/pricebook.ts`; Builder 2 `repos/quotes.ts` and `routes/quotes.ts`; Builder 3 the tests.

**Files:**
- Modify: `packages/db/src/repos/{pricebook,quotes}.ts` (replacing Task 5's placeholder `listQuoteSummaries`), `apps/api/src/routes/{pricebook,quotes}.ts`
- Test: `apps/api/test/{pricebook,quotes}.test.ts`

**Interfaces:**
```ts
// repos/pricebook.ts
export const DEFAULT_QUOTE_DEFAULTS: QuoteDefaults;   // from v1 defaultScope: waste 12, markup 25, tax 0, material 'architectural'
export async function getPricebook(tx: Tx, ctx: TenantContext): Promise<PricebookView>;   // no row → defaultPricebook, isExample true
export async function savePricebook(tx: Tx, ctx: TenantContext, p: { prices: Pricebook; defaults: QuoteDefaults }, now: Date): Promise<PricebookView>;
// repos/quotes.ts
export async function nextQuoteNumber(tx: Tx, ctx: TenantContext): Promise<string>;   // upsert quote_counters … returning; 'Q-' + 4-digit pad (grows past 9999)
export async function createQuote(tx: Tx, ctx: TenantContext, i: { jobId: string; measurement: QuoteMeasurement; scope: Scope; notes: string | null }, now: Date, timeZone: string): Promise<QuoteView>;   // snapshot prices; calculation = calculateQuote(scope, prices); valid_until = today + 30 days
export async function updateQuote(tx: Tx, ctx: TenantContext, id: string, p: Partial<{ measurement: QuoteMeasurement; scope: Scope; notes: string | null; refreshPrices: boolean }>, now: Date): Promise<QuoteView | 'final' | null>;
export async function finalizeQuote(tx: Tx, ctx: TenantContext, id: string, now: Date): Promise<QuoteView | 'final' | null>;   // sets the job's value_cents when null (through updateJob, activity "Value set from quote Q-0003")
export async function copyQuote(tx: Tx, ctx: TenantContext, id: string, now: Date, timeZone: string): Promise<QuoteView | null>;   // a new draft with today's prices
export async function getQuote(tx: Tx, ctx: TenantContext, id: string): Promise<QuoteView | null>;
export async function listQuoteSummaries(tx: Tx, ctx: TenantContext, jobId: string): Promise<QuoteSummary[]>;
```
- **Scope from measurement:** the quote's `scope.areaSqFt/areaType/pitch` always equal the measurement's; other scope fields default from the pricebook `defaults`.
- **Visibility:** a quote is visible when its job is (`jobScope`); editing as the job. Reps never see the pricebook route; quotes they can see show prices (the quote is the job's).
- **Routes:** `GET /api/pricebook` (owner, office) → `PricebookView`; `PUT` (`company_admin`) → validates `pricebookSchema` (field `prices.<key>` "Enter an amount from 0 to 100,000.") and defaults; audit `pricebook.updated`. `GET /api/jobs/:jobId/quotes` → `{ quotes: QuoteSummary[] }`; `POST /api/jobs/:jobId/quotes { measurement, scope?, notes? }` → 201 `QuoteView` (activity on the job "Quote Q-0001 started"); `GET/PATCH /api/quotes/:id` (PATCH on a final quote → 409 "This quote is final. Copy it to make changes."); `POST /api/quotes/:id/finalize` → `QuoteView` (activity "Quote Q-0001 marked final · $14,250"); `POST /api/quotes/:id/copy` → 201.
- **Carry (F3 T3's scan):** no hard-coded prices in source except v1's ported `defaultPricebook` (already in `pricing.ts`, whose numbers are not the scanned ones).

- [ ] **Step 1: Write the failing tests:** pricebook default and save; office reads, can't save; rep 403 on the pricebook; a quote's calculation equals `calculateQuote` for v1's default scope (assert `totalCents` against the ported test's value); numbering `Q-0001`, `Q-0002` per company, and concurrently two creates get two numbers; changing the pricebook doesn't change an existing final quote; PATCH final → 409; finalize sets the job value when empty, not when set; copy uses today's prices; rep scope and company B 404.
- [ ] **Step 2–4:** CI.
- [ ] **Step 5: Commit.** `feat(quotes): company pricebook and single-option job quotes, frozen when final`

---

### Task 16: Quote PDF

**Split:** Builder 1 `quotes/pdf.ts` (layout, ported from v1); Builder 2 the route in `routes/quotes.ts` (append `GET /:id/pdf`); Builder 3 the tests.

**Files:**
- Create: `apps/api/src/quotes/pdf.ts`
- Modify: `apps/api/src/routes/quotes.ts` (the PDF route only)
- Test: `apps/api/test/quote-pdf.test.ts`

**Interfaces:**
```ts
export type QuotePdfInput = { quote: QuoteView; company: { name: string; phone: string | null; email: string | null; website: string | null; address: string | null };
  customer: { name: string; phone: string | null; email: string | null }; address: string; timeZone: string };
export function renderQuotePdf(i: QuotePdfInput): PDFKit.PDFDocument;   // caller pipes it
export const PDF_COLORS = { ink: '#2b2620', muted: '#6b6257', accent: '#f5b324', band: '#f6f1e6', line: '#eee5cf' };   // S1 tokens, as hex (pdfkit has no CSS)
```
- **Layout:** v1's `renderPdf` structure with Roofline words: company name and contact line; "Roofing estimate"; `Q-0001 · Draft — not final` (draft) or `Q-0001 · Final` · "Created Oct 12, 2026 · Valid through Nov 11, 2026"; customer and address; the scope line (material name, surface square feet, pitch, waste); "Measurement: entered by hand"; the line table (description, quantity, rate, amount); direct cost, "Overhead & profit (25% markup)", "Materials tax (0%)", the total band; "Scope & assumptions" (v1's paragraph); notes; footer `Q-0001 · Prepared with Roofline · 1 / 2`. Helvetica; 9pt minimum in the PDF (print, not the 12px screen rule).
- **Route:** `GET /api/quotes/:id/pdf` → `Content-Type: application/pdf`, `Content-Disposition: attachment; filename="Q-0001-roofing-estimate.pdf"`, streamed; visibility as the quote.

- [ ] **Step 1: Write the failing tests:** the response starts with `%PDF-`; the text (extract with a tiny `pdfkit`-compatible check: compress off in tests via `renderQuotePdf(..., { compress: false })` option, then search the buffer) contains `Q-0001`, the total formatted, and "Draft — not final" for a draft only; rep without the job → 404; company B → 404.
- [ ] **Step 2–4:** CI.
- [ ] **Step 5: Commit.** `feat(quotes): estimate PDF ported from v1`

---

### Task 17: CSV export

**Split:** Builder 1 `repos/export.ts`; Builder 2 `routes/export.ts`; Builder 3 the tests.

**Files:**
- Modify: `packages/db/src/repos/export.ts`, `apps/api/src/routes/export.ts`
- Test: `apps/api/test/export.test.ts`

**Interfaces:**
```ts
export async function* customerExportRows(tx: Tx, ctx: TenantContext, batch = 1000): AsyncGenerator<(string | number | boolean | null)[]>;
export async function* jobExportRows(tx: Tx, ctx: TenantContext, batch = 1000): AsyncGenerator<(string | number | boolean | null)[]>;
export const CUSTOMER_EXPORT_HEADERS = ['Name', 'First name', 'Last name', 'Phone', 'Other phones', 'Email', 'Other emails', 'Address', 'City', 'State', 'ZIP', 'Texting', 'Do not contact', 'Tags', 'Source', 'Created', 'Archived'];
export const JOB_EXPORT_HEADERS = ['Customer', 'Address', 'City', 'State', 'ZIP', 'Stage', 'Value', 'Rep', 'Source', 'Lost reason', 'Next step', 'Next step date', 'Stage since', 'Created', 'Archived'];
```
- Plain-word values (stage labels, consent words from `CONSENT_LABELS`, dollars with two decimals), dates `YYYY-MM-DD` in the company zone, no consent evidence, keyset-paged by `id` in batches.
- **Routes** (owner, office: `view_money_totals`; else 403): `GET /api/export/customers.csv`, `GET /api/export/jobs.csv` → `text/csv; charset=utf-8`, `Content-Disposition: attachment; filename="customers-2026-10-12.csv"`, streamed through `csvCell`/CRLF (Task 4); works in read-only mode (GET). Audit `export.customers|jobs`.

- [ ] **Step 1: Write the failing tests:** headers and one row each exact; a customer named `=HYPERLINK("x")` is neutralized; archived included with "Yes"; rep → 403; company B data absent; read-only (`trial_ended`) still 200; 2,500 customers stream in order.
- [ ] **Step 2–4:** CI.
- [ ] **Step 5: Commit.** `feat(export): customers and jobs as formula-safe CSV`

---
### Task 18: Web skeleton for the C1 screens

**Split:**
- Builder 1: `router.tsx` routes, `shell/apps.ts` (Jobs and Calendar shipped), `copy/dock.ts`/`WINDOW_COPY` additions, `shell/apps.ts` `WindowKey` additions.
- Builder 2: `features/settings/{Settings.tsx,tabs.ts}` (Prices, Schedule tabs), the placeholder components and empty `api.ts` modules.
- Builder 3: the copy files (each with a `comingSoon` line used by its placeholder), `apps/web/test/c1-routes.test.tsx`, and the F2/F3 tests that asserted "coming soon" for Jobs/Calendar.

**Files:**
- Create (placeholders render `EmptyState` with their copy's `comingSoon`):
  - `apps/web/src/features/jobs/{JobsWindow,api}.tsx|ts`, `features/job/{JobWindow,api}.tsx|ts`, `features/customers/{CustomersWindow,CustomerWindow,api}.tsx|ts`, `features/create/{NewJob,NewCustomer,api}.tsx|ts`, `features/calendar/{CalendarWindow,api}.tsx|ts`, `features/appointments/{AppointmentWindow,api}.tsx|ts`, `features/quotes/{QuoteWindow,api}.tsx|ts`, `features/settings/{PricesTab,ScheduleTab}.tsx`
  - copy: `apps/web/src/copy/{jobs,job,customers,create,calendar,appointments,prices,schedule,quotes}.ts`
  - `apps/web/test/c1-routes.test.tsx`
- Modify: `apps/web/src/app/router.tsx`, `apps/web/src/shell/apps.ts`, `apps/web/src/copy/dock.ts`, `apps/web/src/copy/comingSoon.ts` (drop jobs/calendar/customers lines if unused), `apps/web/src/features/settings/{Settings.tsx,tabs.ts}`, `apps/web/src/copy/settings.ts` (tab labels "Prices", "Schedule"), tests that expected the old placeholders.
- Also create: `apps/web/src/shell/recents.ts` — `type Recent = { kind: 'job' | 'customer'; id: string; label: string }`, `readRecents(companyId): Recent[]`, `recordRecent(companyId, r)` (localStorage key `roofline.recents.<companyId>`, newest first, at most 8, every access in try/catch), `useRecordRecent(r)` (records once per mount using `useMe().data.company.id`). Tasks 20 and 21 call it; Task 27 reads it.
- Do not touch: `Shell.tsx`, `UserMenu.tsx` (no C1 slot needed), `api/types.ts`, `api/hooks.ts`.

**Interfaces:**
- **Routes** (under the session shell; all through `AppWindow`), replacing the `jobs/*`, `calendar/*`, `customers/*` "coming soon" routes:
  - `jobs` → `<AppWindow app="jobs"><JobsWindow /></AppWindow>` (board/list by `?view=`), `jobs/new` → `NewJob`, `jobs/:jobId` → `JobWindow`, `jobs/:jobId/quotes/:quoteId` → `QuoteWindow` (inside the job window's `AppWindow app="jobs"`).
  - `customers` → `CustomersWindow` (window key `customers`, title "Customers"), `customers/new` → `NewCustomer`, `customers/:customerId` → `CustomerWindow`.
  - `calendar` → `CalendarWindow` (`?view=&date=&people=`), `calendar/new` → `AppointmentWindow` (new; `?jobId=&customerId=&kind=&start=`), `calendar/appointments/:appointmentId` → `AppointmentWindow`.
  - `settings/:tab` accepts `prices` and `schedule` (owner/office see Prices; everyone sees Schedule).
- **Dock:** `DockApp.shipped` becomes `boolean`; `jobs` and `calendar` are `true` (no "Coming soon" note); phone tabs unchanged (they already link `/jobs`, `/calendar`).
- **`WINDOW_COPY`:** `customers: { title: 'Customers', description: 'Everyone you work with' }`; jobs/calendar descriptions unchanged.
- **Jobs window tabs:** `JobsWindow` renders a tab row "Pipeline" (`/jobs`) · "Customers" (`/customers`) — the `CustomersWindow` renders the same tab row (Decision 8); the shared tab row lives in `features/jobs/JobsTabs.tsx` (created here).

- [ ] **Step 1: Write the failing tests** (`c1-routes.test.tsx`): each new URL renders its placeholder inside the right dialog; `/settings/prices` for owner, and office; `/settings/schedule` for a rep; the dock's Jobs and Calendar have no "Coming soon"; unknown `/jobs/x/y/z` still shows Not found where appropriate.
- [ ] **Step 2–4:** `npx vitest run --project @roofline/web && npm run lint && npm run lint:css && npm run typecheck && npm run build:web`.
- [ ] **Step 5: Commit.** `feat(web): routes, dock and settings tabs for the C1 screens`

---

### Task 19: Web: pipeline board and list

**Split:** Builder 1 `Board.tsx`, `BoardColumn.tsx`, `JobCardView.tsx` (drag and drop), `BoardFilters.tsx`; Builder 2 `MoveJobMenu.tsx`, `MoveJobSheet.tsx` (lost reason, value), `JobsList.tsx`, `copy/jobs.ts`, `features/jobs/api.ts` (`useMoveJob`); Builder 3 the shared timeline (`features/timeline/{Timeline,NoteComposer,api}.tsx|ts`, `copy/timeline.ts`, imported by Tasks 20 and 21) and the tests.

**Files:**
- Create: `apps/web/src/features/jobs/{Board,BoardColumn,JobCardView,MoveJobMenu,MoveJobSheet,JobsList,BoardFilters}.tsx` (+ CSS Modules), `apps/web/src/features/timeline/{Timeline,NoteComposer,api}.tsx|ts`, `apps/web/src/copy/timeline.ts`
- Modify: `apps/web/src/features/jobs/{JobsWindow.tsx,api.ts}`, `apps/web/src/copy/jobs.ts`
- Test: `apps/web/test/jobs-board.test.tsx`, `apps/web/test/timeline.test.tsx`

**Interfaces:**
- **Hooks (`features/jobs/api.ts`):** `jobsKeys = { board: (f) => ['jobs-board', f] as const, column: … }`; `useBoard(filter: BoardFilterParams)`; `useBoardColumnPage(stage, filter, offset)`; `useMoveJob()` → mutation `({ jobId, to, valueCents?, lostReason? })` = `PATCH /api/jobs/:id`, optimistic on every cached board (move the card, fix counts), rollback + toast the API message on error, invalidate `['jobs-board']` and `['job', jobId]` on settle. Exported for Task 20.
- **`MoveJobMenu({ job, onMoved? })`:** a kit `Select` labelled `jobs.moveTo` "Move to…" listing the other stages (labels from `jobs.stage`) — choosing Lost or Won (without a value) opens `MoveJobSheet`; Installed is listed only when the job is Won (Decision 2, rule 3). `MoveJobSheet({ job, to, onDone })`: Lost → a `Select` of the six reasons (`jobs.lostReasons`: "Price", "Went with another roofer", "Insurance denied the claim", "No damage found", "Stopped responding", "Not ready yet", "Other") plus a `Field` for Other; Won → a money `Field` "Job value" (dollars → cents). Exported for Task 20.
- **Board:** columns from `BOARD_STAGES` with header `jobs.columnHeader(label, count)` and the total (`jobs.total(dollars)`) only when `totalCents !== null`; the Lost drawer `jobs.lostDrawer(count)` toggles a list. Cards are `UiLink`s to `/jobs/:id` with `draggable`; dropping on a column calls `useMoveJob` (or opens the sheet); each card also renders `MoveJobMenu` (compact). `data-stage`, `data-stuck` attributes. "Show N more" per column.
- **Card text:** name, address, `jobs.value(dollars)` when visible, rep (`Avatar` + name or `jobs.unassigned`), `jobs.daysInStage(n)` ("3 days"), `jobs.stuck(n)` ("Stuck 15 days"), next step `jobs.nextStep(text, date)`.
- **Filters** (`BoardFilters`): assignee `Select` (`jobs.filterAll`, `jobs.filterMine`, `jobs.filterUnassigned`, each member from `GET /api/team` — rep sees no member list), source `Select`, a text `Field` (debounced 300 ms), "Show archived" `Toggle`; all mirrored in the URL (`useSearchParams`). Buttons "New job" (`/jobs/new`) and "Download jobs" (owner/office → `/api/export/jobs.csv`, a plain anchor with `download`).
- **Timeline (`features/timeline`):** `<Timeline customerId? jobId? />` — items newest first (`useTimeline`, an infinite query on `before` over `GET /api/timeline`); activity rows with actor and relative time ("2 hours ago", absolute in `title`); text rows as chat bubbles (in/out) with status words from `copy/status.ts`; "Show older"; `NoteComposer` (multiline `Field`, 2,000 max with a counter, "Add note" → `useAddNote` = `POST /api/notes`, prepends the returned item). Words in `copy/timeline.ts`.
- **List view** (`?view=list`, and always on phone via `useIsPhone`): a table (desktop) or stacked rows (phone) with stage chips; sorted by stage then updated; each row has `MoveJobMenu`.

- [ ] **Step 1: Write the failing tests:** timeline renders items newest first, "Show older" sends `before`, a note posts and appears at the top, 2,001 characters is refused; columns and counts from a stubbed `BoardView`; totals shown for owner, hidden when null; drag a card from Lead to Inspection → PATCH `{ stage: 'inspection' }` and the card is in the new column before the response; a 400 rolls back and toasts; Move to → Lost opens the sheet and sends `{ stage: 'lost', lostReason: 'Price' }`; Won without a value asks for it; Installed not offered unless Won; filters update the URL and the request; phone shows the list.
- [ ] **Step 2–4:** `npx vitest run --project @roofline/web jobs-board`, lint, typecheck, build.
- [ ] **Step 5: Commit.** `feat(web): pipeline board with drag, a Move-to menu, filters and a list view`

---

### Task 20: Web: job window

**Split:** Builder 1 `JobWindow.tsx` header, stage stepper, edit sheet; Builder 2 sections (appointments, quotes, agent tasks, the imported `Timeline`); Builder 3 `copy/job.ts`, `features/job/api.ts`, tests.

**Files:**
- Create: `apps/web/src/features/job/{JobHeader,StageStepper,EditJobSheet,JobSections}.tsx`
- Modify: `apps/web/src/features/job/{JobWindow.tsx,api.ts}`, `apps/web/src/copy/job.ts`
- Test: `apps/web/test/job-window.test.tsx`

**Interfaces:**
- **Hooks:** `useJobView(id)` (`['job', id]`, `GET /api/jobs/:id/view`); `useUpdateJob(id)` (PATCH value/source/rep/next step; invalidates `['job', id]` and `['jobs-board']`); `useArchiveJob(id)`. Calls `useRecordRecent({ kind: 'job', id, label })` (Task 18's `shell/recents.ts`).
- **Window:** `AppWindow app="jobs"` with the stat strip: stage label, `job.value` (when visible), `job.daysInStage`. Header: customer link (`/customers/:id`), address link (`/?focus=<propertyId>`), `StageStepper` (five open stages, current highlighted, Lost shown as a state chip; clicking a stage moves via Task 19's `useMoveJob`/`MoveJobSheet`), `MoveJobMenu`, rep `Select` (members + Unassigned; reps see only themselves + Unassigned), next step line with "Edit".
- **Sections:** Appointments (`AppointmentView` list with time, kind, person; buttons "Book inspection" → `/calendar/new?jobId=<id>&kind=inspection`, "Book install" → `…&kind=install`); Quotes (`QuoteSummary` rows → `/jobs/:id/quotes/:quoteId`; "New quote" → POST then navigate); Agent tasks (links to `/approvals/:taskId`); Timeline (`<Timeline jobId=… />`).
- **Edit sheet:** value (dollars), source, next step text + date; archive/restore with a confirm.

- [ ] **Step 1: Write the failing tests:** renders the view; a rep sees no value; stepper click to Proposal sends PATCH; Lost via stepper opens the sheet; Book inspection link URL; the timeline mounts with `jobId`; 404 → the Not found empty state.
- [ ] **Step 2–4:** web suite, lint, typecheck, build.
- [ ] **Step 5: Commit.** `feat(web): job window with stage stepper, appointments, quotes and the timeline`

---

### Task 21: Web: customers list and customer window

**Split:** Builder 1 `CustomersWindow.tsx` (list, filters, export); Builder 2 `CustomerWindow.tsx` (header, homes, jobs, upcoming, timeline import); Builder 3 `EditCustomerSheet.tsx` (names, phones, emails, tags, consent, do-not-contact), `copy/customers.ts`, `features/customers/api.ts`, tests.

**Files:**
- Create: `apps/web/src/features/customers/{CustomerHeader,CustomerHomes,EditCustomerSheet,ConsentChip}.tsx`
- Modify: `apps/web/src/features/customers/{CustomersWindow.tsx,CustomerWindow.tsx,api.ts}`, `apps/web/src/copy/customers.ts`
- Test: `apps/web/test/{customers-list,customer-window}.test.tsx`

**Interfaces:**
- **Hooks:** `useCustomers({ q, archived, offset })` (`GET /api/customers` — the F1 list, already sorted by name; tag and texting filters apply client-side to the loaded page, noted as a follow-up for a server filter), `useCustomerView(id)`, `useUpdateCustomer(id)` (F1 PATCH), `useArchiveCustomer(id)`.
- **List:** `JobsTabs` (Task 18) on top; search `Field`; filters; rows (name, primary phone, city, texting chip, jobs count); "New customer" → `/customers/new`; "Download customers" (owner/office → `/api/export/customers.csv`).
- **Customer window:** `AppWindow app="customers"`; header with the texting `ConsentChip` (`customers.consent.none` "No texting consent", `express` "Texts about their own jobs only", `attested`/`written` "OK to text", `revoked` "Asked not to be texted") and "Do not contact"; phones as `tel:` links on phone; homes (address, "Not on the map yet" + "Place on map" → `POST /api/properties/:id/locate`), jobs (`JobCard` rows with stage chips), upcoming appointments, timeline (`<Timeline customerId=… />` from Task 19). Calls `useRecordRecent({ kind: 'customer', id, label })`.
- **Edit sheet:** names; phones (add/remove, label, primary); emails; tags (comma input); consent `Select` (only when `can.changeConsent`; raising to `attested`/`written` shows a confirm line "Only do this if they agreed in writing or in your records"); do-not-contact `Toggle`; a duplicate-phone 400 shows under the phone with "Open that customer" link (the API message names them).
- **Actions:** New job (`/jobs/new?customerId=`), Add a home (`/customers/:id?addHome=1` opens Task 22's `AddHomeSheet` — imported from `features/create`), Book an appointment (`/calendar/new?customerId=`), Archive/Restore.

- [ ] **Step 1: Write the failing tests:** list search sends `q`; consent chip words; office changes consent with the confirm; a rep sees no consent select; duplicate phone error shows the link; Place on map posts locate; archive confirm.
- [ ] **Step 2–4:** web suite, lint, typecheck, build.
- [ ] **Step 5: Commit.** `feat(web): customers list and customer window with editing and the timeline`

---

### Task 22: Web: new customer, new job, add a home

**Split:** Builder 1 `NewCustomer.tsx`; Builder 2 `NewJob.tsx` (customer typeahead, home pick or new address); Builder 3 `AddHomeSheet.tsx`, `CustomerPicker.tsx`, `copy/create.ts`, `features/create/api.ts`, tests.

**Files:**
- Create: `apps/web/src/features/create/{AddHomeSheet,CustomerPicker,AddressFields}.tsx`
- Modify: `apps/web/src/features/create/{NewCustomer.tsx,NewJob.tsx,api.ts}`, `apps/web/src/copy/create.ts`
- Test: `apps/web/test/create.test.tsx`

**Interfaces:**
- **Hooks:** `useCreateCustomer()` (F1 `POST /api/customers`), `useCreateProperty()` (`POST /api/properties` without lat/lng → server geocodes), `useCreateJob()` (`POST /api/jobs`), `useCustomerSearch(q)` (`GET /api/customers?q=&limit=8`).
- **New customer** (`/customers/new`): first/last name (display name derived "First Last" unless edited), phone(s), email(s), optional first home (`AddressFields`: street, city, state `Select` of `US_STATE_NAMES`, ZIP), a `Checkbox` "They agreed to get texts about their jobs" (→ consent `express`, source `manual`). Save → creates the customer, then the home → navigate to `/customers/:id`. A home that wasn't found shows the toast `create.notOnMap` "Saved. We couldn't find that address on the map yet."
- **New job** (`/jobs/new`, optional `?customerId=`): step 1 `CustomerPicker` (typeahead; "New customer" inline: name + phone + email); step 2 pick one of the customer's homes or "New address" (`AddressFields`); step 3 stage (default Lead), source (default Manual; the six F1 sources as words), rep (rep: themselves, fixed), value. "Create job" → navigate to `/jobs/:id`. Click budget: from the map home ⌘K "New job" → form is 2 clicks (spec §13).
- **`AddHomeSheet({ customerId })`:** `AddressFields` + Save.

- [ ] **Step 1: Write the failing tests:** new customer posts customer then property, navigates; texting checkbox sends `express`; new job with an existing customer and home posts once and navigates; inline new customer path; a rep's rep field is fixed; field errors land under their fields.
- [ ] **Step 2–4:** web suite, lint, typecheck, build.
- [ ] **Step 5: Commit.** `feat(web): create customers, jobs and homes from the screens`

---

### Task 23: Web: calendar views

**Split:** Builder 1 `WeekView.tsx` and `DayView.tsx` (CSS grid, all-day row, busy blocks, now line); Builder 2 `AgendaView.tsx`, `PeoplePicker.tsx`, `CalendarToolbar.tsx`; Builder 3 `copy/calendar.ts`, `features/calendar/api.ts`, `time.ts` (zone helpers), tests.

**Files:**
- Create: `apps/web/src/features/calendar/{WeekView,DayView,AgendaView,PeoplePicker,CalendarToolbar,time}.tsx|ts` (+ CSS Modules)
- Modify: `apps/web/src/features/calendar/{CalendarWindow.tsx,api.ts}`, `apps/web/src/copy/calendar.ts`
- Test: `apps/web/test/calendar.test.tsx`

**Interfaces:**
- **Hooks:** `useAppointments({ from, to, userIds })`, busy blocks come in the same request (`GET /api/appointments?…&withBusy=true` → `{ appointments, busy: { userId, start, end, allDay }[] }`, Ruling 6), `useSyncNow()` (`POST /api/calendar/sync` on window open, once per mount), `useCompany` (F2) for the zone.
- **`time.ts`:** `zonedParts(date, zone)`, `startOfZonedDay(date, zone)`, `addZonedDays`, `weekStart(date, zone)` (Monday), `formatTime(date, zone)` — all via `Intl`, tested on DST days.
- **Week/Day:** 06:00–21:00 visible rows (30-minute lines, scroll to 07:00), an all-day row on top, appointments positioned by start/end in the company zone, overlapping items side by side, colors per person (stage palette tokens), canceled hidden (toggle "Show canceled"), busy blocks grey with `calendar.busy` "Busy"; clicking an empty slot → `/calendar/new?start=<iso>&people=…`; clicking an item → `/calendar/appointments/:id`. Keyboard: arrow keys move focus between items; Enter opens.
- **Agenda:** grouped by day, next 14 days, "Load more".
- **Toolbar:** Today, previous/next, view switch (Week, Day, List), date label, people picker (owner/office: members with color dots; rep: hidden), "New appointment"; a note `calendar.zoneNote(zoneName)` when the browser zone differs.
- **URL:** `view`, `date` (company-zone `YYYY-MM-DD`), `people` (comma ids).

- [ ] **Step 1: Write the failing tests:** week renders appointments at the right rows for Chicago while the test's `TZ` is `UTC` (set `process.env.TZ` in the test file); all-day install spans the row; busy blocks show "Busy"; empty-slot click URL; people picker updates the request; agenda on phone; DST week of 2026-11-01 positions.
- [ ] **Step 2–4:** web suite, lint, typecheck, build.
- [ ] **Step 5: Commit.** `feat(web): calendar week, day and agenda views in the company time zone`

---

### Task 24: Web: appointment sheet with suggested times

**Split:** Builder 1 the form (kind, customer/job typeahead, person, date/time or all-day range, notes); Builder 2 `SuggestedTimes.tsx` (availability) and conflict warnings; Builder 3 the detail view (reschedule, mark done, no-show, cancel), `copy/appointments.ts`, `features/appointments/api.ts`, tests.

**Files:**
- Create: `apps/web/src/features/appointments/{AppointmentForm,SuggestedTimes,AppointmentDetail}.tsx`
- Modify: `apps/web/src/features/appointments/{AppointmentWindow.tsx,api.ts}`, `apps/web/src/copy/appointments.ts`
- Test: `apps/web/test/appointments.test.tsx`

**Interfaces:**
- **Hooks:** `useAppointment(id)`, `useCreateAppointment()`, `useUpdateAppointment(id)`, `useAppointmentAction(id)` (cancel/complete/no-show), `useAvailability({ userId?, kind, propertyId?, from, to })`.
- **Form:** kind `Select` (`appointments.kind.*` "Inspection", "Install", "Adjuster visit", "Other"); customer/job typeahead (prefilled from `jobId`/`customerId` query; the job fixes customer and home); person `Select` (rep: themselves); date and time inputs (company zone) or, for installs, a start and end date; notes. **Suggested times:** for inspection/adjuster/other, the next 5 slots from `useAvailability` (from now, 14 days) as buttons ("Tue 2:00 PM · Sam"); choosing one fills date, time and person. Save → `POST /api/appointments`; the response's `warnings` show in a `Banner tone="warning"` after save (with "Keep it" / "Change time"), and `jobMoved` toasts `appointments.jobMoved` "Moved the job to Inspection."
- **Detail:** time, kind, person, customer/job links, address (map link), notes, sync state (`appointments.sync.synced` uses the provider word from `copy/connections.ts`: "On your Google calendar" / "On your Outlook calendar"; `failed` → "Couldn't update your calendar" with "Try again" = PATCH no-op re-save), and actions Reschedule (opens the form), Mark done, No-show, Cancel (confirm).
- **Click budget:** job window "Book inspection" → this form with suggestions → pick a suggestion → Save = 3 clicks (spec §13).

- [ ] **Step 1: Write the failing tests:** prefill from `?jobId=&kind=inspection`; suggestions fill the fields; save posts the right body (ISO instants from company-zone input); warnings banner; job-moved toast; install shows a date range and posts all-day; detail actions post; a rep cannot pick another person.
- [ ] **Step 2–4:** web suite, lint, typecheck, build.
- [ ] **Step 5: Commit.** `feat(web): appointment form with suggested times, warnings and quick actions`

---

### Task 25: Web: Settings Prices, Schedule and Your calendar; the setup row

**Split:** Builder 1 `PricesTab.tsx`; Builder 2 `ScheduleTab.tsx` (company hours and settings for the owner; my hours for everyone; `WorkHoursEditor.tsx`); Builder 3 `CalendarConnection.tsx` in the Connections tab, the `SetupRow` change, `copy/{prices,schedule}.ts`, `copy/connections.ts` and `copy/setup.ts` additions, tests.

**Files:**
- Create: `apps/web/src/features/settings/{WorkHoursEditor,CalendarConnection}.tsx`, `apps/web/src/features/settings/crm-api.ts`
- Modify: `apps/web/src/features/settings/{PricesTab,ScheduleTab,LaterTab}.tsx` (Connections renders `CalendarConnection` above the ad-accounts line), `apps/web/src/features/setup/SetupRow.tsx` (the `connect_calendar` action), `apps/web/src/copy/{prices,schedule,connections,setup}.ts`
- Test: `apps/web/test/{settings-prices,settings-schedule,calendar-connection}.test.tsx`

**Interfaces:**
- **Hooks (`crm-api.ts`):** `usePricebook()`, `useSavePricebook()`, `useScheduleSettings()`, `useSaveScheduleSettings()`, `useMyHours()`, `useSaveMyHours()`, `useCalendarConnection()`, `useCalendars()`, `useChooseCalendar()`, `useDisconnectCalendar()`.
- **Prices:** groups Materials (architectural bundle, designer bundle, metal per square), Labor (per square, metal per square, tear-off, steep, extra story), Per-foot (ridge, drip edge, valley), Other (underlayment per square, decking per sheet, disposal, permit), and defaults (waste %, markup %, tax %, material). Dollar `Field`s; owner saves, office read-only with `prices.ownerOnly`; `isExample` → `Banner tone="info"` "Example prices — set your own."
- **Schedule:** owner: company work hours (`WorkHoursEditor`: per weekday on/off and up to 3 time ranges), travel buffer, minimum notice, stuck days; everyone: "Your hours" (`Toggle` "Use the company hours" or own editor). Validation errors from the API by field.
- **Your calendar** (`CalendarConnection`): not connected → two buttons "Connect Google Calendar" and "Connect Outlook" (plain anchors to `/api/calendar/connect/google|microsoft`, disabled with "Calendar connections aren't set up yet." when `configured` is false); connected → account email, calendar `Select` (from `useCalendars`), last synced time, "Disconnect" (confirm: "Your appointments stay in Roofline and on your calendar."); `error` → `Banner tone="danger"` "Reconnect your calendar" + the connect button. Reads `?calendar=connected|failed|canceled|not-set-up` once and toasts. Vendor words come from `copy/connections.ts`.
- **Setup row:** `connect_calendar` now has the action "Connect your calendar" → `/settings/connections` (owner and everyone else may act on their own connection; the row's owner-only rule does not apply to this action); its copy in `copy/setup.ts` drops "Coming with the calendar".

- [ ] **Step 1: Write the failing tests:** prices save body equals `pricebookSchema` shape in dollars; office read-only; schedule editor rejects overlapping ranges with the API's message; my hours toggle; connection states (not configured, connect hrefs, connected with a calendar change, error banner, `?calendar=connected` toast once); setup row action link.
- [ ] **Step 2–4:** web suite, lint, typecheck, build (copy-rules: vendor names only in `connections.ts`/`setup.ts`).
- [ ] **Step 5: Commit.** `feat(web): prices, schedule and your calendar in Settings`

---

### Task 26: Web: quote editor and PDF link

**Split:** Builder 1 `QuoteEditor.tsx` (measurement and scope inputs, live price); Builder 2 `QuoteLines.tsx`, `QuoteTotals.tsx`; Builder 3 `QuoteWindow.tsx` actions (save, mark final, copy, download PDF), `copy/quotes.ts`, `features/quotes/api.ts`, tests.

**Files:**
- Create: `apps/web/src/features/quotes/{QuoteEditor,QuoteLines,QuoteTotals}.tsx` (+ CSS Module)
- Modify: `apps/web/src/features/quotes/{QuoteWindow.tsx,api.ts}`, `apps/web/src/copy/quotes.ts`
- Test: `apps/web/test/quote-editor.test.tsx`

**Interfaces:**
- **Hooks:** `useQuote(id)`, `useSaveQuote(id)` (PATCH), `useFinalizeQuote(id)`, `useCopyQuote(id)`.
- **Editor:** area (sq ft) with a surface/footprint `Select`, pitch (x/12), material, waste %, stories, layers, ridge/edge/valley feet, decking sheets, markup %, tax %, notes; every change recomputes with `calculateQuote(scope, quote.prices)` in the browser (the frozen snapshot, not the live pricebook); "Save" PATCHes; unsaved changes warn on close.
- **Display:** `quotes.estimateLabel` "Estimate" on the total (master §9.2); line table (name, quantity + unit, rate, amount — two-decimal money); totals (direct cost, overhead & profit with the markup %, tax, total).
- **Final:** "Mark final" (confirm) → read-only view with "Copy to a new quote"; `finalizedAt` shown. "Download PDF" is an anchor to `/api/quotes/:id/pdf` (always available).
- Window: inside the job's `AppWindow` (title stays "Jobs"; the stat strip shows `Q-0001`, status, total).

- [ ] **Step 1: Write the failing tests:** the live total equals `calculateQuote` for v1's default scope; save body; final makes inputs read-only and shows Copy; copy navigates to the new quote; the PDF link href.
- [ ] **Step 2–4:** web suite, lint, typecheck, build.
- [ ] **Step 5: Commit.** `feat(web): job quote editor with live pricing and the PDF download`

---

### Task 27: Web: Today, ⌘K actions and recents, map focus, export buttons

**Split:** Builder 1 Today (`features/today/Today.tsx` sections "Today's appointments" and "Follow up today", `features/today/api.ts` `useToday`); Builder 2 ⌘K (`shell/topbar/SearchDialog.tsx`, `searchOptions.ts`: actions group and recents, `shell/recents.ts`); Builder 3 map focus (`shell/map/MapView.tsx`: `?focus=<propertyId>`), `copy/{today,search}.ts`, tests.

**Files:**
- Modify: `apps/web/src/features/today/{Today.tsx,api.ts}`, `apps/web/src/shell/topbar/{SearchDialog.tsx,searchOptions.ts}`, `apps/web/src/shell/map/MapView.tsx`, `apps/web/src/copy/{today,search}.ts`
- Test: `apps/web/test/{today-crm,search-actions,map-focus}.test.tsx`

**Interfaces:**
- **Today:** replaces F2's "No appointments yet" with `useToday()` (`GET /api/today`): appointment rows (time, kind, customer, address; link to the appointment), owner/office link `today.seeEveryone` → `/calendar?view=day&date=<today>`; "Follow up today" rows (`JobCard` name + next step, link to the job). Empty states `today.noAppointments` "Nothing on your calendar today." and none for follow-ups (section hidden).
- **⌘K:** an **Actions** group matched by words in the query (`search.actions`: "New job" → `/jobs/new`, "New customer" → `/customers/new`, "Book an inspection" → `/calendar/new?kind=inspection`, "Open calendar" → `/calendar`, "Download customers" (owner/office) → the CSV), shown above results; with an empty query, **Recent** = `readRecents(companyId)` from Task 18's `shell/recents.ts`; keyboard navigation unchanged.
- **Map focus:** `/?focus=<propertyId>` → after pins load, fly to the pin (`easeTo`, zoom 16) and open its card; unknown id → nothing.

- [ ] **Step 1: Write the failing tests:** Today lists appointments and follow-ups from a stubbed `/api/today`; the "see everyone" link for owner only; ⌘K "new" shows New job/New customer; Enter on an action navigates; recents show on empty query (seeded storage) and survive a storage error; map focus calls `easeTo` with the pin's coordinates (map mocked as in F2's map tests).
- [ ] **Step 2–4:** web suite, lint, typecheck, build.
- [ ] **Step 5: Commit.** `feat(web): today's appointments and follow-ups, search actions and recents, map focus`

---

### Task 28: End-to-end tests, the acceptance map and the docs

**Split:** Builder 1 `apps/web/e2e/crm.spec.ts`; Builder 2 `apps/web/e2e/calendar.spec.ts` plus the `phone.spec.ts` and `a11y.spec.ts` additions; Builder 3 `docs/superpowers/c1-acceptance.md` and README updates.

**Files:**
- Create: `apps/web/e2e/{crm,calendar}.spec.ts`, `docs/superpowers/c1-acceptance.md`
- Modify: `apps/web/e2e/phone.spec.ts`, `apps/web/e2e/a11y.spec.ts`, `README.md` ("Running in production": calendar OAuth env and redirect URIs `<PUBLIC_BASE_URL>/api/calendar/oauth/google/callback` and `/microsoft/callback`)

**Tests** (stack with `FAKE_PROVIDERS=1`, the fake calendar; owner unless stated; `markTodaySeen`):
- `crm.spec.ts`: `test('the board shows the showcase pipeline')` (column counts 8/7/6/4/2, Lost 1); `test('drag a lead to Inspection, then Lost asks why')`; `test('a new job from the map home in 2 clicks to its form')` (⌘K "New job" → form; `clicks.count <= 2`), then create it with a new customer and address → the job window, the pin appears on the map; `test('the timeline shows a note, a stage move and a quote')`; `test('a quote prices, goes final and downloads a PDF')` (`waitForEvent('download')`, filename `Q-0001-roofing-estimate.pdf`); `test('a rep sees only their jobs')` (login rep).
- `calendar.spec.ts`: `test('book an inspection from a lead in 3 clicks and the job moves')` (job window → Book inspection → first suggestion → Save; `clicks.count === 3`; job stage Inspection); `test('connect a calendar, and appointments sync both ways')` (Settings → Connections → Connect Google → the fake auth URL is followed by a test-only redirect to the callback with `code=fake` — implement the fake's `authUrl` to point at `${PUBLIC_BASE_URL}/api/calendar/oauth/google/callback?code=fake&state=…` when `FAKE_PROVIDERS` so the browser round-trip works; then an appointment's detail shows "On your Google calendar"; the inbound direction is not driven from the browser (Ruling 9) and is mapped to Task 14's integration tests in the acceptance map). The fake's `authUrl` change (pointing straight at the callback with `code=fake` when `FAKE_PROVIDERS` is on) is made in `providers/fakes/calendar.ts` by this task.
- `phone.spec.ts` (append): `/jobs` (list view), `/jobs/<id>`, `/customers/<id>`, `/calendar` (agenda) → `scrollWidth <= 375`.
- `a11y.spec.ts` (append): `/jobs`, `/jobs/<id>`, `/customers/<id>`, `/calendar?view=week` → no serious or critical violations.
- **`c1-acceptance.md`:** every bullet of the spec's §14 mapped to its tests (file and test name), in the F1/F2 format; the inbound-sync bullet points at `calendar-pull.test.ts`; the real-calendar bullets point at Task 29's runbook.
- [ ] Verify: locally typecheck, lint, `npx playwright test --list -c apps/web/playwright.config.ts`; CI E2E job (both projects) via `ops/bin/ci-check` with `CI_JOBS="Platform E2E"`.
- [ ] Commit: `test(e2e): pipeline, records, quotes and calendar; C1 acceptance map`

---

### Task 29: Manual smoke: real Google and Outlook calendars

**Split:** Builder 1 `apps/api/src/scripts/smoke/calendar.ts`; Builder 2 `docs/superpowers/c1-manual-smoke.md`; Builder 3 the guard test.

**Files:**
- Create: `apps/api/src/scripts/smoke/calendar.ts`, `docs/superpowers/c1-manual-smoke.md`, `apps/api/test/smoke-calendar-guards.test.ts`
- Modify: `apps/api/package.json` (`"smoke:calendar": "tsx src/scripts/smoke/calendar.ts"` only)

**Interfaces:**
- `smoke:calendar --provider google|microsoft --confirm-real-calendar` (refuses without the flag, reusing F3 T37's `assertConfirmed` pattern with this flag): prints an auth URL, reads the pasted code, creates a test event "Roofline smoke — delete me" tomorrow 10:00–11:00, waits for Enter while the operator moves it in the real calendar, runs `syncEvents` and prints what moved, then deletes the event. Never prints tokens.
- **Runbook:** for each provider: connect through the app on staging with a real account, book/move/cancel an appointment and see it in the real calendar within a minute; move and delete it in the real calendar and see the app follow within 5 minutes; an outside event appears as "Busy"; revoke access in the account's security settings and see "Reconnect your calendar". A sign-off table at the end.
- [ ] Verify: typecheck, lint; the guard test on CI. **Never run `smoke:*` in automation.**
- [ ] Commit: `test(smoke): real Google and Outlook calendar run, by hand only`

---

## Rulings

1. **All C1 schema is in Task 1's two migrations (0012, 0013).** No later task adds a migration.
2. **Task 1 installs the only new npm dependency** (`pdfkit` + `@types/pdfkit`). No later task edits `package-lock.json`.
3. **Skeleton tasks own the hotspots:** Task 1 (schema, barrels, lockfile), Task 5 (`app.ts`, `config.ts`, `deps.ts`, `jobs/{queue,handlers,worker}.ts`, `test/helpers.ts`, `.env.example`, README env table), Task 18 (`router.tsx`, `shell/apps.ts`, `copy/dock.ts`, `Settings.tsx`, `tabs.ts`).
4. **Placeholder signatures, bodies later:** Task 5 (the skeleton) creates `listAppointmentsForJob`, `listAppointmentsForCustomer` (in `repos/appointments.ts`) and `listQuoteSummaries` (in `repos/quotes.ts`) returning `[]` with their final signatures; Tasks 6 and 7 call them; Tasks 8 and 15 replace the bodies without changing the signatures. So no two parallel tasks write the same file.
5. **The calendar provider interface is `CalendarApi`** (the shared `CalendarProvider` is the `'google' | 'microsoft'` type).
6. **Busy blocks travel with appointments:** `GET /api/appointments?…&withBusy=true` returns `{ appointments, busy }` (Task 8), so the web calendar makes one request per range.
7. **Pull-originated changes never queue a push** (`updateAppointment(..., { origin: 'pull' })`, Task 8 accepts the option; Task 14 passes it) — this is the loop guard together with the stored etag.
8. **Provider words in server activity text** (`Google Calendar`, `Outlook`) come from a server map in `calendar/pull.ts`; the web shows vendor names only from `copy/connections.ts`.
9. **Calendar e2e covers the outbound direction and UI states only;** the inbound direction is proven by Task 14's integration tests (the e2e stack runs the API in another process, so the browser test cannot drive the fake's external edits).
10. **Recents live in the browser** (`localStorage`, per company), never on the server, and the app works when storage throws.
11. **No dock badges, no homeowner texts, no merge** in C1 (spec Decisions 12, 27; Scheduler agent owns appointment texts).
