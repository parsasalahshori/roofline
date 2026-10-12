### Task 27: End-to-end, acceptance map, docs; manual smoke

**Base:** `d1-front-desk` after Tasks 10–26 are merged. Real: `apps/web/e2e/{stack,fixtures}.ts`; **[C1]**/**[E1]**/**[S1]** their e2e additions and smoke layouts.

Read first: `ops/sdd/d1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-front-desk-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** come from those plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`, `ops/sdd/s1/`), not from built code: check each against `c1-crm`/`e1-estimator`/`s1-storm` before starting and report any difference.

**Files:** Create `apps/web/e2e/front-desk.spec.ts`, `docs/superpowers/{d1-acceptance,d1-manual-smoke}.md`, `apps/api/src/scripts/smoke/front-desk.ts`, `apps/api/test/smoke-front-desk-guards.test.ts`; Modify `apps/web/e2e/{phone,a11y}.spec.ts`, `README.md` (Anthropic, relay URL, test caller number, eval and smoke commands), the e2e reset (seed conversations through a new `seedFrontDeskFixture(pools)` exported from `apps/api/src/index.ts`).
- **E2E:** the window lists seeded conversations; open a call with transcript and action cards; reply to a text (fake SMS adapter receives it); "Team is handling"; Settings save; the forwarding test with fakes (fake call control "arrives" the call); a11y on `/front-desk`, a conversation and Settings → Front Desk; phone no-scroll on the window and conversation.
- **Manual smoke (`smoke:front-desk --confirm-real-providers`):** a staging number with ConversationRelay: call it — disclosure heard, book an inspection on a test company, "what's the price?" → guard line, "water's coming in" → transfer to a test phone with whisper, decline → message; "stop recording"; recording in R2 and gone from Twilio; a forwarded call from each test carrier phone; a text conversation; latency numbers from real calls into `d1-latency.md`; scrubbed Anthropic fixtures replace Task 5's.
- **`d1-acceptance.md`:** every spec §17 bullet → its tests.

**Carries and rulings:**
- **Ruling DA (e2e):** the only Claude client is `@anthropic-ai/sdk` (`new Anthropic({ apiKey, fetch?, maxRetries })`) inside `apps/api/src/providers/anthropic/`; model ids exactly `claude-haiku-5-5` (router, summaries) and `claude-opus-5-5` (answers), from config defaults. Tests use `ScriptedLlm`; the adapter's own test injects a scripted fake `fetch` serving recorded fixtures. **No test or CI step ever reaches api.anthropic.com**: `testConfig()` leaves `ANTHROPIC_API_KEY` unset so `anthropicFor()` returns null, and CI sets no key.
- The manual smoke is the only place real models and real Twilio run.

**Verify notes:**
- typecheck, lint, `npx playwright test --list`; CI via `ci-check`.
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `test(e2e): Front Desk inbox, settings and forwarding; D1 acceptance map and manual smoke`
