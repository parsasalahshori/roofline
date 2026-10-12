### Task 12: Scheduler — no-shows

**Base:** `g1-agents` after Task 10 is merged. **[C1]** `setAppointmentStatus(..., 'no_show')` (C1 T8).

Read first: `ops/sdd/g1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-more-agents-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** / **[D1]** / **[A1]** come from the plans and briefs of those milestones (`ops/sdd/<milestone>/`), not from built code: check each against the merged branch before starting and report any difference.

No-show → draft text with two times; tests.

**Carries and rulings:**
- One draft per no-show.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): Scheduler — rebook no-shows`
