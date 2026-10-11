### Task 9: Schedule settings and availability

**Base:** `c1-crm` after Tasks 1, 3, 4 and 5 are merged. From T3: `WorkHoursSchema`, `DEFAULT_WORK_HOURS`, `DEFAULT_DURATION_MINUTES`, `MAX_AVAILABILITY_DAYS`, `findSlots`, `BusyItem`. From T4: `ScheduleSettings`, `MemberRef`. From T5: stubs `routes/calendar.ts` (`calendarRoutes`, mounted at `/api/calendar` beside `calendarConnectRoutes`). From F1: `requireCapability('company_admin')`, `audit`, `company_members` view, `companies.timezone`.

Read first: `ops/sdd/c1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-core-crm-design.md`.

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

**Tests:**
- settings round-trip and validation messages; office can't PUT company settings (403) but can PUT its own hours; availability with a seeded 10:00 appointment at another home (buffer respected) and a busy block; a rep asking for another member → 403; union across two reps with `userIds`; DST Sunday 2026-11-01 Monday after; minimum notice from the test clock; company B 404 for its member id.

**Carries and rulings:**
- Keep paths disjoint from T12: this file owns `/settings`, `/my-hours`, `/hours/:userId`, `/availability` under `/api/calendar`.

**Verify notes:**
- CI.
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint` plus focused pure tests; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(calendar): work hours, travel buffer, minimum notice and suggested times`
