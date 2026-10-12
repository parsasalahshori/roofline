### Task 2: Shared steps, rules, limits, guards

**Base:** `g1-agents` after Task 1 is merged. **[A1]** `shared/steps.ts` with `baseline` + `units` per step type and `TIME_BASELINES` in `shared/agents.ts` (A1 T2) — G1 adds its four baseline keys in this task (`steps.ts`) and the table entries in **T15** (`agents.ts`). **[D1]** guards `guardSentence` (D1 T2).

Read first: `ops/sdd/g1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-more-agents-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** / **[D1]** / **[A1]** come from the plans and briefs of those milestones (`ops/sdd/<milestone>/`), not from built code: check each against the merged branch before starting and report any difference.

**Split:** Builder 1 four step types (payloads, validation, previews, A1 baselines `claim_packet` 30, `reminder_sent` 1, `install_moved` 10, `follow_up_sent` 2); Builder 2 `more-agents.ts`: `followUpAllowed({ log, kind, customerId, now, lastInboundAt, lastStormTextAt })`, `proposalFollowUpDue`, `leadFollowUpDue`, `claimNudgeDue`, `weatherRisk(hourly, workHours, thresholds)`, `CLAIM_STATUS_FLOW`; Builder 3 `claimsGuard` (extends D1 guards: deductible, coverage, "free roof" with insurance) + tests.

**Carries and rulings:**
- `shared/steps.ts` edited only here in G1.

**Verify notes:**
- Pure/web tests run locally (`npx vitest run --project <project> <file>`); confirm on CI with `ops/bin/ci-check`.
- Commit: `feat(shared): G1 step types, follow-up limits, weather risk and claims guards`
