# SDD ledger — plan: docs/superpowers/plans/2026-10-12-roofline-agents-screen.md

Spec: docs/superpowers/specs/2026-10-12-roofline-agents-screen-design.md. Branch `a1-agents`, to be created from `d1-front-desk` once D1 is merged (C1, E1, S1 and D1 are not built yet; at writing `origin/f3-setup` is 7b988eb). Rulings use the prefix **AX-** (plain A–H belong to F2). Names marked **[C1]** / **[E1]** / **[S1]** / **[D1]** come from those plans and briefs and must be checked against the merged branches before each task starts.

## Upstream dependencies

| From | Name A1 uses | A1 tasks |
|---|---|---|
| F1 (real) | `tasks/service.ts` `minutesSavedOf`, `TASK_MODES` (`needs_approval`, `live`), `hourly_rate_cents` | T1, T3 |
| E1 T4 | step types `send_proposal`, `order_exact_report` (minutes 20, 10) | T2 |
| S1 T6 | step types `send_email_batch`, `build_routes`, `create_ad_campaign` | T2 |
| S1 T1/T10 | storm settings columns; `storm/settle.ts` | T5, T7 |
| E1 T1/T8 | estimator settings | T5 |
| D1 T1/T13/T14/T18 | `conversations` (outcome), `after-call.ts`, `texts.ts`, Front Desk settings, on-call list | T4, T5, T6 |
| D1 T10 | `hooks/twilio-voice.ts` (Front Desk off path) | T7 |
| C1 T6 | next-step clearing in `updateJob` | T4 |
| C1 T18 | `router.tsx`, `shell/apps.ts`, Settings tabs | T8 |

## Pre-flight scan

| Pair / task | Produces vs consumes | Finding |
|---|---|---|
| T2↔T3 | T2 replaces `minutesSaved` in `steps.ts` while `tasks/service.ts` (T3) still calls it | conflict → Ruling AX-A |
| T2↔G1 | `G1_AGENTS_SHIPPED` flag location | consistent → Ruling AX-B |
| T8↔T11 | both could touch the top bar's `AgentsWorking.tsx` | conflict → Ruling AX-C |
| T5↔D1 | Front Desk success rate needs a definition over conversations | gap → Ruling AX-D |
| T4↔D1 | live tasks from D1's after-call and text jobs | consistent ([D1]) |
| T7↔S1/D1 | one-line pause checks in S1 and D1 files | consistent (T7 only) |

Ruling AX-A: Task 2 keeps `StepTypeDef.minutesSaved` as a compatibility function derived from `baseline` + `units` with default minutes; Task 3 switches `tasks/service.ts` to per-step snapshots and removes the field — typecheck stays green between merges — cost if wrong: none.
Ruling AX-B: `G1_AGENTS_SHIPPED = false` lives in `packages/shared/src/agents.ts`; G1 Task 15 flips it — cost if wrong: none.
Ruling AX-C: only Task 11 edits `shell/topbar/AgentsWorking.tsx` (link to `/agents/feed`); Task 8 leaves it — cost if wrong: none.
Ruling AX-D: Front Desk's success rate = conversations whose outcome is not `abandoned` and that had no model-failure hand-off, over the last 30 days, at least 5 — the spec defines it in words — cost if wrong: none.

## Waves (from the plan)

W1 T1 · W2 G1 = T2, T8 · W3 G2 = T3, T9, T10 · W4 G3 = T4, T5, T6 · G4 = T7, T11, T12 · W5 T13.

## Tasks

## Track lead log (Track C, a1-agents)

Base: `a1-agents` = `c1-crm` dfa9132 (C1 T1-T4 + F3 through T35). Upstream check at start: E1, S1, D1 integration branches are all still dfa9132 (nothing built); C1 T18 (router, `apps.ts` shipped flag, Settings tabs) is on `c1-t18`, not yet merged.

