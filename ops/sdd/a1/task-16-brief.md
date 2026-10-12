### Task 16 (track lead, whole-branch review fixes A): events, waiting, numbers read model, periods

**Base:** `a1-agents` after Task 13. Findings (verified by the review, with file:line and scenarios): `ops/sdd/a1/review/findings-security-events.md` (E-*), `findings-numbers.md` (N-*). Read them first.

**Own exactly these items:**
- E-I1 one `finished` event per task ever (`hasTaskEvent` in `packages/db/src/repos/agent-events.ts`; `refreshTask` writes `finished` only when none exists) + test failed → partly_done → retry → done gives exactly one `finished`.
- E-M5 drop `approveTask`'s own `finished` write; `refreshTask` is the only `finished` writer.
- E-M2 `declineStep` writes a `declined` event (user, `{ skippedSteps: 1 }`, step id) in the same transaction; feed text "{actor} declined a step".
- E-I2 one `waitingNow(now)` helper (draft not past `expires_at`, or `awaiting_owner`, or `needs_attention`) used by `listWaitingTasks` and `agentCounts.waitingCount`; test card count == list length for the three cases.
- E-M1 who a waiting row waits on (owner by name for `awaiting_owner` / spend-only when the reader cannot approve spend; empty classes → `canReview ? you : office`).
- E-M3 interim (no migration): feed ordering ties on the same `at` broken deterministically so `finished` sorts above step events and `approved` above `finished` (rank by kind, then id); cursor stays correct (encode the rank or keep (at, rank, id) consistent in the WHERE). Record the migration follow-up (a `seq` identity column) in your report.
- E-M6 feed copy: no "approved 0 steps"; an office forward of spend steps reads "{actor} sent {n} steps to the owner"; a user rerun reads "{actor} re-ran {title}"; `step_done` shows the unit count for every step type using the baseline's unit word (e.g. "Emails: 212 sent", "Routes: 3 built", "Campaigns: 1 created", "Proposals: 1 sent").
- N-1 / N-6 success rate and finished today: a `partly_done` or `done` task counts as done/partly done only when it has at least one `done` step; a fully failed `partly_done` counts in `ran30d` only; an all-switched-off approved `done` task counts in `notApproved30d` and not in `ran30d` or `finishedToday`. db tests.
- N-7 `startOfLocalDay` at DST-at-midnight zones (America/Santiago 2026-09-06, America/Havana 2026-03-08): earliest candidate whose local date matches; tests for those plus US zones.
- N-10 `create_ad_campaign` units: `typeof result.campaignId === 'string' ? 1 : countOf(result.campaigns)`; test.
- Ledger-only items go in your report: retryStep writes no event (the next step event records the outcome).

**Files:** `apps/api/src/tasks/service.ts`, `packages/db/src/repos/{agent-events,agent-waiting,agent-metrics,agent-feed}.ts`, `apps/api/src/routes/agents-feed.ts`, `apps/api/src/agents/feed-text.ts`, `packages/shared/src/{agent-periods,steps}.ts` and their tests (`apps/api/test/task-events.test.ts`, `agent-feed-repo.test.ts`, `agents-feed-routes.test.ts`, `feed-text.test.ts`, `agents-api.test.ts` only where counts change, `packages/db/test/agent-metrics.test.ts`, `packages/shared/test/{agent-periods,steps-storm}.test.ts`). Do NOT edit `packages/shared/src/agents-api.ts`, `apps/api/src/agents/{metrics,rule-facts,recount,run-now}.ts`, `routes/agents.ts`, `routes/agents-settings.ts`, `repos/time-baselines.ts`, or any web file (Task 17 runs in parallel on those).

**Verify:** typecheck, lint, shared tests locally; db/api through `ci-check` with `CI_JOBS="Platform E2E"`.

Commit: `fix(api): one finished event, waiting agreement and honest success rates (A1 review)`
