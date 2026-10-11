### Task 3: Shared availability model

**Base:** `c1-crm` after Task 1 is merged. Task 1 wrote the constants at the top of `packages/shared/src/availability.ts` (`APPOINTMENT_KINDS`, `APPOINTMENT_STATUSES`, `APPOINTMENT_SOURCES`, `CALENDAR_PROVIDERS`, `CALENDAR_CONNECTION_STATUSES`, `QUOTE_STATUSES` and types); add everything below them. zod 4 is already a shared dependency. From F1 `time-zone.ts`: `localDate`.

Read first: `ops/sdd/c1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-core-crm-design.md`.

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

**Tests:**
- default hours parse; overlapping ranges, `'25:00'` and 4 ranges in a day are refused naming the day; a free Monday in Chicago gives 08:00–17:00 starts for 60 minutes (19 slots); a 10:00–11:00 busy item at another home blocks 09:30–11:30 with a 30-minute buffer (so 09:00 is not offered for 60 minutes, 11:30 is); the same home needs no buffer (11:00 offered); minimum notice of 120 minutes at 08:15 → first slot 10:30; an all-day busy item blocks the day; Sunday gives none; the 2026-03-08 and 2026-11-01 DST days give correct UTC instants; `from`/`to` clipping.

**Carries and rulings:**
- `findSlots` is the only slot logic in C1 (T9 and the web suggestions call the API); D1 will call it too, so keep the signature exactly.

**Verify notes:**
- `npx vitest run --project @roofline/shared availability` → PASS.
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); still confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(shared): work hours and the slot finder`
