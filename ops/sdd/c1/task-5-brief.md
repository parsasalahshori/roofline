### Task 5: API skeleton: calendar seam, config, queues, mounts

**Base:** `c1-crm` after Task 1 is merged (Task 4's `crm.ts` types are needed for the placeholder signatures — merge T4 first or stack on it). Current API shapes (`origin/f3-setup`): `apps/api/src/config.ts` (zod schema; `GOOGLE_CLIENT_ID` optional already, `FAKE_PROVIDERS` flag refused in production, `PUBLIC_BASE_URL`, `APP_ORIGIN`, `ENCRYPTION_KEY`), `deps.ts` (`AppDeps`, `buildDeps`; `logError`), `app.ts` (mount order; `/api/weather` exists), `jobs/queue.ts` (`JOB_NAMES = ['import-customers','texting-registration']` at 7b988eb plus whatever F3 adds, `JobData = { companyId; importId? }`, `JobMeta`, `InlineJobs.sent`/`drain`), `jobs/handlers.ts` (`JOB_HANDLERS`), `jobs/worker.ts` (`SCHEDULES: readonly ScheduledJob[]`), `test/helpers.ts` (`TestApp`, `makeTestApp`, `testConfig`, `TEST_ENCRYPTION_KEY`), the provider-factory pattern of `providers/geocoder.ts` + `geocodio.ts` (`createGeocoder`, `geocodioFor`).

Read first: `ops/sdd/c1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-core-crm-design.md`.

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

**Tests:**
- `config.test.ts` (Microsoft pair rule; Google secret needs the id); `calendar-fake.test.ts` (the fake reports every change, its own writes included — Task 14 filters linked events by etag: create then sync shows the event; `externalMove` shows in the next sync with a newer `updatedAt`; `externalDelete` shows `cancelled`; `expireCursor` gives `fullResync`; `revoke` makes later calls throw `CalendarAuthError`); `jobs.test.ts` (`SCHEDULES` has `calendar-pull` `*/5 * * * *`; `JOB_NAMES` includes `calendar-push`); `buildDeps` with `FAKE_PROVIDERS=1` gives fakes, without it `configured === false`.

**Carries and rulings:**
- **Ruling 4:** create `listAppointmentsForJob`, `listAppointmentsForCustomer` (`repos/appointments.ts`) and `listQuoteSummaries` (`repos/quotes.ts`) with final signatures returning `[]`; T8 and T15 replace the bodies.
- Append `'calendar-push'` to whatever `JOB_NAMES` holds when F3 finishes (F3 briefs 14–37 add none).
- Mount `/api/jobs/:jobId/quotes` **before** `/api/jobs` (Express matches in order).
- This task owns `app.ts`, `config.ts`, `deps.ts`, `jobs/{queue,handlers,worker}.ts`, `test/helpers.ts`, `.env.example` and the README env table for all of C1 (Ruling 3).

**Verify notes:**
- typecheck and lint locally; CI via `ops/bin/ci-check`.
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint` plus focused pure tests; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): C1 skeleton — calendar seam with a fake, config, calendar-push queue, calendar-pull schedule, route stubs`
