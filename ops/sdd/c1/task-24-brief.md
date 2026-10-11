### Task 24: Web: appointment sheet with suggested times

**Base:** `c1-crm` after Task 18 is merged (T8 and T9 for the real API). From T18: placeholders `features/appointments/{AppointmentWindow,api}`, `copy/appointments.ts`. From T3: `DEFAULT_DURATION_MINUTES`. From T4: `AppointmentView`. Kit `Banner` from F3 T29. Provider words for the sync line come from `copy/connections.ts` (import, do not add vendor words elsewhere).

Read first: `ops/sdd/c1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-core-crm-design.md`.

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

**Tests:**
- prefill from `?jobId=&kind=inspection`; suggestions fill the fields; save posts the right body (ISO instants from company-zone input); warnings banner; job-moved toast; install shows a date range and posts all-day; detail actions post; a rep cannot pick another person.

**Carries and rulings:**
- Click budget: job window → Book inspection → first suggestion → Save = 3 clicks (asserted in T28).

**Verify notes:**
- web suite, lint, typecheck, build.
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); still confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(web): appointment form with suggested times, warnings and quick actions`
