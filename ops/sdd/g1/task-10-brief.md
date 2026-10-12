### Task 10: Scheduler — reminders and crew agendas

**Base:** `g1-agents` after Tasks 4 and 5 are merged. **[C1]** appointments of tomorrow (C1 T8 `listAppointments`). Real: `Mailer`.

Read first: `ops/sdd/g1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-more-agents-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** / **[D1]** / **[A1]** come from the plans and briefs of those milestones (`ops/sdd/<milestone>/`), not from built code: check each against the merged branch before starting and report any difference.

**Split:** reminders daily task (`send_personal_texts`, expiry 9 PM); crew agenda emails at 6 PM (Mailer; no approval; opt-out per member); tests.

**Carries and rulings:**
- Staff agendas need no approval (spec Decision 5).

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): Scheduler — tomorrow's reminders and crew agendas`
