## Global Constraints (A1 Agents screen)

Adapted from the earlier milestones' constraints (`ops/sdd/{c1,e1,s1,d1}/global-constraints.md`, which carry F1–F3's rules) and the plan (`docs/superpowers/plans/2026-10-12-roofline-agents-screen.md`). Spec: `docs/superpowers/specs/2026-10-12-roofline-agents-screen-design.md`. Branch `a1-agents` from `d1-front-desk` once D1 is merged; task branches `a1-t<N>`. Rulings use the prefix **AX-** (F2 already used plain letters).

**Upstream milestones are not built yet.** Names marked **[C1]** / **[E1]** / **[S1]** / **[D1]** in a brief come from their plans and briefs; the lead checks each against the merged branch before starting and records any difference.

**Everything in the upstream global constraints applies**, with these changes:
- **Migrations:** A1 owns `0020`/`0021` (Task 1). D1 ends at `0019`.
- **No new dependencies.**
- **Time saved** comes only from per-step snapshots; every figure shown says "about" and "(estimate)".

**From the plan (verbatim):**
- Everything in the earlier milestones' Global Constraints applies.
- **Every time-saved number comes from step snapshots** (`agent_task_steps.minutes_saved`); no read model recomputes minutes from current baselines (except the explicit recount, Task 7).
- **"about" and "(estimate)"** accompany every time or money saved figure in the UI (a copy test enforces it on the components that show them).
- **Feed data never stores message text or customer names in `agent_task_events.data`** — counts and ids only; names are joined at read time under the reader's role scope.
- **Lockfile:** untouched. **Migrations:** only Task 1 (`0020` generated, `0021` custom).

## Review Focus


1. **Honest numbers:** only done steps with result units; caps; snapshot at completion; recount only by the owner, audited. (Tasks 2, 3, 7)
2. **One writer:** `tasks/service.ts` writes every event and snapshot; no other module inserts events. (Task 3)
3. **Role scope in aggregates:** reps' feed and cards count only their jobs' work; company totals for owner/office. (Tasks 5, 6)
4. **Pause semantics:** paused agents start nothing new; running work finishes. (Task 7)
