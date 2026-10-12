### Task 5: Cards, agent detail and chart API

**Base:** `a1-agents` after Task 3 is merged. Real: `company_members` view, `jobScope`. Rule facts from **[S1]** `company_settings` storm columns (S1 T1), **[E1]** estimator settings (E1 T1/T8), **[D1]** Front Desk settings and on-call list (D1 T1/T18).

Read first: `ops/sdd/a1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-agents-screen-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** / **[D1]** come from the plans and briefs of those milestones (`ops/sdd/<milestone>/`), not from built code: check each against the merged branch before starting and report any difference.

**Split:** Builder 1 `repos/agent-metrics.ts` (finished today, 30-day success inputs, minutes by period, 14-day series, by baseline; role-scoped); Builder 2 `agents/metrics.ts` + `GET /api/agents`, `GET /api/agents/:agent`; Builder 3 rules facts gathering (settings of S1, E1, D1) + tests.

**Tests:**
- numbers from seeded tasks; rep scope; G1 agents return `coming_soon` until their flag (`G1_AGENTS_SHIPPED` in shared, false); company B isolation.

**Carries and rulings:**
- **Ruling AX-D:** Front Desk's success rate reads **[D1]** `conversations.outcome` (anything but `abandoned`, and no model-failure hand-off).

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): agent cards, detail, chart and time breakdown`
