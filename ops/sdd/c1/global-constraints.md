## Global Constraints (C1 Core CRM)

Adapted from `ops/sdd/f3/global-constraints.md` and the plan's Global Constraints (`docs/superpowers/plans/2026-10-12-roofline-core-crm.md`). Spec: `docs/superpowers/specs/2026-10-12-roofline-core-crm-design.md` (decision numbers refer to it). Branch `c1-crm` from `f3-setup` once F3 is complete; task branches `c1-t<N>`.

**Code and repo (F1–F3 rules, unchanged)**
- **Language and modules:** Node ≥ 22.13, TypeScript strict, ESM. Relative imports carry explicit `.ts`/`.tsx` extensions.
- **Enum columns:** `text` with drizzle `{ enum }` plus a CHECK (`enumCheck`), never `pgEnum`. New `as const` arrays live in `@roofline/shared` and are re-exported by `packages/db/src/schema/enums.ts` when the schema needs them.
- **Tenant tables:**
  - Each has `company_id uuid not null` and `unique (company_id, id)` when referenced.
  - Each is listed in `TENANT_TABLES` (`packages/db/src/schema/tenant.ts`).
  - Each gets `ENABLE` + `FORCE ROW LEVEL SECURITY` and the `tenant_isolation` policy, using exactly `company_id = nullif(current_setting('app.company_id', true), '')::uuid`.
  - Links between tenant tables are composite `(company_id, x_id)` foreign keys.
- **`app_system` on tenant tables:** column-level SELECT only, plus an `app_system_all` policy on each such table (the `rls.test.ts` rule). C1 grants it only on `calendar_connections`.
- **Migrations:** C1 owns `0013_crm_schema.sql` (generated) and `0014_crm_grants_rls.sql` (custom), both in Task 1. F3 ends at `0012_early_reports_prune.sql` (Ruling AO); no other C1 task adds a migration.
- **Lockfile:** only Task 1 edits `package-lock.json` (`pdfkit`, `@types/pdfkit`).
- **`@roofline/db/system` imports:** only from `apps/api/src/{auth,hooks,jobs/scheduler,scripts,account,public}/**`, `apps/worker/**`, `packages/db/**` and tests. No C1 route needs it; the calendar-pull scheduler (`jobs/scheduler/calendar-pull.ts`) uses `connectionsDueForPull`.
- **No raw query path from routes:** every tenant read and write goes through `packages/db` repos inside `withTenant(pools, ctx, fn)`, applying `jobScope` / `customerScope` / `propertyScope` / `canSeeJobValue` (`packages/db/src/repos/scope.ts`) for reps.
- **Member names:** `company_members` is a **view** (migration `0002`), not a Drizzle table. Read it with `tx.execute(sql\`select … from company_members …\`)` inside repos, as `routes/team.ts` and `scripts/showcase.ts` do.
- **Capabilities:** routes ask `can(ctx, cap)` / `requireCapability(cap)` from `apps/api/src/permissions.ts` (`TenantContext` has `role` and `canApproveSpend`, so it is a `Member`). Capabilities used by C1: `company_admin` (owner), `view_money_totals` (owner, office). Scheduled work runs as `systemContext(companyId)`.
- **Error bodies:** `{ error: "<plain English>", field? }`. Never a stack trace, a code, a provider message, a token, a phone number or a message body. C1 messages are constants in their own route modules (F3 Ruling 33), not in `errors.ts` `MESSAGES`.
- **Provider calls:** only on the server, through the `CalendarApi` seam (Task 5). Provider error text is never stored, shown or logged; `push_error_plain` stores a reason key (`reconnect`, `unavailable`), and the web turns keys into copy.
- **Secrets:** only from env, read in `config.ts` (`GOOGLE_CLIENT_ID` already exists from F1 sign-in; C1 adds `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`). OAuth refresh tokens are stored only as `encrypt(JSON.stringify({ refreshToken }), config.ENCRYPTION_KEY)` (`packages/db/src/crypto.ts`). Never in a URL we log, never in an error.
- **Validation:** zod 4 through `apps/api/src/validate.ts` (`parse`, `assertKnownFields`, `limitParam`, `offsetParam`, `UUID`, `noNul`, `TOO_LONG`).

**Time (spec §5, Review Focus 2)**
- Instants are `timestamptz` and ISO strings on the wire.
- Calendar days, work hours, "today", "days in stage" and all-day installs use the **company time zone** (`companies.timezone`, default `America/Chicago`), computed with `Intl.DateTimeFormat` — never `Date` local-time methods, never the browser's zone. Use `localDate(now, zone)` / `isTimeZone` from `packages/shared/src/time-zone.ts`.
- Tests cover the DST change days 2026-03-08 and 2026-11-01.

