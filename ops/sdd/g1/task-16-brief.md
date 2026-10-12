### Task 16: Web — Claim section and claims board

**Base:** `g1-agents` after Task 6 is merged (runs in W7 beside T15 — Ruling GX-F). **[C1]** `features/job/JobSections.tsx` (also edited by **[E1]** T20). **[A1]** agent page (`/agents/claims`).

Read first: `ops/sdd/g1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-more-agents-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** / **[D1]** / **[A1]** come from the plans and briefs of those milestones (`ops/sdd/<milestone>/`), not from built code: check each against the merged branch before starting and report any difference.

`ClaimSection.tsx` in the job window (status, fields, history, packet build/download), `ClaimsBoard.tsx` on the Claims agent page; tests.

**Carries and rulings:**
- **Ruling GX-C:** add `ClaimSection.tsx` and one line in **[C1]** `JobSections.tsx`; nothing else in `features/job/`.

**Verify notes:**
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(web): claim section on jobs and the claims board`
