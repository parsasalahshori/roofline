### Task 13: Calendar push job

**Base:** `c1-crm` after Tasks 8 and 12 are merged. From T8: `getAppointmentView`, `AppointmentView` rows, the `calendar-push` send on every change. From T12: `getConnection`, `markConnectionError`, `accessTokenFor`. From T5: `JOB_HANDLERS['calendar-push']` → `pushAppointment` (replace the stub), `FakeCalendarApi` helpers. From the API: `systemContext(companyId)` (`permissions.ts`), `JobMeta.lastAttempt`.

Read first: `ops/sdd/c1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-core-crm-design.md`.

**Split:** Builder 1 `calendar/event-text.ts`; Builder 2 `calendar/push.ts` + `repos/calendar-links.ts`; Builder 3 the tests.

**Files:**
- Create: `apps/api/src/calendar/event-text.ts`
- Modify: `apps/api/src/calendar/push.ts` (replace the stub), `packages/db/src/repos/calendar-links.ts`
- Test: `apps/api/test/calendar-push.test.ts`

**Interfaces:**
```ts
// calendar/event-text.ts — the only place event text is written (no customer phone or email, spec §5.4)
export function eventInputFor(a: AppointmentView, o: { jobUrl: string | null; timeZone: string }): ExternalEventInput;   // title "Inspection — Maria Lopez" (kind label + customer, or the title), location = address, description = "Open in Roofline: <jobUrl>"
// repos/calendar-links.ts
export async function getEventLink(tx: Tx, ctx: TenantContext, appointmentId: string): Promise<(typeof calendarEventLinks.$inferSelect) | null>;
export async function saveEventLink(tx: Tx, ctx: TenantContext, l: { appointmentId: string; connectionId: string; providerEventId: string; etag: string | null }, now: Date): Promise<void>;
export async function setPushError(tx: Tx, ctx: TenantContext, appointmentId: string, errorPlain: string | null): Promise<void>;
export async function deleteEventLink(tx: Tx, ctx: TenantContext, appointmentId: string): Promise<void>;
// calendar/push.ts
export async function pushAppointment(deps: AppDeps, companyId: string, appointmentId: string, meta: JobMeta): Promise<void>;
```
- **`pushAppointment`** (ctx = `systemContext(companyId)`):
  1. Read the appointment (any status), its link, the assignee's connection (status `connected`).
  2. **Link on another connection** (reassigned, or the assignee disconnected) → delete the old event (old connection's token) and the link.
  3. **Canceled/archived or no assignee/connection** → delete the event if linked; done.
  4. **No link** → `createEvent`; save the link.
  5. **Linked** → `updateEvent(etag)`: `{etag}` → save; `'gone'` → create a new event and relink; `'conflict'` → `getEvent`, and if the external `updatedAt` > the appointment's `updated_at`, leave it (the pull applies it), else retry the update once without `If-Match`.
  6. Provider calls happen **outside** any transaction; each DB write is its own short `withTenant`.
  7. `CalendarAuthError` → connection `error` (Task 12's `accessTokenFor` does it) and `setPushError(appointmentId, 'reconnect')` (a reason key; the UI words come from copy), no rethrow. `CalendarUnavailableError` → rethrow (pg-boss retries); on `meta.lastAttempt` store `push_error_plain = 'unavailable'` first.
- **Loop guard:** after a successful create/update, store the returned etag; Task 14 skips events whose etag equals the stored one.

**Tests:**
- (`makeTestApp`, connect Sam with the fake, create appointments through the API, `await t.jobs.drain(t.deps)`): create → one fake event with the expected title/location and no phone/email in any field; move → the same event updated; cancel → deleted and link gone; reassign Sam → Pat (both connected) → removed from Sam's, created on Pat's; assignee without a connection → nothing; `revoke` → connection `error`, appointment `sync 'failed'`, no throw; `failNext(5)` → 5 attempts then `failed`; a 412 conflict where the external change is newer → no overwrite.

**Carries and rulings:**
- Provider calls happen outside transactions; each DB write is its own short `withTenant` (plan step 6).

**Verify notes:**
- CI.
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint` plus focused pure tests; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(calendar): push appointments to each person's calendar`
