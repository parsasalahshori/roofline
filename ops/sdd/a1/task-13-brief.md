### Task 13: End-to-end and acceptance

**Base:** `a1-agents` after Tasks 4–12 are merged. Real: `apps/web/e2e/{stack,fixtures}.ts`; **[C1]**/**[E1]**/**[S1]**/**[D1]** their e2e seeds.

Read first: `ops/sdd/a1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-agents-screen-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** / **[D1]** come from the plans and briefs of those milestones (`ops/sdd/<milestone>/`), not from built code: check each against the merged branch before starting and report any difference.

**Files:** `apps/web/e2e/agents.spec.ts`, `docs/superpowers/a1-acceptance.md`, a11y/phone spec edits, e2e seed `seedAgentsFixture`.
- **Tests:** cards from seeded tasks; changing a baseline then recount changes the month total; pause Storm Scout; feed and waiting rows link correctly; "(estimate)" visible; a11y; 375px.

**Carries and rulings:**
- Acceptance map: `docs/superpowers/a1-acceptance.md`.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `test(e2e): Agents screen and A1 acceptance map`
