### Task 4: Front Desk live tasks

**Base:** `a1-agents` after Task 3 is merged. **[D1]** `apps/api/src/front-desk/{after-call,texts}.ts` (D1 T13, T14), `conversations`/`calls` tables, conversation outcomes. **[C1]** next-step clearing in `updateJob` (C1 T6) for the follow-up → done hook.

Read first: `ops/sdd/a1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-agents-screen-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** / **[D1]** come from the plans and briefs of those milestones (`ops/sdd/<milestone>/`), not from built code: check each against the merged branch before starting and report any difference.

**Split:** Builder 1 `after-call.ts` → `createLiveTask(…)` (kind `call`, step `front_desk_call` result `{ seconds, bookings, spam }`, status `needs_attention` when a message follow-up is open; closes to `done` when the follow-up job's next step is cleared — hook in C1's next-step update via an event listener in `agents/front-desk-tasks.ts`); Builder 2 `texts.ts` → one live task per text conversation per day (`front_desk_texts`, result `{ replies, bookings }`); Builder 3 tests.

**Tests:**
- one task per call (idempotent on call id); spam call minutes = call length; live tasks never in "need your OK"; follow-up cleared → task done.

**Carries and rulings:**
- Live tasks never appear in "need your OK" (`mode 'live'`).

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): Front Desk calls and texts counted as live agent tasks`
