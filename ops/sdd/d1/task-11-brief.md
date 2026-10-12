### Task 11: Relay WebSocket server

**Base:** `d1-front-desk` after Tasks 6 and 10 are merged. From T4: `VoiceSession`, `RelayIn`, `RelayOut`, `relaySessions` registry, the `server.ts` upgrade stub. From T6: `createEngine`. From T10: call rows (`repos/calls.ts`). `ws` added by T1.

Read first: `ops/sdd/d1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-front-desk-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** come from those plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`, `ops/sdd/s1/`), not from built code: check each against `c1-crm`/`e1-estimator`/`s1-storm` before starting and report any difference.

**Split:** Builder 1 `relay-server.ts` upgrade (`?t=` token: HMAC of `callId.companyId.exp` (10 minutes) under `RELAY_TOKEN_SECRET`, verified constant-time; `X-Twilio-Signature` on the upgrade checked when present; one socket per call; `setup.customParameters.callId` must equal the token's call) + `system/relay-tokens.ts`; Builder 2 the session loop (ConversationRelay JSON → `VoiceSession` → engine; `prompt` with `last: true` starts a turn, partials ignored; `interrupt` aborts the turn and records truncation; `dtmf` 0 → transfer request; engine `say`/`filler` → `{type:'text', token, last}` sentence by sentence; `handoff`/`end` → `{type:'end', handoffData}`); Builder 3 accounting (`ai_started_at`, `ai_seconds` on close, session registry for caps, heartbeat/idle 20 s silence prompt "Are you still there?" then end after another 20 s) + tests with a scripted relay client over a real `ws` loopback.

**Files:** Fill the listed files; Modify `apps/api/src/server.ts` (replace the stub handler — Ruling 2); Test `apps/api/test/front-desk/relay.test.ts`.

**Tests:**
- bad/expired token → close 1008; token for company A with B's call → 1008; a full scripted call (setup → prompt → text tokens → end with handoff) through `ScriptedLlm`; interruption truncates and cancels; idle handling; `ai_seconds` measured; registry decrements on close; no transcript text in logs (log spy).

**Carries and rulings:**
- No transcript text, phone number or token in logs (log call id and company id).

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): the ConversationRelay socket — authenticated, streaming, interruptible`
