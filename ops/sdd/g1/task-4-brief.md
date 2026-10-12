### Task 4: Anthropic `draftTexts` and `extractClaimReply`

**Base:** `g1-agents` after Task 3 is merged. **[D1]** `providers/anthropic/*` (D1 T5: client, error mapping, fallbacks, caching).

Read first: `ops/sdd/g1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-more-agents-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** / **[D1]** / **[A1]** come from the plans and briefs of those milestones (`ops/sdd/<milestone>/`), not from built code: check each against the merged branch before starting and report any difference.

Opus 5.5 (`output_config: { effort: 'low', format: json_schema }`, `fallbacks: 'default'`, cached instructions per draft kind, ≤ 25 jobs per request) and Haiku 5.5 extraction (structured output); fixtures; tests (request bodies, parsing, refusal → template fallback signal).

**Carries and rulings:**
- **Ruling DA applies:** Claude only through D1's `Llm` seam and the Anthropic TypeScript SDK, `claude-opus-5-5` (drafting) and `claude-haiku-5-5` (extraction); tests use `ScriptedLlm`; no live call in CI.
- **Ruling GX-B:** `draftTexts` and `extractClaimReply` are added to D1's `Llm` interface and to `ScriptedLlm` in Task 3; this task implements them in `providers/anthropic/`.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): Claude drafting for agent texts and claim-reply extraction`
