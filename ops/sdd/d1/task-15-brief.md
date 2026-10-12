### Task 15: Spam

**Base:** `d1-front-desk` after Task 10 is merged. From T10: the `screenCall` call site in `hooks/twilio-voice.ts`. From T4: `CallScreen` stub.

Read first: `ops/sdd/d1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-front-desk-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** come from those plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`, `ops/sdd/s1/`), not from built code: check each against `c1-crm`/`e1-estimator`/`s1-storm` before starting and report any difference.

**Split:** Builder 1 `providers/call-screen.ts` real rules (spec Decision 13) + `repos/blocked-numbers.ts` + calls-per-hour count; Builder 2 router intents `spam`/`sales_pitch` → engine `end_call` path + conversation outcome `spam`; Builder 3 `POST /api/calls/:id/spam` (block number, outcome spam) + `DELETE /api/blocked-numbers/:id` + tests.

**Files:** Fill the listed files; Modify `apps/api/src/hooks/twilio-voice.ts` only to pass real inputs to `screenCall` (Task 10 left the call site); Test `apps/api/test/front-desk/spam.test.ts`.

**Tests:**
- rule table; blocked number rejected before the relay (no AI seconds); known customers never auto-rejected by STIR rules; sales pitch ends politely; mark/unmark spam; text-back never to spam.

**Carries and rulings:**
- Known customers are never auto-rejected by STIR rules.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): spam calls — STIR/SHAKEN, the company blocklist and polite endings`
