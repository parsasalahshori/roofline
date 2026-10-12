### Task 3: Task service — events and step snapshots

**Base:** `a1-agents` after Tasks 1 and 2 are merged. Real (F1): `apps/api/src/tasks/service.ts` (`minutesSavedOf(tx, ctx, taskId)` sums `stepTypes[type].minutesSaved`; `updateTask`; approve/decline/expire paths), `repos/tasks.ts`.

Read first: `ops/sdd/a1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-agents-screen-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** / **[D1]** come from the plans and briefs of those milestones (`ops/sdd/<milestone>/`), not from built code: check each against the merged branch before starting and report any difference.

**Split:** Builder 1 snapshot on step `done` (units from result, the company's override or default, minutes; task `minutes_saved` = sum of step snapshots); Builder 2 `repos/agent-events.ts` + an event at each transition in `tasks/service.ts` (create, approve/partial, decline, step done/failed/attention, finish, expire); Builder 3 tests.

**Tests:**
- each transition writes exactly one event with actor; snapshot uses the override at that moment; later override change leaves old snapshots; F1/F2 task tests stay green.

**Carries and rulings:**
- `tasks/service.ts` is edited only here (plan Ruling 2); it is the single writer of `agent_task_events`.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): task events and per-step time-saved snapshots`
