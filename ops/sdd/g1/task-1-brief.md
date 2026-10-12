### Task 1: Schema, migrations, skeleton

**Base:** `g1-agents`, branched from `a1-agents` once A1 is merged. **[A1]** A1 ends at migration `0021`; G1 takes `0022`/`0023`. **[E1]** `STORED_FILE_KINDS` (gains `claim_packet`). **[D1]** `claim_intakes` (promoted into `claims`). **[C1]** `appointments` (gains `moved_by_task_id`).

Read first: `ops/sdd/g1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-more-agents-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** / **[D1]** / **[A1]** come from the plans and briefs of those milestones (`ops/sdd/<milestone>/`), not from built code: check each against the merged branch before starting and report any difference.

**Split:** Builder 1 schema + `0022` (spec §6); Builder 2 `0023` grants/RLS + tests; Builder 3 placeholders, barrels, constants (`CLAIM_STATUSES`, `FOLLOW_UP_KINDS`, `STEP_TYPES` gains `send_personal_texts`, `build_claim_packet`, `create_appointment`, `move_appointment`; `STORED_FILE_KINDS` gains `claim_packet`).

**Tests:**
- tenant tables with RLS forced; one claim per job; grants.

**Carries and rulings:**
- Barrels here; no lockfile change.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(db): G1 schema (claims, claim events, follow-up log, agent settings)`
