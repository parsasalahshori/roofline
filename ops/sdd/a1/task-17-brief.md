### Task 17 (track lead, whole-branch review fixes B): API contract, permissions, recount, run now, one-writer guard

**Base:** `a1-agents` after Task 13. Findings: `ops/sdd/a1/review/findings-security-events.md` (S-*, E-M4, E-M7, one-writer test), `findings-numbers.md` (N-3, N-4, N-5). Read them first.

**Own exactly these items:**
- Contract (`packages/shared/src/agents-api.ts`): `AgentsOverview.hourlyRateCents` and `AgentDetail.hourlyRateCents` become `number | null` (null unless the reader has `view_money_totals`; doc comment says the web hides money then); `RecentTask` gains `href: string | null`; add `PauseResult = { paused: boolean; pausedAt: string | null }`.
- S-M4 `apps/api/src/agents/metrics.ts`: send `hourlyRateCents: null` to readers without `view_money_totals`; S-M6/W-I2 `RecentTask.href` built like the feed's `feedHref` (reviewers → `/approvals/<id>`, else the job, else null).
- S-M5 `apps/api/src/agents/rule-facts.ts` (+ `packages/shared/src/agent-rules.ts` if a variant is needed): reps get the Storm Scout sentence without the ad-budget clause and every rule with `links: []`.
- S-M2 strict `dryRun` (absent = real; `'1'` = dry; anything else 400 field `dryRun`); S-M3 `assertKnownFields` on both PUT bodies; S-M8 PUT paused returns `PauseResult`.
- E-M7 run now: refuse a paused agent with 409 "Storm Scout is paused."; send the job after the request transaction commits (house pattern: after `withTenant` returns), keeping the claim inside it.
- Recount (`apps/api/src/agents/recount.ts`, `packages/db/src/repos/time-baselines.ts`): N-4 one recount per company at a time (`pg_try_advisory_xact_lock(hashtext('agents-recount:' || company_id))` in every batch transaction, 409 "A recount is already running." when not acquired; or an equivalent marker), load overrides once before the loop; S-M1 audit `agents.recount.started` before batch 1 and `agents.recount.partial` on failure (then rethrow); N-3/E-M4 lock the touched tasks `FOR UPDATE` (sorted ids) before summing; N-5 update `minutes_saved` only for tasks in a final status (done, partly_done, failed) or whose `minutes_saved` is already set.
- One-writer guard (acceptance GAP, Review Focus 2): ESLint `no-restricted-imports` for `insertAgentEvent` / `setStepSnapshot` outside `apps/api/src/tasks/service.ts` (tests exempt) and `rewriteStepSnapshot` / `refreshTaskMinutes` outside `apps/api/src/agents/recount.ts`, with `apps/api/test/boundaries.test.ts` cases (follow its pattern); plus a no-database source-scan test (e.g. `packages/shared/test/one-writer.test.ts` or next to boundaries) that only `repos/agent-events.ts` inserts into `agent_task_events`. Update `docs/superpowers/a1-acceptance.md` (the GAP row now cites these tests).
- Web compile only: where `hourlyRateCents` may now be null, hide the money parts (AgentsWindow, AgentCard, AgentPage) and render RecentTasks rows as links only when `href` is set; type `usePauseAgent` with `PauseResult`. Keep these web edits minimal (Task 18 reworks these screens next).
- Ledger-only (report): AX-H exception — `agents/recount.ts` rewrites snapshots by design (spec Decision 2).

**Files:** the ones named above plus their tests (`apps/api/test/{agents-api,agents-settings,agents-recount,agents-run-now,agents-rule-facts,boundaries}.test.ts`, `packages/shared/test/agent-rules.test.ts`, the web tests of the touched components), `eslint.config.js`. Do NOT edit `tasks/service.ts`, `repos/{agent-events,agent-waiting,agent-metrics,agent-feed}.ts`, `routes/agents-feed.ts`, `feed-text.ts`, `shared/{agent-periods,steps}.ts` (Task 16 runs in parallel on those).

**Verify:** typecheck, lint, lint:css, shared + web tests locally; db/api through `ci-check` with `CI_JOBS="Platform E2E"`.

Commit: `fix(api): money and rule visibility by role, safe recount, run-now pause check, one-writer guard (A1 review)`
