# C1 Task 8 report: Appointments API and Today

Branch c1-t8, commit ded22af (feat(api): C1 appointments api and today).

## Built
- p1-repos: packages/db/src/repos/appointments.ts, today.ts. Scope (reps also see appointments they created), conflict warnings, inspection auto-move, busy blocks, timeline lines, audit rows. AppointmentProblem extended with 'customer' and 'assignee'. Extra exports: memberNames, loadAppointmentRows, appointmentViews, zoneDayStart, zoneDayAfter, AppointmentJoinRow.
- p2-routes: apps/api/src/routes/appointments.ts, today.ts. List/create/get/patch/cancel/complete/no-show; calendar-push sent after commit when pushDue (failure logged, not fatal); today reads zone and stuck_after_days.
- p3-tests: apps/api/test/appointments.test.ts, today.test.ts. Written against the brief, NOT run (no Docker, CI down). First CI run is the real check (rep visibility, DST windows).

## Reviews
- Review 1: 2 findings. F1 amended, F2 approved (fixed).
- Review 2: 1 finding. R2-1 approved (fixed).
- Review 3: 1 finding. R3-1 amended.
(Finding text was not passed to the finalizer; outcomes are from the contact checks.)

## Minors / notes for the controller
- Job timeline shows two lines on the inspection auto-move (updateJob's own line plus the appointment line); suppressing the first needs a jobs.ts change.
- Window-too-long 400 uses field 'to'; calendar-push assertions use the InlineJobs shape with top-level singletonKey.
- GET /:id and the status endpoints return the AppointmentView directly; verify against the web client.
- Busy blocks ignore connection status. Stuck means daysInStage > stuckAfterDays.

## Verify
npm run typecheck (tsc -b): passed, no errors. npm run lint (eslint .): passed, no errors. No fixes were needed.
