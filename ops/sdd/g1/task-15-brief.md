### Task 15: A1 integration

**Base:** `g1-agents` after Tasks 8, 11 and 13 are merged. **[A1]** `shared/agents.ts` (`TIME_BASELINES`, `rulesFor`, `G1_AGENTS_SHIPPED`), `agents/{rules,run-now}.ts`, `agent_settings`.

Read first: `ops/sdd/g1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-more-agents-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** / **[D1]** / **[A1]** come from the plans and briefs of those milestones (`ops/sdd/<milestone>/`), not from built code: check each against the merged branch before starting and report any difference.

Rules sentences for the three agents, Run now wiring, pause honoured by each daily job (start paused on first deploy: `agent_settings` rows inserted paused for existing companies in a data step of this task's code, not a migration), `G1_AGENTS_SHIPPED = true`; tests.

**Carries and rulings:**
- **Ruling GX-E:** for `claims`, `scheduler`, `follow_up` a missing `agent_settings` row means **paused** (`isPaused(agent, row)` in `shared/agents.ts`), so new companies also start paused; existing behaviour for launch agents (missing row = on) is unchanged.
- `shared/agents.ts` edited only here in G1.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(agents): Claims, Scheduler and Follow-up live on the Agents screen, starting paused`
