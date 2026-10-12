### Task 3: API skeleton

**Base:** `g1-agents` after Tasks 1 and 2 are merged. **[D1]** `Llm` interface and `ScriptedLlm` (D1 T4), `hooks/twilio.ts` with **[S1]** `onStormReply` then **[D1]** the Front Desk call. Real: `JOB_NAMES`, `SCHEDULES`, `builtInHandlers`.

Read first: `ops/sdd/g1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-more-agents-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** / **[D1]** / **[A1]** come from the plans and briefs of those milestones (`ops/sdd/<milestone>/`), not from built code: check each against the merged branch before starting and report any difference.

**Split:** Builder 1 jobs `claims-daily`, `scheduler-reminders`, `scheduler-agenda`, `scheduler-weather`, `followup-daily` (per company, fan-out schedules `*/15 * * * *` that fire each company at its local hour), step handler stubs; Builder 2 `Llm` gains `draftTexts(i: { instruction: DraftKind; facts: JobFacts[] }) → { texts: { jobId, body }[] }` and `extractClaimReply(text) → ClaimReplyFacts` (+ `ScriptedLlm` support); Builder 3 `hooks/twilio.ts` order (claims replies hook between S1 and D1, stub) + tests.

**Carries and rulings:**
- **Ruling GX-A:** the claims-reply hook goes in `hooks/twilio.ts` **after** S1's `onStormReply` and **before** D1's Front Desk call (this task's one edit).
- **Ruling GX-D:** add config `MAPTILER_SERVER_KEY` (optional; the web key is browser-only) for the claim packet's static map; without it the packet omits the map image.
- **Ruling DA applies:** Claude only through D1's `Llm` seam and the Anthropic TypeScript SDK, `claude-opus-5-5` (drafting) and `claude-haiku-5-5` (extraction); tests use `ScriptedLlm`; no live call in CI.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): G1 skeleton — agent jobs, drafting and extraction seams, inbound order`
