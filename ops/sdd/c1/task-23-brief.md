### Task 23: Web: calendar views

**Base:** `c1-crm` after Tasks 3 and 18 are merged (T8's `GET /api/appointments?…&withBusy=true` for the real API). From T18: placeholders `features/calendar/{CalendarWindow,api}`, `copy/calendar.ts`. From T4: `AppointmentView`. From F2: `useCompany` (`features/settings/api.ts`) for `timezone`, `useIsPhone`, `GET /api/team`.

Read first: `ops/sdd/c1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-core-crm-design.md`.

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

**Tests:**
- week renders appointments at the right rows for Chicago while the test's `TZ` is `UTC` (set `process.env.TZ` in the test file); all-day install spans the row; busy blocks show "Busy"; empty-slot click URL; people picker updates the request; agenda on phone; DST week of 2026-11-01 positions.

**Carries and rulings:**
- Set `process.env.TZ = 'UTC'` at the top of the test file; all positioning goes through `time.ts` with the company zone.

**Verify notes:**
- web suite, lint, typecheck, build.
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); still confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(web): calendar week, day and agenda views in the company time zone`
