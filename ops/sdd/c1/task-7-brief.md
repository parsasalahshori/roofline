### Task 7: Customers: view, timeline, notes, server geocoding

**Base:** `c1-crm` after Tasks 1, 4 and 5 are merged; F3 **Task 14** (Geocodio geocoder; `FakeGeocoder.failNext`) must be in `f3-setup`. From F1: `repos/customers.ts` (`getCustomer`, `CONSENT_LABELS`), `repos/properties.ts` (`createProperty`, `updateProperty`, `getProperty`; add `setPropertyLocation` only if absent), `repos/activities.ts` (`addActivity`, `listActivities`; `activities.actor_agent`), `customerScope`/`propertyScope`/`jobScope`, `messages` (tenant table: `customer_id`, `step_id`, `direction`, `status`, `body`). From the API: `routes/{customers,properties}.ts`, `deps.geocoder` (`Geocoder`, `GeocoderUnavailableError`), `isTimeZone`. From T4: `CustomerView`, `HomeSummary`, `TimelineItem`, `TimelinePage`. From T5: placeholder `listAppointmentsForCustomer`; stubs `routes/{timeline,notes}.ts` mounted at `/api/timeline`, `/api/notes`.

Read first: `ops/sdd/c1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-core-crm-design.md`.

**Split:**
- Builder 1: `packages/db/src/repos/timeline.ts` and `packages/db/src/repos/notes.ts`, `routes/timeline.ts`, `routes/notes.ts`.
- Builder 2: `routes/customers.ts` (`/:id/view`) and `routes/properties.ts` (server geocoding, `/:id/locate`).
- Builder 3: the tests.

**Files:**
- Modify: `packages/db/src/repos/{timeline,notes}.ts`, `apps/api/src/routes/{customers,properties,timeline,notes}.ts`
- Test: `apps/api/test/{customer-view,timeline,notes,property-geocode}.test.ts`
- Do not touch: `repos/customers.ts` and `repos/properties.ts` internals beyond adding a `setPropertyLocation` (if absent) in `properties.ts`.

**Interfaces:**
```ts
// repos/timeline.ts
export type TimelineQuery = { customerId?: string; jobId?: string; before?: Date; limit?: number };   // exactly one of customerId/jobId
export async function timelinePage(tx: Tx, ctx: TenantContext, q: TimelineQuery): Promise<TimelinePage>;
// repos/notes.ts
export const NOTE_MAX = 2000;
export async function addNote(tx: Tx, ctx: TenantContext, n: { subjectType: 'customer' | 'job'; subjectId: string; body: string }, now: Date): Promise<TimelineItem>;
```
- **Timeline merge:** for a customer — activities whose subject is the customer, any of its properties, any of its jobs (scoped by `jobScope` for reps), plus `messages` with `customer_id` = it; for a job — the job's activities, its property's, and messages whose `step_id` belongs to a task with `subject_id` = the job **or** whose customer is the job's customer and `created_at` ≥ the job's `created_at` (texts about the job). One `UNION ALL` ordered by `at desc, id desc`, `limit + 1` to compute `nextBefore` (the last item's `at` ISO). Actor names from `company_members`; agent names from `AGENT_LABEL`-equivalent server map (`activities.actor_agent` as stored). Activity `kind = 'note'` items carry the note body as `summary`.
- **`POST /api/notes`** `{ subjectType, subjectId, body }`: the subject must be visible (404); `body` trimmed 1–2000 → else 400 field `body` "Write a note, up to 2,000 characters."; inserts an activity `kind 'note'`, `summary = body`; returns the `TimelineItem` (201). Allowed for anyone who can see the subject.
- **`GET /api/timeline?customerId=|jobId=&before=&limit=`** → `TimelinePage`; neither or both → 400.
- **`GET /api/customers/:id/view`** → `CustomerView`: homes with their jobs (scoped), jobs as `JobCard`s, `upcoming` = next 5 scheduled appointments (`listAppointmentsForCustomer`, Task 5's placeholder until Task 8, Ruling 4), `can.changeConsent` = owner or office.
- **Server geocoding (`routes/properties.ts`):** `POST /api/properties` without `lat`/`lng` geocodes `"line, city, ST zip"` with `deps.geocoder` **before** the insert (outside the transaction): located → `location`, and `timezone` when `isTimeZone`; not found or unavailable → saved without a point. `POST /api/properties/:id/locate` (anyone who can edit it) re-tries: 200 `{ located: true }`, 400 field `addressLine` "We couldn't find that address. Check the street, city and state.", 503 "We couldn't reach the map service. Try again in a minute."

**Tests:**
- `customer-view.test.ts` (homes and jobs, rep scope, B → 404); `timeline.test.ts` (a stage move, a note and an inbound text appear newest first; paging with `before`; a rep doesn't see activities of a job they can't see on a shared customer); `notes.test.ts` (2001 characters → 400; out-of-scope subject → 404); `property-geocode.test.ts` (`'1200 Farnam St'` with the fake → `geom` set and `timezone 'America/Chicago'`; `'1 Nowhere Rd'` → saved, no point; `locate` 200/400/503 with `t.geocoder.failNext`).

**Carries and rulings:**
- Geocoding happens **outside** the transaction (Ruling in plan: provider calls never inside `withTenant`).

**Verify notes:**
- CI.
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint` plus focused pure tests; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(crm): customer view, merged timeline, notes and server-side geocoding for new homes`
