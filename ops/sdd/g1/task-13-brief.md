### Task 13: Follow-up — finder, drafting, daily task, stuck nudges

**Base:** `g1-agents` after Tasks 4 and 5 are merged. **[E1]** proposals (`sent`/`viewed`/`signed`, events). **[C1]** stuck rule (`isStuck`, C1 T2) and next steps. **[S1]** last storm text per customer (`messages` dedupe `storm:%`).

Read first: `ops/sdd/g1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-more-agents-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** / **[D1]** / **[A1]** come from the plans and briefs of those milestones (`ops/sdd/<milestone>/`), not from built code: check each against the merged branch before starting and report any difference.

**Split:** `repos/follow-up-finder.ts` (proposals, leads, stuck jobs with stop conditions); `followup/draft.ts` (Opus drafting, guards, template fallback); daily task assembly + rep nudges (in-app + Today next step); tests.

**Carries and rulings:**
- **Ruling DA applies:** Claude only through D1's `Llm` seam and the Anthropic TypeScript SDK, `claude-opus-5-5` (drafting) and `claude-haiku-5-5` (extraction); tests use `ScriptedLlm`; no live call in CI.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): Follow-up agent — proposals, leads and stuck jobs`
