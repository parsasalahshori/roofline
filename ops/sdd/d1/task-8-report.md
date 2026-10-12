# D1 Task 8: Front Desk tools (inspection times, book, confirm, move, cancel)

Branch `d1-t8` (from `d1-front-desk` 4ce5c7f). Handlers are plain `ToolHandler`s; Task 19 owns `tools/index.ts` and the tool list.

## What changed, per part

- `apps/api/src/front-desk/tools/times.ts`: `findInspectionTimes` and the pieces the other tools share.
  `openInspectionSlots` runs C1's `findSlots` for every inspector (`bookableMembers('inspection')`, fresh `busyFor`,
  `memberHours`, `scheduleSettings`) and merges by start; `pickOffers` gives at most 6, one per day and part of day first;
  `alternativeOptions` gives the next two; `locateForBooking` geocodes outside any transaction and checks `companies.service_area`
  (a company with no area drawn has no limit); `queueCalendarPush`; `verifiedCustomerId`. Same-home buffer through `propertyId`.
  10 days ahead, 60-minute inspections (`DEFAULT_DURATION_MINUTES.inspection`).
- `apps/api/src/front-desk/tools/book.ts`: `bookInspection`. One `withTenant` transaction: key lock, then inspector lock
  (`pg_advisory_xact_lock`); replay check; slot re-check with `findSlots` on fresh data before anything is written (a taken slot
  writes nothing and returns the next two); customer (new, or the one already known, or the one active customer on the number),
  consent `express` source `call` (`recordCallConsent`, only for a customer with none), property, Lead job (`createJob`, source
  `front_desk`; an open job at that home is reused), appointment (`createAppointment`, source `front_desk`, so the inspection
  auto-move happens). Idempotency key = conversation id + slot start, kept as an activity (`appointment.front_desk_booked`,
  "Booked by Front Desk") on the job, so there is no new table. After commit: the `calendar-push` job and the confirmation
  text through the gate (`buildGateRequest`, `textStateFor`, `insertAssistantText`, `sendQueuedText`); a blocked or failed
  text is recorded or logged and the booking stands. Outside the area, unknown address and a map outage return message suggestions.
- `apps/api/src/front-desk/tools/confirm.ts`: `confirmAppointmentTool` (any kind, verified caller only, `confirmed_via`
  `call` or `text` by channel) and `confirmByText` / `isConfirmShortcut` for Task 14.
- `apps/api/src/front-desk/tools/move.ts`: `moveInspection` and `cancelInspection` (inspections only, behind the
  `frontDeskCanMove` / `frontDeskCanCancel` switches, verified caller only, own appointment only; installs and other kinds
  refused with a message suggestion; move clears the confirmation and ignores the visit's own busy time; both queue the C1 calendar push).
- Predicates for Task 19: `isAvailable(settings)` in times.ts, book.ts, confirm.ts (always true); `isMoveAvailable(settings)` and
  `isCancelAvailable(settings)` in move.ts. They take `{ canMove, canCancel }` (the shape of `CompanyBlockInput`).
- `packages/db/src/repos/fd-booking.ts` (new, already exported from the repos index): locks, idempotency lookup and record,
  `inServiceArea`, `resolveBookingCustomer`, `findPropertyByAddress`, `findOpenJobAt`, `getFdAppointment`, `upcomingForCustomer`,
  `confirmAppointment`, `clearConfirmation`.
- `texts.ts`: the `TODO(Task 8)` is wired. A "C" / "confirm" text from a customer's own number is answered by `confirmByText`
  and the engine is not asked ("Thanks, your inspection on Wed Oct 14, 10:00 AM is confirmed." / "... is already confirmed." /
  "I don't see a visit to confirm for this number. Call us and we will sort it out."). `texts.test.ts` TODO case updated to the
  real reply, plus a case with a real appointment.
- Ruling DY item 2: `AppointmentView` (packages/shared/src/crm.ts) gains `confirmedAt: string | null` and
  `confirmedVia: 'call' | 'text' | 'manual' | null`, filled in `appointmentViews` (packages/db/src/repos/appointments.ts).
  The web needed no code change; seven test fixtures (six web, one api) gained the two fields.

## [C1] name check against the real code

All the brief's names exist, with these differences:
- `findSlots`, `DEFAULT_DURATION_MINUTES`, `Interval`, `BusyItem` live in `packages/shared/src/availability.ts` (not db). `busyFor`
  (returns `Map<userId, BusyItem[]>`) and `bookableMembers` are in `repos/schedules.ts`, next to `memberHours` and `scheduleSettings`,
  which per-inspector availability also needs.
- `createAppointment`, `updateAppointment` and `setAppointmentStatus` do not send the calendar push. They return `pushDue`, and
  the caller queues `calendar-push` after commit (`routes/appointments.ts` `queuePush`, which is private). `queueCalendarPush` in
  times.ts repeats it (singletonKey = appointment id, queue errors logged and dropped).
- `createCustomer` records consent as source `manual`; the `call` source comes from D1's `recordCallConsent`
  (fd-text-back.ts), which also only upgrades a customer with no consent.
- `createJob(tx, ctx, input, { now })` and `createProperty(tx, ctx, input, { now })` match; `createProperty` takes
  `location: [lng, lat]`. `JOB_SOURCES` already has `front_desk`.

## Tests

`apps/api/test/front-desk/tools-booking.test.ts` (database-backed; CI runs it): slots by part of day, inside work hours, after the
notice, within 10 days, at most 6; no Sunday times; other-home buffer vs same-home no buffer (`propertyId`); address-only
geocode, outside the area, unknown address, map outage; full booking (customer, call consent, home, Lead job moved to Inspection,
`front_desk` appointment, calendar push, confirmation text through the gate); slot taken meanwhile returns the next two and
writes nothing; every inspector busy; same key returns the same appointment (also two at once); a second slot reuses customer,
home and job; two callers on one inspector and time; reuse of a known caller and open job; gate-blocked text recorded and
booking stands; failed send; name required; shared number; non-inspector; home on file for someone else; confirm (call, text,
twice, unverified, other customer, view fields `confirmedAt` / `confirmedVia`); the C / confirm helper (which texts count, one
visit at a time, none, canceled / past / other customer); move (own, clears confirmation, own time not blocked, taken returns the
next two, unverified, install refused with `take_message`, other customer, switch off); cancel (reason on timeline, push,
unverified, install, switch off, twice); the predicates. `texts.test.ts`: the C / confirm cases.
These suites need Docker, so they were not run locally; `npm run typecheck` and `npm run lint` pass.

## Migration

None. `confirmed_at` / `confirmed_via` already exist in 0019 and are covered by the table-wide grants (0020 section 3).
`drizzle-kit generate` from `packages/db` reports "No schema changes, nothing to migrate".

## CI

See the final line below (filled in after the run).
