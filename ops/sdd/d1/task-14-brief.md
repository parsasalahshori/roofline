### Task 14: Text channel

**Base:** `d1-front-desk` after Task 6 is merged. Real (F3): `hooks/twilio.ts` `/sms` (STOP/HELP/START first, the inbound insert is the claim), `packages/send-gate/src/decide.ts` (`GateRequest`), `messaging/outbound.ts`. **[S1]** S1 T21's `onStormReply` call sits after STOP handling — the Front Desk call goes after it.

Read first: `ops/sdd/d1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-front-desk-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** come from those plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`, `ops/sdd/s1/`), not from built code: check each against `c1-crm`/`e1-estimator`/`s1-storm` before starting and report any difference.

**Split:** Builder 1 the one call in `hooks/twilio.ts` after S1's `onStormReply` (`await queueFrontDeskText(tx, message)` when Front Desk texts are on, the message isn't STOP/HELP/START, and S1 didn't consume it) + conversation grouping (active SMS conversation per number; new after 24 h) + `messages.conversation_id`; Builder 2 `texts.ts` (`fd-text` job, debounced 20 s: gather unanswered inbound texts, skip when `handled_by = 'team'` or a team reply within 2 h; "C"/"confirm" shortcut via Task 8's helper; engine with `TEXT_CHANNEL_TOOLS`; reply joined to ≤ 2 segments where possible; send through the gate as `informational` with `inReplyToInboundAt`); Builder 3 `send-gate/decide.ts` (`inReplyToInboundAt?: Date` — quiet hours don't delay a reply sent within 10 minutes of the customer's text) + tests.

**Files:** Fill the listed files; Modify `apps/api/src/hooks/twilio.ts` (one call), `packages/send-gate/src/decide.ts` (+ its test); Test `apps/api/test/front-desk/texts.test.ts`, `packages/send-gate/test/decide.test.ts` (extend).

**Tests:**
- three quick texts → one reply; team reply silences for 2 h; "Team is handling" silences; STOP never reaches Front Desk; S1 YES reply never double-answered; quiet-hours exception only within 10 minutes; guard applied to texts; confirm shortcut.

**Carries and rulings:**
- **[S1]** order of inbound handlers: STOP/HELP/START → S1 YES reply → Front Desk. `send-gate/src/decide.ts` gains only the optional `inReplyToInboundAt` input.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): Front Desk answers texts through the send gate unless the team is handling it`
