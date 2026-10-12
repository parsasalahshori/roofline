### Task 13: After the call — summary, outcome, metering, text-back, timeline

**Base:** `d1-front-desk` after Tasks 5 and 11 are merged. Real (F3): `usage_events` and the `ai_call_minute` meter (`repos/usage.ts`, `USAGE_KINDS`), the send gate path for informational texts (`messaging/outbound.ts`, `gate-request.ts`). From T2: `shouldTextBack`.

Read first: `ops/sdd/d1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-front-desk-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** come from those plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`, `ops/sdd/s1/`), not from built code: check each against `c1-crm`/`e1-estimator`/`s1-storm` before starting and report any difference.

**Split:** Builder 1 `after-call.ts` (`fd-after-call` job: transcript → Haiku summary (skipped text when transcript not stored: summary from actions only), outcome (actions win over the model: booked > moved > confirmed > claim > transferred > message), conversation and call close, activity on the customer/job timeline, `ai_call_minute` usage event unique on call id with `ceil(ai_seconds/60)`); Builder 2 `text-back.ts` + `providers/twilio/lookup.ts` + `system/line-lookups.ts` (cache 90 days; `shouldTextBack`; gate informational with consent `express` source `call` recorded for the caller; once per number per 24 h); Builder 3 tests.

**Files:** Fill the listed files; Test `apps/api/test/front-desk/after-call.test.ts`.

**Tests:**
- summary saved; outcome precedence; one usage event even if the job runs twice; spam calls bill AI seconds only; text-back table cases end-to-end through the gate (blocked by quiet hours → scheduled); lookup cached; timeline card created.

**Carries and rulings:**
- **Ruling DG:** the after-call job writes a timeline **activity** (`kind 'call'` or `'text_conversation'`, summary text, subject the customer/job) with `addActivity`, so C1's `TimelineItem` type needs no new variant.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): after each call — summary, outcome, AI minutes, timeline and missed-call text-back`