Ruling AX-E (track lead): the F1 demo step types (`demo_noop`, `demo_message`, `demo_spend`, 5 minutes each today) get a hidden baseline `demo` (5 min per unit, 1 unit per done step) marked `hidden: true`: it is not editable and not shown in "How we count time saved". Keeps every F1/F2 minutes test stable — cost if wrong: one hidden key.
Ruling AX-F (track lead): migrations are `0021_agents_schema.sql` (generated) and `0022_agents_grants_rls.sql` (custom) per Ruling AP; drizzle-kit generates them as 0015/0016 on this base, the builder renames the files, snapshots (`meta/0021_snapshot.json`, `meta/0022_snapshot.json`) and journal tags. Every plan/brief mention of 0020/0021 means 0021/0022 — cost if wrong: none.
Ruling AX-G (track lead): Task 1 does not edit `packages/shared/src/steps.ts`; Task 2 (same wave) adds `front_desk_call`/`front_desk_texts` to `STEP_TYPES`. Task 1 owns only `packages/db` (+ db barrels) and the event/status constants, which live in `packages/shared/src/agents.ts` only if T2 creates it — so T1 puts `AGENT_EVENT_KINDS`, `ACTOR_TYPES` and `AGENT_STATUSES_VIEW` in `packages/db/src/schema/enums.ts` and T2 re-exports nothing of them — cost if wrong: none.
Merge rule (E1/S1 step types): when `e1-estimator` or `s1-storm` merge into `a1-agents`, their new step types (`send_proposal`, `order_exact_report`, `send_email_batch`, `build_routes`, `create_ad_campaign`) are converted at merge to `baseline` + `units` (keys `proposal_sent`, `exact_report`, `email_sent`, `route_built`, `ad_campaign`), with `minutesSaved` removed once T3 lands.

### Wave 1 (2026-10-12): T1, T2 merged
- **T1** `a1-t1` 16d54dd → merged 1a67d96. Schema: `agent_task_steps` gains `baseline_key`, `units`, `minutes_per_unit`, `minutes_saved`; new tenant tables `time_baselines`, `agent_task_events` (SELECT/INSERT only), `agent_settings`, `time_recounts` (SELECT/INSERT only). Migrations `0021_agents_schema.sql` / `0022_agents_grants_rls.sql` (journal idx 15/16, tags 0021/0022). Enums `AGENT_EVENT_KINDS`, `ACTOR_TYPES`, `AGENT_STATUSES_VIEW` in `packages/db/src/schema/enums.ts`. Deviation: `time_recounts.to_at` NOT NULL (a recount range always has both ends). No column grant needed: 0002 grants app_tenant table-wide S/I/U on `agent_task_steps`; app_system cannot read the snapshot columns. CI run 38194518785 green (Platform incl. db suites, E2E, v1).
- **T2** `a1-t2` 527c7df → merged c7e4087. `shared/agents.ts` (`TIME_BASELINES`, hidden `demo` key per AX-E, `VISIBLE_BASELINE_KEYS`, `isEditableBaselineKey`, `minutesFor`, `G1_AGENTS_SHIPPED = false`), `shared/steps.ts` (`baseline` + `units`, `stepMinutes`, compat `minutesSaved` per AX-A, `front_desk_call` / `front_desk_texts` internal and `userCreatable: false`), `shared/metrics.ts` (`successRate`, `hoursLabel`, `moneyLabel`), `shared/agent-rules.ts` (`rulesFor`). CI run 38194526828 green.
- After the merge on a1-agents: npm ci, playwright-core only 1.56.1, typecheck, lint, lint:css, shared vitest 457/457 all green.
- Carried to later tasks (Opus group check):
  - T3: `minutes_saved` is the authoritative snapshot; `minutes_per_unit` is informational (rounded; for Front Desk steps it folds in bookings and call length). Round to 2 decimals before writing. T3 switches `createTask`'s step-type check to `isUserCreatableStepType` and removes `minutesSaved` (AX-A).
  - T7 recount: recompute from `units` + current baselines with the same `stepMinutes`, never `units × minutes_per_unit`.
  - UI tasks: `hoursLabel` already returns "about …"; callers add "(estimate)". `moneyLabel` returns "≈ $870"; callers add "(estimate)". The `metrics.ts` header comment says otherwise; fix it in T9.
  - T5/T8: if web needs `AGENT_STATUSES_VIEW`, move it to `shared/agents.ts` and import it in db enums.
  - Upstream merges (E1/S1/D1): keep the upstream journal entries first, renumber A1 idx after them, re-chain `0021_snapshot.prevId` to the last upstream snapshot, regenerate the 0021/0022 snapshots (drizzle-kit generate must then emit nothing).

### c1-crm merged; wave 2 launched (2026-10-12)
- `c1-crm` cd7d719 (C1 T5 API skeleton, T18 web skeleton; F3 complete) merged into a1-agents 1a84373, no conflicts. Journal: 0000-0014 then 0021/0022; `drizzle-kit generate` reports no changes. Local: typecheck, lint, lint:css, shared 457/457, web 437/437; playwright-core only 1.56.1.
- Wave 2 from 1a84373, Sonnet builders (Ruling AQ): T3 (task service, touches runner leases), T8 (router, dock, Settings tab).
Ruling AX-H (track lead): `tasks/service.ts` stays the single writer of events and step snapshots; `tasks/runner.ts` / `handlers.ts` change only to call new exported service functions for step outcomes, keeping the lease / run_seq / SKIP LOCKED guarantees. A runner that lost its lease writes neither a snapshot nor an event — cost if wrong: none.

