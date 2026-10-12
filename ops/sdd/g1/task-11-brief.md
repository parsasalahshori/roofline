### Task 11: Scheduler — weather watch and `move_appointment`

**Base:** `g1-agents` after Tasks 9 and 10 are merged. **[C1]** availability for all-day installs (C1 T3/T9), `updateAppointment` + calendar push (C1 T8).

Read first: `ops/sdd/g1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-more-agents-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** / **[D1]** / **[A1]** come from the plans and briefs of those milestones (`ops/sdd/<milestone>/`), not from built code: check each against the merged branch before starting and report any difference.

**Split:** risk scan (Task 9 + `weatherRisk`), next clear free day for the crew (C1 availability all-day + forecast), task with `move_appointment` + customer texts; `move_appointment` handler (re-check, C1 calendar push, `moved_by_task_id`); tests.

**Carries and rulings:**
- Moves are proposals; customers are texted only after approval.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): Scheduler — propose moving installs before bad weather`
