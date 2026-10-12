### Task 21: YES replies, results and the storms API

**Base:** `s1-storm` after Tasks 9 and 11 are merged. Real (F3): `hooks/twilio.ts` `/sms` (STOP/HELP/START first; the inbound insert is the claim). **[C1]** appointments (`kind 'inspection'`, C1 T1/T8) for "inspections booked"; `jobs.next_step` for Today follow-ups.

Read first: `ops/sdd/s1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-storm-scout-design.md`. Names marked **[C1]** / **[E1]** come from the C1/E1 plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`), not from built code: check each against `c1-crm`/`e1-estimator` before starting and report any difference.

**Split:** Builder 1 `storm/replies.ts` + the one call in `hooks/twilio.ts` after the inbound message is stored (`await onStormReply(tx, message)` — only when not a STOP/HELP keyword): newest storm text to this customer within 14 days and `isYesReply` → create or advance (to `lead` if earlier) the customer's open job with `storm_id`, Today follow-up "Maria replied YES to the storm text", once per storm per customer; Builder 2 `repos/storm-results.ts` + `storm/results.ts` (texts sent/delivered/replies/yes from `messages` by step; emails sent/unsubscribes; doors knocked/wants check; ads spend/max/clicks/landing requests; inspections booked = C1 appointments of kind inspection on jobs with the storm id created after the plan ran); Builder 3 `routes/storms.ts` (`GET /api/storms`, `GET /api/storms/:id`, `POST /:id/dismiss`, `POST /:id/plan`) and tests.

**Interfaces:** `GET /api/storms?since=` → `{ storms: { id, placeName, day, maxIn, status, customersHit, homesHit, planTaskId, planStatus }[] }`; `GET /api/storms/:id` → `{ storm, swath: FeatureCollection, results, plan: { taskId, status } | null }`; dismiss owner/office; `POST /plan` owner/office → `{ taskId }` (re-draft only when no plan or expired).

**Tests:**
- YES → job with storm id; second YES no duplicate; YES to an old storm (> 14 days) ignored; STOP never treated as YES; results numbers from seeded data; cross-tenant 404s on every route; reps can list storms but not dismiss.

**Carries and rulings:**
- `hooks/twilio.ts`: one call added, after STOP/HELP/START and the inbound claim.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): storm results, YES replies as leads, and the storms API`
