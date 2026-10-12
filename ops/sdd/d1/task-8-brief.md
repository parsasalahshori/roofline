### Task 8: Tools — inspection times, book, confirm, move, cancel

**Base:** `d1-front-desk` after Tasks 3 and 4 are merged. **[C1]** C1 T3 `findSlots`, `DEFAULT_DURATION_MINUTES`; C1 T9 `busyFor`, `bookableMembers`; C1 T8 `createAppointment`, `updateAppointment`, `setAppointmentStatus` (and its `calendar-push` send); C1 T6 `createJob`. Real: F1 `createCustomer`, `createProperty`; `deps.geocoder`; `companies.service_area`.

Read first: `ops/sdd/d1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-front-desk-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** come from those plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`, `ops/sdd/s1/`), not from built code: check each against `c1-crm`/`e1-estimator`/`s1-storm` before starting and report any difference.

**Split:** Builder 1 `tools/times.ts` (C1 availability union for inspectors, next 10 days, ≤ 6 slots, by part of day, same-home buffer via `propertyId`; address-only → geocode first (service-area check)); Builder 2 `repos/fd-booking.ts` + `tools/book.ts` (one transaction: customer, consent `express` source `call`, property, Lead job, appointment `front_desk`; slot re-check with `findSlots` on fresh busy data under an advisory lock per inspector; idempotency key conversation + slot; C1 calendar push job; confirmation text via the gate after commit); Builder 3 `tools/{confirm,move}.ts` (`confirm_appointment` any kind for the verified caller; `move_inspection`/`cancel_inspection` inspections only, settings switches, C1 calendar push) + "C"/"confirm" text handling helper for Task 14 + tests.

**Files:** Fill the listed files; Test `apps/api/test/front-desk/tools-booking.test.ts`.

**Tests:**
- slots respect work hours, buffers and notice; booking a slot taken meanwhile → result offers the next two; same idempotency key → same appointment; outside service area → message suggestion; unverified caller can't move/cancel; install → refused with message suggestion; settings off → tools absent from the tool list; confirmation text blocked by the gate is recorded, booking still stands.

**Carries and rulings:**
- Bookings go through **[C1]** `createAppointment` so the inspection auto-move and calendar push happen as in C1.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): Front Desk books, confirms and moves inspections against the calendar`
