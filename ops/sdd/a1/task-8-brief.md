### Task 8: Web skeleton

**Base:** `a1-agents` after Task 2 is merged. **[C1]** `router.tsx`, `shell/apps.ts` (`shipped: boolean`), `Settings.tsx`/`tabs.ts`. Real (F2): the `agents` dock app (`/agents`), `shell/topbar/AgentsWorking.tsx`.

Read first: `ops/sdd/a1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-agents-screen-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** / **[D1]** come from the plans and briefs of those milestones (`ops/sdd/<milestone>/`), not from built code: check each against the merged branch before starting and report any difference.

**Split:** routes `/agents`, `/agents/:agent`, `/agents/feed`, `/agents/waiting`; dock flag `agents` shipped; Settings → Agents slot; `copy/agents.ts`; route tests.

**Carries and rulings:**
- Settings gains an `agents` tab (owner edits, office reads).

**Verify notes:**
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(web): routes and slots for the Agents screen`
