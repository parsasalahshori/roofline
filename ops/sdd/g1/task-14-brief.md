### Task 14: Follow-up — review requests

**Base:** `g1-agents` after Task 13 is merged. Real (F3): marketing consent rule in the gate.

Read first: `ops/sdd/g1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-more-agents-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** / **[D1]** / **[A1]** come from the plans and briefs of those milestones (`ops/sdd/<milestone>/`), not from built code: check each against the merged branch before starting and report any difference.

Installed + `review_delay_days`, once per job, marketing consent only, company name + STOP, no gating; settings; tests.

**Carries and rulings:**
- No review gating (spec Decision 10).

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): review requests after installs, with marketing consent`
