### Task 1: Schema, migrations, skeleton

**Base:** `a1-agents`, branched from `d1-front-desk` once D1 is merged. **[D1]** D1 ends at migration `0019`; A1 takes `0020`/`0021`. Real (F1): `agent_tasks` (`minutes_saved`, `mode needs_approval|live` — `TASK_MODES` in `packages/db/src/schema/enums.ts`), `agent_task_steps`, `company_settings.hourly_rate_cents` (2800).

Read first: `ops/sdd/a1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-agents-screen-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** / **[D1]** come from the plans and briefs of those milestones (`ops/sdd/<milestone>/`), not from built code: check each against the merged branch before starting and report any difference.

**Split:** Builder 1 schema + `0020`; Builder 2 `0021` grants/RLS + tests; Builder 3 placeholders, barrels, constants (`AGENT_EVENT_KINDS = ['created','approved','partly_approved','declined','step_done','step_failed','step_attention','finished','expired'] as const`, `AGENT_STATUSES_VIEW = ['on','paused','waiting','coming_soon'] as const`, `STEP_TYPES` gains `'front_desk_call'`, `'front_desk_texts'`).
- **Tables/columns:** spec §8. Grants: tenant SELECT/INSERT on `agent_task_events` (no UPDATE/DELETE), SELECT/INSERT/UPDATE on `time_baselines`, `agent_settings`, INSERT/SELECT on `time_recounts`; UPDATE on the four new step columns.

**Tests:**
- tenant tables, RLS forced, grants; events immutable for `app_tenant`.

**Carries and rulings:**
- Barrels get every A1 line here; no lockfile change.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(db): A1 schema (step time snapshots, baselines, agent events and settings)`
