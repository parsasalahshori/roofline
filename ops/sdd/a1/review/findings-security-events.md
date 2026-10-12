# Whole-branch review findings (security/schema + events/concurrency), verified by reviewers

## Fix now
- S-M1 recount.ts: failing real recount leaves rewritten steps with no audit. Write `agents.recount.started` audit before batch 1 (range, by, baselines) and, on failure, `agents.recount.partial` (partial before/after, steps) then rethrow.
- S-M2 agents-settings.ts:96 dryRun loose: accept undefined (real) or '1' (dry); anything else 400 checkField 'dryRun'.
- S-M3 agents-settings.ts PUT bodies: assertKnownFields(req.body, ['minutes']) and (['paused']).
- S-M4 hourlyRateCents in GET /api/agents and /:agent sent to every role; money "≈ $" shown to reps. Decision (track lead): `hourlyRateCents: number | null` in AgentsOverview/AgentDetail (contract), null unless can(ctx,'view_money_totals'); web hides money parts when null.
- S-M5 Storm Scout rule sentence shows ad budget to reps and links to /settings/storm they can't open. Decision: for reps, variant sentence without the budget clause and rules without links (links: [] for reps).
- S-M6 RecentTasks links /approvals/<id> for reps who get not-found. Add `href: string | null` to RecentTask (contract), built server-side like the feed (canReview -> /approvals/<id>, else job href, else null); web renders a plain row when null.
- S-M8 add `PauseResult = { paused: boolean; pausedAt: string | null }` to the contract; web types usePauseAgent with it.
- E-I1 service.ts refreshTask: second `finished` after retry. Write `finished` only when no `finished` event exists for the task (repo helper hasTaskEvent in agent-events.ts; row already locked). Test: failed -> partly_done -> retry -> done = exactly one finished.
- E-I2 waiting filters: one exported helper `waitingNow(now)` in agent-waiting.ts = draft with (expires_at null or > now) OR status in (awaiting_owner, needs_attention); use it in listWaitingTasks and agentCounts waitingCount. Test card count == list length for expired draft / awaiting_owner past expiresAt / needs_attention past expiresAt.
- E-M1 who-it-waits-on: awaiting_owner or all open classes spend and reader can't approve spend -> {kind:'person', name: owner's name from company_members role owner}; empty classes -> canReview ? you : office.
- E-M2 declineStep writes no event: write 'declined' (user, {skippedSteps:1}, step id) in the same tx; feed-text "{actor} declined a step" when the event has a step.
- E-M4 recount refreshTaskMinutes: lock the task row (SELECT ... FOR UPDATE) before summing.
- E-M5 approveTask's own `finished` write with hard-coded 'done': drop it, let refreshTask be the only finished writer (with the I-1 existence check).
- E-M6 feed copy: no "approved 0 steps" (switched-off-all → "{actor} approved the plan with every step switched off" or skip; office forwarding spend → "{actor} sent {n} steps to the owner"); rerun created by a user → "{actor} re-ran …"; step_done shows units for every step type with a unit word (from TIME_BASELINES unit) e.g. "Emails: 212 sent", "Routes: 3 built".
- E-M7 run-now: refuse when paused (409 "Storm Scout is paused."); send the job after withTenant commits (house pattern), claim stays in tx.
- One-writer test (acceptance GAP): source-scan unit test (no DB) + eslint no-restricted-imports for insertAgentEvent/setStepSnapshot outside tasks/service.ts (tests exempt) and rewriteStepSnapshot/refreshTaskMinutes outside agents/recount.ts; boundaries.test.ts cases. Update docs/superpowers/a1-acceptance.md (GAP -> test).

## Defer (needs a migration; A1 owns only 0021/0022, already applied by other tracks' probes)
- S-M7 DB CHECKs: time_baselines minutes_per_unit 0..600; time_recounts from<=to; events step FK including task_id.
- E-M3 event ordering within one transaction: add `seq bigint generated always as identity`, order (at desc, seq desc). Interim (no migration): in feed ordering, break ties by kind rank so finished sorts above step events of the same `at` (cheap, deterministic).
- S-M8b recount dry run blocked by readOnlyGuard for lapsed companies: consistent with the guard; keep.
- E-M8 pause/draft atomicity: S1 Task 11 (ledger).

## Ledger notes
- AX-H exception: agents/recount.ts rewrites snapshots (spec Decision 2).
- retryStep writes no event (the next step event records the outcome).
