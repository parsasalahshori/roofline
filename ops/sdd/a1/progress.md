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
