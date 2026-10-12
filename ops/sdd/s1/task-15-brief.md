### Task 15: Door outcomes API and leads from doors

**Base:** `s1-storm` after Task 14 is merged. **[C1]** customer/property/Lead job creation: F1 `createCustomer`/`createProperty` and C1 T6's `createJob` (stage rules); Today follow-ups are C1's `jobs.next_step`/`next_step_on` (C1 T1/T6).

Read first: `ops/sdd/s1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-storm-scout-design.md`. Names marked **[C1]** / **[E1]** come from the C1/E1 plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`), not from built code: check each against `c1-crm`/`e1-estimator` before starting and report any difference.

**Split:** Builder 1 `routes/door-routes.ts` (`GET /api/routes/mine`, `GET /api/routes/:id` (assignee, owner, office), `POST /api/routes/:id/stops/:stopId/outcome`); Builder 2 `storm/doors.ts` (wants_check → C1's customer/property/job creation in one transaction: consent `express` with source `door` and evidence `{ by, at, text }` when the box is ticked; job source `storm`, `storm_id`, assigned to the rep; Today follow-up; do_not_knock → exclusion); Builder 3 tests.

**Files:** Fill the listed files; Modify `packages/db/src/repos/door-routes.ts` (outcome update); Test `apps/api/test/doors.test.ts`.
- **Interfaces:** body `{ outcome: DoorOutcome; lead?: { name: string; phoneE164?: string; email?: string; okToText: boolean; note?: string } }` (zod; `lead` required for `wants_check`); 200 `{ stop, createdJobId? }`; a rep can't record on another rep's route (403 `'This route belongs to someone else.'`); route status moves to `in_progress` then `done` when every stop has an outcome. `CONSENT_SOURCES` gains `'door'` and `'web_form'` if absent (Task 1 constant; this task only uses them).

**Tests:**
- each outcome; lead creation idempotent per stop; consent only when ticked; cross-tenant 404; route done.

**Carries and rulings:**
- Lead creation idempotent per stop.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): reps record door outcomes and create storm leads`