### Wave 2 merged; wave 3 launched (2026-10-12)
- **T3** `a1-t3` 593459d → merged a00d054 (CI run 38199215197 green). Service writes one event per transition and step snapshots; `completeClaimedStep` / `completeParkedStep` / `expireOverdueTasks` wrappers in `tasks/service.ts` (runner, dispatcher and expire-drafts call them); repos `agent-events.ts`, `time-baselines.ts` (`loadBaselineOverrides`), `setStepSnapshot`, `sumStepMinutesSaved`; `StepTypeDef.minutesSaved` removed (AX-A done); `createTask` refuses non-user-creatable types. **New code must use the service wrappers, never the raw `finishClaimedStep` / `finishParkedStep`.**
- **T8** `a1-t8` d18c735 → merged 6eb308e (CI run 38199353996 green). Routes `/agents`, `/agents/feed`, `/agents/waiting`, `/agents/:agent` (slugs in `features/agents/slugs.ts`), dock Agents shipped, Settings `agents` tab (owner + office; hidden for reps), `copy/agents.ts`.
- After both merges on a1-agents: typecheck, lint, lint:css, shared 456/456, web 466/466; playwright-core only 1.56.1.
- Not fixed in T3, carried to T6 (Ruling AX-I below): a `finished` event is also written when a task lands in `needs_attention`, and `rerunTask` of an expired plan holding a non-creatable step now 400s. No backfill for steps done before 0021: there is no production data yet, so nothing to backfill; the T7 recount covers any later need.
- **Contract** `a1-contract` 05111fd (on a1-agents 6eb308e): `packages/shared/src/agents-api.ts`, the types-only JSON contract for `/api/agents/*` (cards, detail, feed, waiting, baselines, recount), plus the corrected `metrics.ts` / `agents.ts` header comments. Wave 3 branches from it; it reaches a1-agents with the first wave-3 merge (or on its own once its CI is green).
- Wave 3 (two runs): API T5, T6, T7 and web T9, T10, T11, all from 05111fd.

Ruling AX-I (track lead): T6 may edit `tasks/service.ts` for two fixes only: `finished` is written only when a task reaches a final status (done, partly_done, failed, declined is its own event), not on needs_attention; and `rerunTask` passes built-in step types through (internal callers may recreate non-user-creatable types; only API callers are refused) — cost if wrong: none.
Ruling AX-J (track lead): rep scope for every A1 aggregate and list = tasks whose subject is a job inside `jobScope(ctx)` (or a customer inside `customerScope(ctx)`); tasks with no subject or a storm subject count only for owner/office — cost if wrong: reps see less.
Ruling AX-K (track lead): until S1/D1 land on a1-agents, upstream facts are seams: T5's rule facts return `undefined` for a missing settings source (the rule sentence is then omitted) and Front Desk's success rate uses the task model (null with no runs); T7 exports `isAgentPaused(tx, ctx, agent)` and a `RUN_NOW` handler registry (Storm Scout's handler is registered when S1's storm-match job exists). Merge rule: when `s1-storm` / `d1-front-desk` merge into a1-agents, wire real facts (storm threshold/budget/days; Front Desk number, transfer list, can-move/cancel), AX-D's conversation-based Front Desk success rate, the two one-line pause checks (S1 `storm/settle.ts`, D1 `hooks/twilio-voice.ts`) and Storm Scout's run-now handler — cost if wrong: one follow-up task.

### Ruling AY (controller) and sentinel findings, 2026-10-12 03:40Z
- Journal `when` must strictly increase. On a1-agents today 0021/0022 (1791770537854, 1791770544508) are already above 0014 (1791765397507), so nothing is due yet. At the d1-front-desk merge, set them above 0020's value (the sentinel used 1791770805997 / 1791770806997). Edit the journal only; do not regenerate the SQL. The same merge does the journal fix (controller-approved): upstream entries first, A1 idx after them, 0021/0022 snapshots rebuilt on the upstream 0020, `drizzle-kit generate` reporting no changes. Restore any other track's `meta/00NN_snapshot.json` that drizzle-kit overwrites from origin. Reference: g1-agents Ruling GX-L.
- At the e1-estimator merge: `withMinutesSaved` no longer exists (T3 removed it per AX-A), so `send_proposal` / `order_exact_report` become plain `StepTypeDef`s with `userCreatable: true`, `baseline: () => 'proposal_sent'` / `'exact_report'`, `units: () => 1`, and no `minutesSaved`. S1's step types follow the same rule (email_sent, route_built, ad_campaign).
