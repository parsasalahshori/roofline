### Task 17: Web — review previews and Settings → Agents values

**Base:** `g1-agents` after Task 2 is merged. **[S1]** `features/approvals/steps/index.ts` registry (Ruling SD). **[A1]** Settings → Agents tab.

Read first: `ops/sdd/g1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-more-agents-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** / **[D1]** / **[A1]** come from the plans and briefs of those milestones (`ops/sdd/<milestone>/`), not from built code: check each against the merged branch before starting and report any difference.

Previews for the four steps (personal texts list with per-message Edit and remove; packet; appointment; move with forecast reason) and `AgentRules.tsx` settings form; tests.

**Carries and rulings:**
- Register previews in the **[S1]** registry only.

**Verify notes:**
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(web): review G1 drafts and set each agent's rule values`
