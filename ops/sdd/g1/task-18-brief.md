### Task 18: Evals, end-to-end and acceptance

**Base:** `g1-agents` after Tasks 7–17 are merged. Real: e2e stack; **[D1]** `eval:front-desk` script layout for the evals.

Read first: `ops/sdd/g1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-more-agents-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** / **[D1]** / **[A1]** come from the plans and briefs of those milestones (`ops/sdd/<milestone>/`), not from built code: check each against the merged branch before starting and report any difference.

`scripts/eval-agent-texts.ts` (`--confirm-spend`, spec §9 evals), `apps/web/e2e/more-agents.spec.ts` (turn on Follow-up, Run now, approve the task, texts sent via fake SMS; claim section and packet; weather move review), `docs/superpowers/g1-acceptance.md`.

**Carries and rulings:**
- **Ruling DA applies:** Claude only through D1's `Llm` seam and the Anthropic TypeScript SDK, `claude-opus-5-5` (drafting) and `claude-haiku-5-5` (extraction); tests use `ScriptedLlm`; no live call in CI.
- `eval:agent-texts` refuses without `--confirm-spend`.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `test: G1 evals by hand, end-to-end and acceptance map`
