### Task 14: Calendar pull schedule

**Base:** `c1-crm` after Tasks 8 and 12 are merged (Task 13 runs beside it; `linkByEventId` reads `calendar_event_links` directly and does not import T13's `calendar-links.ts`). From T8: `updateAppointment(..., { origin: 'pull', activitySummary })`, `setAppointmentStatus`. From T12: `accessTokenFor`, `markConnectionError`, `CalendarConnectionRow`, the `POST /api/calendar/sync` stub body in `routes/calendar-connect.ts` (this task fills it). From T5: `SCHEDULES` entry `calendar-pull` → `pullCalendars` (replace the stub). From F1: the system pool (`deps.pools.system`) for the fan-out only.

Read first: `ops/sdd/c1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-core-crm-design.md`.

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

**Tests:**
- an external move of a linked event → the appointment moves with the activity; external delete → canceled; an outside event → one busy block with no title stored (assert the table has no text column but times) and it blocks availability (Task 9 route); a transparent event → no block; our own push echo is skipped (no activity); cursor expiry → full resync replaces blocks; a revoked token → connection `error`, the tick continues with other connections; the 5-minute due rule; company isolation of the fan-out.

**Carries and rulings:**
- **Ruling 8:** provider words in server activity text come from `PROVIDER_WORD` in `calendar/pull.ts`.

**Verify notes:**
- CI.
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint` plus focused pure tests; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(calendar): pull calendar changes every five minutes; busy times without details`
