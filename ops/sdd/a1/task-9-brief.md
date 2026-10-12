### Task 9: Web: Agents window

**Base:** `a1-agents` after Task 8 is merged. Real (F2): `StatCard`, `Card`, `Pill`, `copy/status.ts` (`AGENT_LABEL`).

Read first: `ops/sdd/a1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-agents-screen-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** / **[D1]** come from the plans and briefs of those milestones (`ops/sdd/<milestone>/`), not from built code: check each against the merged branch before starting and report any difference.

**Split:** Builder 1 `AgentCard.tsx` (numbers, status chip, "Coming soon" variant); Builder 2 `MiniChart.tsx` (SVG bars + hidden table); Builder 3 `AgentsWindow.tsx` (grid, totals line "About 31 hours saved this month (estimate) · ≈ $870", info popover) + tests.

**Carries and rulings:**
- "about" and "(estimate)" on every time/money figure.

**Verify notes:**
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(web): Agents window with honest time-saved estimates`
