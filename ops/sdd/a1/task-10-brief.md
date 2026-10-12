### Task 10: Web: agent page

**Base:** `a1-agents` after Task 8 is merged. Real (F2): `features/approvals/Review.tsx` routes (`/approvals/:taskId`) for recent tasks.

Read first: `ops/sdd/a1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-agents-screen-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** / **[D1]** come from the plans and briefs of those milestones (`ops/sdd/<milestone>/`), not from built code: check each against the merged branch before starting and report any difference.

**Split:** rules list with links, pause switch with confirm, Run now with cooldown text, recent tasks (open in F2 review), time breakdown table by baseline; tests.

**Carries and rulings:**
- Pause needs a confirm; Run now shows the cooldown.

**Verify notes:**
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(web): agent page with plain-English rules, pause and Run now`
