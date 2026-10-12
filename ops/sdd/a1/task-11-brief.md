### Task 11: Web: feed and waiting

**Base:** `a1-agents` after Task 8 is merged. Real (F2): `shell/topbar/AgentsWorking.tsx` (link target changes here only — Ruling AX-C).

Read first: `ops/sdd/a1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-agents-screen-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** / **[D1]** come from the plans and briefs of those milestones (`ops/sdd/<milestone>/`), not from built code: check each against the merged branch before starting and report any difference.

**Split:** `ActivityFeed.tsx` (infinite list, filter chips), `WaitingList.tsx` (grouped by who it waits on); top bar "N agents working" links to `/agents/feed`; tests.

**Carries and rulings:**
- **Ruling AX-C:** only this task edits `AgentsWorking.tsx` (its link goes to `/agents/feed`).

**Verify notes:**
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(web): agent activity feed and waiting-on-a-person list`
