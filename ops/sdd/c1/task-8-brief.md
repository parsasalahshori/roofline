### Task 8: Appointments API and Today

**Base:** `c1-crm` after Tasks 1, 3, 4 and 5 are merged (Task 6 runs beside it in another group; this task calls `updateJob` from F1's `repos/jobs.ts` for the auto-move — T6 adds the stage rules inside it, so merge T6 first or keep the call signature-only). From T5: the placeholder bodies in `repos/appointments.ts` (replace them, keep signatures), stubs `routes/{appointments,today}.ts`, `JOB_NAMES` `'calendar-push'`, `JobData.appointmentId`. From T3: `DEFAULT_DURATION_MINUTES`. From T4: `AppointmentView`, `TodayView`, `JobCard`. From F1: `jobScope`, `addActivity`, `audit`, `company_members` view; `deps.jobs.send(name, data, { singletonKey })`.

Read first: `ops/sdd/c1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-core-crm-design.md`.

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

**Tests:**
- `appointments.test.ts` — create/move/cancel/complete/no-show with activities and audit; the inspection auto-move (and none for a job already in proposal); link mismatch 400s; install all-day midnight snapping in Chicago; conflict warnings (overlap, busy block) but 201; rep visibility (own + their jobs; not another rep's on a hidden job) and rep can't assign others; `calendar-push` sent once per change (`t.jobs.sent`); window > 62 days → 400; company B 404. `today.test.ts` — today's appointments only, follow-ups due today and overdue, DST day.

**Carries and rulings:**
- **Ruling 7:** `updateAppointment`/`setAppointmentStatus` accept `{ origin: 'pull' }` and then queue no push; T14 passes it.
- **Ruling 6:** `withBusy=true` returns `{ appointments, busy }` in one response.
- Replace T5's placeholder bodies without changing their signatures (T6/T7 already call them).

**Verify notes:**
- CI.
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint` plus focused pure tests; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(calendar): appointments with conflict warnings, the inspection auto-move, and today's view`
