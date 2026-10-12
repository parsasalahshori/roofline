### Task 7: Baselines settings, recount, pause, Run now

**Base:** `a1-agents` after Task 3 is merged. **[S1]** `apps/api/src/storm/settle.ts` (S1 T10) and the `storm-match-company` job (S1 T7/T9); **[D1]** `apps/api/src/hooks/twilio-voice.ts` (D1 T10, Front Desk off path). Real: `audit`.

Read first: `ops/sdd/a1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-agents-screen-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** / **[D1]** come from the plans and briefs of those milestones (`ops/sdd/<milestone>/`), not from built code: check each against the merged branch before starting and report any difference.

**Split:** Builder 1 `GET/PUT /api/agents/time-baselines` (owner edits, office reads) + `recount.ts` (owner; last 90 days; one transaction per 1,000 steps; `time_recounts` + audit log); Builder 2 `PUT /api/agents/:agent/paused` + honouring it: S1 `storm/settle.ts` skips drafting when paused, D1 `twilio-voice.ts` treats paused like Front Desk off (two one-line checks, owned here); Builder 3 `POST /api/agents/:agent/run` (Storm Scout → `storm-match-company` now; others 409 "This agent works when you ask"; 5-minute limit via `last_run_now_at`) + tests.

**Carries and rulings:**
- Two one-line pause checks in **[S1]** `storm/settle.ts` and **[D1]** `hooks/twilio-voice.ts` are this task's.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): editable time baselines with an audited recount, agent pause and Run now`
