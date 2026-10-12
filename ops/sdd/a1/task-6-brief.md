### Task 6: Feed and waiting API

**Base:** `a1-agents` after Task 3 is merged. From T3: `agent_task_events` writes. **[D1]** open Front Desk follow-ups (jobs' next steps created by D1 T9).

Read first: `ops/sdd/a1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-agents-screen-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** / **[D1]** come from the plans and briefs of those milestones (`ops/sdd/<milestone>/`), not from built code: check each against the merged branch before starting and report any difference.

**Split:** Builder 1 `repos/agent-feed.ts` (events joined to tasks and subjects, cursor paging, agent filter, role scope); Builder 2 `GET /api/agents/waiting` (drafts by approver class, attention tasks, open Front Desk follow-ups, who it waits on); Builder 3 plain sentences per event kind in `agents/feed-text.ts` (copy constants) + tests.

**Carries and rulings:**
- Event `data` holds counts and ids only.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): agent activity feed and the waiting-on-a-person list`
