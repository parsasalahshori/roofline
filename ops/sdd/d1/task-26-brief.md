### Task 26: Web: timelines, Today, appointments, dock badge

**Base:** `d1-front-desk` after Task 20 is merged. **[C1]** `features/timeline/Timeline.tsx` (C1 T19), `features/appointments/AppointmentDetail.tsx` (C1 T24), `features/today/{Today.tsx,api.ts}` (C1 T27). From T20: the Front Desk dock badge hook.

Read first: `ops/sdd/d1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-front-desk-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** come from those plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`, `ops/sdd/s1/`), not from built code: check each against `c1-crm`/`e1-estimator`/`s1-storm` before starting and report any difference.

**Split:** Builder 1 call/text cards in C1's customer and job timelines (summary, outcome, link to the conversation); Builder 2 "Booked by Front Desk" on appointments and confirmed marks; Builder 3 Today follow-up rendering for Front Desk items + the dock badge (unread conversations needing attention) + tests.

**Files:** Modify **[C1]** `apps/web/src/features/timeline/Timeline.tsx` (link for Front Desk activities — Ruling DG), **[C1]** `apps/web/src/features/appointments/AppointmentDetail.tsx` ("Booked by Front Desk"), **[C1]** `apps/web/src/features/today/*` (item kind), `apps/web/src/features/front-desk/api.ts` (`useFrontDeskUnread`, Ruling DH).

**Carries and rulings:**
- **Ruling DG:** the timeline shows Front Desk activities with a link to `/front-desk/:conversationId`; no new item type. **Ruling DH:** fill `useFrontDeskUnread()`.

**Verify notes:**
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(web): Front Desk calls and bookings across timelines, the calendar and Today`
