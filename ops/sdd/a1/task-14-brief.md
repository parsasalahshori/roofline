### Task 14 (track lead): Storm Scout wiring after the s1-storm merge (Ruling AX-K)

**Base:** `a1-agents` after the `s1-storm` (with `e1-estimator`) merge. Not in the plan: the plan assumed S1 was built before A1. This task closes the AX-K seams for Storm Scout (and Estimator facts) now that S1/E1 code is on the branch.

Read first: `ops/sdd/a1/global-constraints.md`; `ops/sdd/a1/progress.md` (Rulings AX-D, AX-J, AX-K and the wave-3 carries); spec `docs/superpowers/specs/2026-10-12-roofline-agents-screen-design.md` §6.

**Do:**
1. **Rule facts** (`apps/api/src/agents/rule-facts.ts`): fill `stormScout` from `company_settings` (`hail_threshold_in`, `storm_ad_budget_cents`, `storm_ad_days`) so `rulesFor('storm_scout', facts)` returns the spec sentence. Point the rule links at the real Settings tab (`/settings/storm`; `shared/agent-rules.ts` has `STORM_SETTINGS = '/settings/storm-scout'`, so fix it there and its test). Estimator facts stay as they are unless E1 has settings the Estimator sentence should name (check `rulesFor('estimator', …)` and E1's estimator settings; add only what the existing sentence uses).
2. **Run now** (`apps/api/src/agents/run-now.ts`, `routes/agents-settings.ts`): register Storm Scout. The handler sends `storm-match-company` `{ companyId }` with `singletonKey: companyId` through the app's `JobQueue` (`deps.jobs`; the handler signature may change to take the queue). Claim the 5-minute slot first, as today. T5's `runNow` for Storm Scout then agrees with the action. Tests: 202 then 409 within 5 minutes; the job is sent once (fake queue); two concurrent calls send one job.
3. **Pause** (spec §6, Decision 6): a paused Storm Scout stops drafting new storm plans; alerts still go out; running work finishes. Find where S1 starts drafting (the `storm-draft` job and/or `storm/settle.ts`, which may still be a stub on this base) and add a one-line `isAgentPaused(tx, ctx, 'storm_scout')` check at the point where a new draft would be created. If the drafting code is still a stub, put the check at the point that queues `storm-draft` and record that in the report. Test: a paused company gets no new draft task; an unpaused one does.
4. **Card/list agreement** (T5/T6 carry): T5's `waitingCount` skips drafts whose `expires_at` has passed (T6's list already does), so the card and the waiting list agree. Test it.

**Do not:** edit `tasks/service.ts`, migrations, or any web file. Keep S1 file edits to the one-line pause check and a handler registration.

**Verify:** typecheck, lint, shared tests locally; db/api suites through `ci-check` with `CI_JOBS="Platform E2E"`.

Commit: `feat(api): Storm Scout rules, Run now and pause wired to S1`
