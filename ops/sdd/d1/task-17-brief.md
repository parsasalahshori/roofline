### Task 17: Number voice setup and the forwarding test

**Base:** `d1-front-desk` after Task 4 is merged. Real (F3): `providers/registrar.ts` (`ensureNumber` already buys numbers with `voice` capability; `company_phone_numbers.provider_sid`), `shared/setup.ts`/`repos/setup.ts` (`phone_number` item, `comingWith 'front_desk'`). **[C1]**/**[E1]**/**[S1]** they already edited `SetupFacts` (`calendarsConnected`, `pricesAndTiersSaved`, ads).

Read first: `ops/sdd/d1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-front-desk-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** come from those plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`, `ops/sdd/s1/`), not from built code: check each against `c1-crm`/`e1-estimator`/`s1-storm` before starting and report any difference.

**Split:** Builder 1 voice URL setup (`setVoiceUrl` on the company's number when Front Desk settings are first saved and on `Registrar.ensureNumber` results; an `fd-number-voice` repair in `fd-health` for numbers without it); Builder 2 `forwarding-test.ts` (`POST /api/front-desk/forwarding-test` owner/office → `placeTestCall` from `TWILIO_TEST_CALLER_NUMBER` to the business number (`companies.phone_e164` from F3's company basics; missing → 422 field `phone` "Add your business phone number in Settings → Company first."); the voice hook recognises `From = TWILIO_TEST_CALLER_NUMBER` + a pending test for that company → answers `<Say>Forwarding works.</Say><Hangup/>` and marks verified; 30 s timeout → failed with the likely cause); Builder 3 `phone_number` in `shared/setup.ts`/`repos/setup.ts` (done when verified; "Coming with" removed) + tests.

**Files:** Fill the listed files; Modify `apps/api/src/hooks/twilio-voice.ts` (the test-call branch, first statement after routing), `packages/shared/src/setup.ts`, `packages/db/src/repos/setup.ts`; Test `apps/api/test/front-desk/forwarding.test.ts`.

**Tests:**
- test call placed once per minute max; arrival marks verified and the setup item done; timeout fails; another company's pending test is not matched; Front Desk can't be enabled before verification unless `override: true` from the owner.

**Carries and rulings:**
- **Ruling DE:** this task does not edit F3's provisioning; it sets voice URLs when Front Desk settings are first saved and through a repair pass in the `fd-health` schedule for numbers without one.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): Front Desk number setup and a one-click call-forwarding test`
