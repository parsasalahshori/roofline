### Task 8: Claims nudges, replies, adjuster appointments

**Base:** `g1-agents` after Tasks 4, 5 and 6 are merged. **[C1]** `createAppointment` and availability (C1 T8/T9). **[D1]** the Front Desk text path that continues after the claims hook.

Read first: `ops/sdd/g1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-more-agents-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** / **[D1]** / **[A1]** come from the plans and briefs of those milestones (`ops/sdd/<milestone>/`), not from built code: check each against the merged branch before starting and report any difference.

**Split:** Builder 1 `nudges.ts` daily task (spec §3.3 rules, `draftTexts`, guards, limits); Builder 2 `replies.ts` (7-day window, extraction, live claim update task, D1 continuation or "Thanks, got it."); Builder 3 `create_appointment` handler (availability check, C1 calendar push) + tests.

**Carries and rulings:**
- **Ruling DA applies:** Claude only through D1's `Llm` seam and the Anthropic TypeScript SDK, `claude-opus-5-5` (drafting) and `claude-haiku-5-5` (extraction); tests use `ScriptedLlm`; no live call in CI.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): Claims agent — nudges, reply extraction and adjuster visits`
