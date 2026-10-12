### Task 6: Claims record and API

**Base:** `g1-agents` after Task 3 is merged. **[D1]** `claim_intakes` (D1 T9). **[C1]** `jobScope`-based job routes.

Read first: `ops/sdd/g1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-more-agents-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** / **[D1]** / **[A1]** come from the plans and briefs of those milestones (`ops/sdd/<milestone>/`), not from built code: check each against the merged branch before starting and report any difference.

**Split:** `repos/claims.ts` (promote D1 intakes, status changes with `claim_events`), `routes/claims.ts` (`GET/PUT /api/jobs/:id/claim`, `GET /api/claims?status=` board), role scope; tests.

**Carries and rulings:**
- Claim facts updated from replies are reversible in the job window.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): insurance claim records on jobs`