**Pipeline, calendar and quotes (spec, verbatim where quoted)**
- **Stage rules (Decision 2):** Installed only from Won; Lost needs a reason; Won needs a value; same stage is a no-op. Messages: "Mark the job Won first.", "Pick why the job was lost.", "Enter the job value to mark it Won."
- **Inspection auto-move (Decision 3):** booking an inspection on a Lead job moves it to Inspection in the same transaction.
- **Stuck (Decision 4):** Lead/Inspection/Proposal older than `stuck_after_days` (default 14) in the company zone.
- **Availability (Decision 17):** weekly hours per person (company default Mon–Fri 08:00–18:00, Sat 08:00–12:00), 30-minute travel buffer (0 at the same home), 2-hour minimum notice, 30-minute slot grid; `findSlots` is the only slot logic.
- **Conflicts are warnings, never refusals** (Decision 15 area); reps may assign only themselves.
- **Calendar sync (Decisions 19–22):** one connection per person; push per appointment through the `calendar-push` job; pull every 5 minutes with sync cursors; outside events become busy blocks with **times only** (no titles, attendees or locations, next 60 days); last writer wins by `updatedAt`; pull-originated changes never queue a push (Ruling 7) and our own echo is skipped by etag.
- **Event text** (Task 13's `eventInputFor` is the only writer): kind + customer name, the address, and a Roofline link. Never the customer's phone or email.
- **Quotes (Decisions 24–26):** v1 pricebook shape (`pricebookSchema`, `defaultPricebook`, `calculateQuote` in `packages/shared/src/pricing.ts`); single option; final quotes are frozen and never reprice; numbers `Q-0001` per company; "Estimate" on every quote total.
- **No hard-coded prices** (F3 T3's scan fails any `src` file containing `19900` or `39900`); only `defaultPricebook` carries v1's example numbers.
- **CSV export:** formula guard on cells starting with `=`, `+`, `-`, `@`, tab or CR; owner and office only; works in read-only mode.
- **No dock badges, no homeowner texts, no record merge** in C1 (Decisions 12, 27).

**Web (F2/F3 rules apply to every C1 screen)**
- **Strings:** every UI string lives in `apps/web/src/copy/*.ts` (unquoted camelCase keys). No literal text in JSX (Ruling E lint). No raw `<button>`; use `@roofline/ui` (`Button`, `IconButton`, `Field`, `Select`, `Toggle`, `Sheet`, `Pill`, `Avatar`, `EmptyState`, `Skeleton`, `StatCard`, `UiLink`, `useToast`; from F3 T29: `Checkbox`, `Banner`, `ProgressRing`).
- **Banned whole words in copy:** `JSON`, `API`, `sandbox`, `env`, `webhook`, `null`, `undefined`, and every snake_case value of an `as const` array exported by `@roofline/shared` (C1 adds `no_show`, `front_desk`, … — write "No-show", "Front Desk").
- **Vendor names** (`Google`, `Outlook`, `Microsoft`, …) appear only in `copy/connections.ts`, `copy/setup.ts`, `copy/auth.ts`, `copy/billing.ts` and `copy/legal.ts`. Calendar screens import provider words from `copy/connections.ts`.
- **Feature hooks** in `apps/web/src/features/<feature>/api.ts` on F2's `apiFetch`/`ApiError` (`apps/web/src/api/client.ts`); query keys local to the feature; do not edit `api/keys.ts`, `api/hooks.ts` or `api/types.ts` (Task 18 is the only exception, and needs none).
- **Response types** come from `@roofline/shared` (`crm.ts`, Task 4).
- **Windows** render through `AppWindow` (`apps/web/src/shell/AppWindow.tsx`, keyed by `WindowKey`, titles from `WINDOW_COPY` in `copy/dock.ts`); every view has its own URL.
- **Limits:** at least 12px type, WCAG AA contrast, keyboard reachable, 40px touch targets on phone, no horizontal scroll at 375px; state via `data-*` attributes; no third-party UI or calendar library (Decisions 7, 16).

**Tests (spec §13)**
- **No live provider calls in tests or CI.** Google Calendar and Microsoft Graph adapters are tested with recorded JSON through an injected `fetch`; everything else uses `FakeCalendarApi` (`FAKE_PROVIDERS=1`).
- **api/db suites need Docker** (Testcontainers PostGIS): locally run only `npm run typecheck`, `npm run lint` and pure shared/web unit files; prove the rest with `ops/bin/ci-check` (`CI_JOBS="Platform E2E"` for Playwright).
- **API tests** use `makeTestApp()`, `loginAs()`, `TestClock` (`apps/api/test/helpers.ts`), `seedShowcase` (`apps/api/src/scripts/showcase.ts`: lead 8, inspection 7, proposal 6, won 4, installed 2, lost 1), `InlineJobs.sent` / `drain(deps)`; every new route gets a rep test and a company-B test (404).
- **Playwright** runs desktop 1440×900 and phone 375×812 through F2's `apps/web/e2e/stack.ts`, with F2 T18's fixtures (`loginAs`, `clicks`, `markTodaySeen`).
- **Never run `smoke:*` in automation.**

## Review Focus

1. **Reps through the side doors** — board, timeline, appointments, availability, quotes, PDF, export and search; a rep test and a company-B 404 on every new route. (T6–T9, T15–T17)
2. **Time zones** — company zone everywhere, DST days tested. (T2, T3, T8, T9, T23)
3. **Two writers on one appointment** — newer wins, the other leaves an activity line, no push/pull loop. (T13, T14)
4. **Tokens that die** — a revoked refresh token sets the connection to `error` once, stops its pushes and pulls, never blocks saving an appointment. (T12–T14)
5. **Spreadsheet injection** — CSV formula guard. (T4, T17)
6. **Frozen quotes** — a final quote never reprices; its PDF matches its stored numbers. (T15, T16)
