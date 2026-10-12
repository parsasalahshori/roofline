### Task 10: Voice webhooks and transfers

**Base:** `d1-front-desk` after Task 4 is merged. Real (F3): `hooks/twilio.ts` (signature check with the subaccount token else `TWILIO_AUTH_TOKEN`, routing by number via `@roofline/db/system` `companyIdForNumber`, form-body cap), `providers/twilio/http.ts`, `texting_registrations.subaccount_*` (subaccount credentials), the `twilio` package's `twiml.VoiceResponse`.

Read first: `ops/sdd/d1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-front-desk-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** come from those plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`, `ops/sdd/s1/`), not from built code: check each against `c1-crm`/`e1-estimator`/`s1-storm` before starting and report any difference.

**Split:** Builder 1 `hooks/twilio-voice.ts` (`POST /voice`: signature (subaccount token), route `To` → company via `system/voice-routing.ts`, call row, screen (Task 15's `screenCall`; stub allows), caps (company and global), Front Desk off → `<Dial>` team then voicemail `<Record>`, ring-first, then `<Connect><ConversationRelay …>` with `welcomeGreeting = disclosureGreeting(company)`, `welcomeGreetingInterruptible="none"`, `interruptible="speech"`, providers and voice from settings, `<Parameter name="callId">`, `action` → after-relay); `POST /voice/status`); Builder 2 `hooks/twilio-voice-transfer.ts` (`/after-relay`: reads `HandoffData` JSON `{ kind: 'transfer' | 'end', reason, summary }` → `<Dial timeout=20 action=/after-dial><Number url=/whisper>…</Number>…</Dial>` per `transferPlan`; `/whisper` → `<Gather numDigits=1 timeout=8>` "Roofline call from … Press 1 to take it." → no digit `<Hangup/>` (that leg); `/after-dial` → answered: done; no answer → `<Connect><ConversationRelay>` again with `<Parameter name="mode" value="message_only">` and a greeting "Nobody could pick up right now. I'll take a message."); Builder 3 `providers/twilio/voice.ts` (`CallControl` real: `twilio` REST with the subaccount, `setVoiceUrl`, test call from the main account) + tests with signed form fixtures.

**Files:** Fill the listed files and `packages/db/src/system/voice-routing.ts`, `packages/db/src/repos/calls.ts`; Test `apps/api/test/front-desk/voice-hooks.test.ts`.

**Tests:**
- unsigned → 403; unknown number → 404; TwiML snapshots (relay with greeting containing the disclosure, ring-first, off mode, over-cap); after-relay transfer TwiML per plan; whisper; no-answer returns to message mode; status callback updates the call; company B's number never routes to A.

**Carries and rulings:**
- Unsigned → 403, unknown number → 404, as F3's SMS hook.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): Twilio voice webhooks — the relay with the disclosure greeting, ring-first and warm transfers`
