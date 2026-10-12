# SDD ledger — plan: docs/superpowers/plans/2026-10-12-roofline-more-agents.md

Spec: docs/superpowers/specs/2026-10-12-roofline-more-agents-design.md. Branch `g1-agents`, to be created from `a1-agents` once A1 is merged (C1, E1, S1, D1 and A1 are not built yet). Rulings use the prefix **GX-**. Names marked **[C1]** / **[E1]** / **[S1]** / **[D1]** / **[A1]** come from those plans and briefs and must be checked against the merged branches before each task starts.

## Upstream dependencies

| From | Name G1 uses | G1 tasks |
|---|---|---|
| A1 T1/T2/T5/T7 | migrations end at `0021`; `TIME_BASELINES`, `rulesFor`, `G1_AGENTS_SHIPPED`, `agent_settings`, run-now/pause | T1, T2, T15 |
| A1 T8 | Settings → Agents tab, agent pages | T16, T17 |
| D1 T2/T4/T5 | guards, `Llm` + `ScriptedLlm`, the Anthropic adapter | T2, T3, T4 |
| D1 T7/T9 | `WeatherSource.daily`, `claim_intakes` | T6, T9 |
| D1 T14 / S1 T21 | inbound order in `hooks/twilio.ts` | T3 |
| S1 T1/T8/T9 | `storms`, `storm_hits`, `spotter_reports` | T7 |
| S1 SA/SD | per-customer render in `send-batch.ts`; approvals preview registry | T5, T17 |
| E1 T7/T8/T13 | measurements, proposals, `ObjectStore`/`storeFile`, `STORED_FILE_KINDS` | T1, T7, T13 |
| C1 T2/T3/T8/T9/T16/T20 | `isStuck`, availability, appointments, `PDF_COLORS`, `JobSections.tsx` | T7, T8, T10–T13, T16 |

## Pre-flight scan

| Pair / task | Produces vs consumes | Finding |
|---|---|---|
| T3↔S1/D1 | claims hook position among the inbound handlers | gap → Ruling GX-A |
| T3↔T4 | new `Llm` methods: interface + fake in T3, adapter in T4 | consistent → Ruling GX-B |
| T16↔C1/E1 | `features/job/JobSections.tsx` already edited by C1 T20 and E1 T20 | consistent → Ruling GX-C |
| T7↔config | the claim packet's static map needs a server MapTiler key; only the browser key exists (`mapStyle.ts`) | gap → Ruling GX-D |
| T15↔A1 | A1 treats a missing `agent_settings` row as "on"; G1 agents must start paused | conflict → Ruling GX-E |
| T16 waves | the plan puts T16 in W3, but it depends on T6 (W4) | conflict → Ruling GX-F |
| T9↔F2 | NWS fixtures `nws-hourly.json`, `nws-points.json` already exist | consistent |

Ruling GX-A: the claims-reply hook goes in `hooks/twilio.ts` after S1's `onStormReply` and before D1's Front Desk call; Task 3 makes that one edit — cost if wrong: none.
Ruling GX-B: Task 3 adds `draftTexts`/`extractClaimReply` to D1's `Llm` interface and `ScriptedLlm`; Task 4 implements them in `providers/anthropic/` with the Anthropic TypeScript SDK (D1 Ruling DA) — cost if wrong: none.
Ruling GX-C: Task 16 adds `ClaimSection.tsx` and one line in `JobSections.tsx`, nothing else in `features/job/` — cost if wrong: none.
Ruling GX-D: Task 3 adds optional `MAPTILER_SERVER_KEY`; without it the claim packet omits the map image (owner item: a server-side MapTiler key) — cost if wrong: a packet without a map.
Ruling GX-E: for `claims`, `scheduler` and `follow_up`, a missing `agent_settings` row means paused (`isPaused(agent, row)` in `shared/agents.ts`, Task 15); launch agents keep "missing = on" — spec Decision 1 — cost if wrong: none.
Ruling GX-F: Task 16 runs in W7 beside Task 15 (after T6's API), not in W3 — cost if wrong: none.

## Waves (from the plan, with GX-F)

W1 T1 · W2 T2 · W3 G1 = T3, T17 · W4 G2 = T4, T5, T6 · G3 = T9, T7 · W5 G4 = T8, T10, T13 · W6 G5 = T11, T12, T14 · W7 T15, T16 · W8 T18.

## Tasks

## Ruling AP (controller, 2026-10-12)
Migration numbers override this plan and these briefs: F3 ends at 0012; C1 0013/0014; E1 0015/0016; S1 0017/0018; D1 0019/0020; A1 0021/0022; G1 0023/0024. Parallel tracks: see AGENTS.md.

## Track lead log (Track C, g1-agents; lead session_01NbXKpWjMvEQwTqNmQCt6wp)

Base: `g1-agents` = `a1-agents` 74367bf (= `c1-crm` dfa9132 + A1 ops). Upstream check at start (2026-10-12): A1, D1, S1 and E1 have built nothing yet (their task branches are in flight); C1 has T1–T4 (schema incl. `appointments`, `company_settings`, `APPOINTMENT_STATUSES` with `no_show`). Not present yet: `STORED_FILE_KINDS` [E1], `WeatherSource.daily` [D1] (`current` exists), `Llm`/guards [D1], `agent_settings`/`TIME_BASELINES` [A1], A1's `steps.ts` baseline/units rewrite.

Ruling GX-G (track lead): G1's migrations are `0023_more_agents_schema.sql` (generated) and `0024_more_agents_grants_rls.sql` (custom) per Ruling AP; drizzle-kit generates them with lower numbers on this base, so the builder renames the files, snapshots (`meta/0023_snapshot.json`, `meta/0024_snapshot.json`) and journal tags. Every plan/brief mention of 0022/0023 means 0023/0024. The controller fixes journal order when tracks merge — cost if wrong: none.
Ruling GX-H (track lead): Task 1 does not edit `packages/shared/src/steps.ts` (A1 T2 is rewriting it) and does not add `claim_packet` to `STORED_FILE_KINDS` (E1 has not built it). Task 2 adds the four step types after A1 T2 lands; Task 7 adds `claim_packet` after E1 T13 lands. Task 1 puts `CLAIM_STATUSES`, `CLAIM_EVENT_ACTORS` and `FOLLOW_UP_KINDS` in a new `packages/shared/src/more-agents.ts` (shared barrel), which Task 2 then extends — cost if wrong: none.
Ruling GX-I (track lead): Task 2 is split. **T2a** (`more-agents.ts` pure rules: `followUpAllowed`, the `…Due` rules, `weatherRisk`, `CLAIM_STATUS_FLOW`) runs as soon as T1 is merged; **T2b** (the four step types and `claimsGuard`) waits for A1 T2 (`steps.ts` baseline/units) and D1 T2 (guards) — cost if wrong: one extra task commit.
Ruling GX-J (track lead): Task 9 runs in wave 1 (it touches only `apps/api/src/weather/*` and its tests). It adds `hourly` to the existing `WeatherSource` (`current` today). When D1 T7 adds `daily` to the same interface and `nws.ts`, the merge keeps both methods (and both fakes' methods) — cost if wrong: one small merge conflict.

Waves as run by the track lead: W1 T1 (builder sonnet: migrations and RLS), T9 · W2 T2a · then upstream-gated tasks as A1/D1/S1/E1/C1 land.

### Wave 1 (wf_22488f17-88e, contact 601; T2a wf_42e95c6c-46a, contact 611)
- Ruling AS (controller): GitHub Actions was down 02:18–02:27Z; wave 1 was rebuilt with ci-check off, then CI came back and each branch was ci-checked by the track lead before merging.
- Task 9: complete (5d970d2..d0be416), review clean, CI 38196025391 green. Merged into g1-agents (d623a46). Notes: `nws-hourly.json` has no `windGust`, so T9 added `nws-hourly-forecast.json`; `hourly` is uncached (T11 groups appointments by rounded lat/lng before calling it). Carry: `HourlyForecast` is declared in both `apps/api/src/weather/source.ts` (T9) and `packages/shared` (T2a); after T2a merges, source.ts re-exports the shared type (follow-up commit on g1-agents).
- Task 1: built 15f674b (review clean, `drizzle-kit generate` reports no changes). CI 38196019716 failed: 0023 created `follow_up_log_company_message_fk` before `messages_company_id_id_uniq` (42830). Fixed by the track lead in 4c65fbe (unique moved before the FKs); CI 38196604020 green. Task 1: complete (5d970d2..4c65fbe). Merged into g1-agents.
- Carry (merge rule, A1/D1 land): `_journal.json` keeps all upstream entries, then 0023/0024 appended after 0022 with fresh idx; `meta/0023_snapshot.json`/`0024_snapshot.json` are regenerated from the merged schema (not hand-merged); `drizzle-kit generate` must then report no changes. The weather files (source.ts, test/helpers.ts FakeWeatherSource, test/weather.test.ts inline sources) merge as a union: `current`, `daily`, `hourly`.
- Carry to T2b: the four step types, `claim_packet` in STORED_FILE_KINDS (T7), and the D1 `claim_intakes` promotion (T6) were not checked against merged code (not built yet).
- Task 2a: built c69f177 (review clean, brief by the track lead: `ops/sdd/g1/task-2a-brief.md`). Group check found three real gaps in the brief, fixed by the track lead in e79ac51: (1) Decision 8's 3-day per-customer spacing now spans proposal, lead, review AND claims (claims keep the extra 4-day and 4-per-claim limits); (2) `weatherRisk(hourly, workHours: WorkHours, thresholds, timeZone)` uses C1's per-weekday `WorkHours` via `workIntervals` (a forecast hour counts when it overlaps a work interval), replacing the builders' single start/end `LocalWorkHours`; (3) `ProposalFacts.callRepAt` makes 'call_rep' asked once. The code lives in `packages/shared/src/{follow-up-rules,weather-claim-flow}.ts`, re-exported by `more-agents.ts` (T2b, T5, T11, T13 look there). Restacked on g1-t1 4c65fbe (38b8d2b); CI 38196697937 green. Task 2a: complete (15f674b..38b8d2b). Merged into g1-agents.

### Merge of d1-front-desk (D1 Task 1) into g1-agents
Ruling GX-K (controller, recorded by the track lead): D1's 0019 already adds `messages_company_id_id_uniq` UNIQUE(company_id, id) (for `calls.text_back_message_id`). D1 is upstream of G1, so G1's 0023 no longer adds it: the merge took D1's journal and snapshots, regenerated G1's schema migration from the merged schema (`drizzle-kit generate`, renamed to `0023_more_agents_schema.sql` / `meta/0023_snapshot.json`; the only difference from the pre-merge 0023 is the removed messages unique), rebuilt `meta/0024_snapshot.json` (0023's snapshot with a fresh id, prevId = 0023's id) and appended both journal entries after D1's 0020 (idx 17, 18). `drizzle-kit generate` reports no changes. Conflicts resolved as unions (enums.ts, shared barrel, TENANT_TABLES, company_settings columns and checks, appointments columns, the D1 and G1 "tables are tenant tables" tests); `schema/tenant.ts` was rebuilt from D1's file plus G1's additions — cost if wrong: none.
- g1-md1 (merge of d1-front-desk, D1 T1): CI 38197771758 green; fast-forwarded into g1-agents (d62b6a7).
- g1-hf (apps/api weather source re-exports the shared `HourlyForecast`): CI 38197561670 green; merged.

### Merge of d1-front-desk (D1 T2, T3) and a1-agents (A1 T1, T2) into g1-agents (work branch g1-md1b)
Ruling GX-L (track lead): the migration chain on g1-agents is F3 … 0014, D1 0019/0020, A1 0021/0022, G1 0023/0024 (journal idx 15–20, `when` strictly increasing: A1's `when` values were moved after D1's so drizzle's migrator, which applies entries newer than the last applied `when`, never skips A1 on a database that already has D1). A1's snapshots were rebuilt on D1's: `meta/0021_snapshot.json` = D1's 0020 snapshot plus A1's own changes (A1 0021 minus 0014; no overlaps or deletions), prevId = D1 0020's id; 0022 = 0021 with A1's id. G1's 0023 was then regenerated by `drizzle-kit generate` and came out identical to the pre-merge 0023 (which proves the rebuilt chain matches the schema); 0024's snapshot rebuilt; `drizzle-kit generate` reports no changes. Hazard found: drizzle-kit names a generated snapshot by its next free number, which here was `0019` and overwrote D1's `meta/0019_snapshot.json`; it was moved to 0023 and D1's restored from origin. Schema conflicts resolved by rebuilding `schema/tenant.ts` (G1+D1 file plus A1's imports, TENANT_TABLES entries, agent_task_steps columns and four tables); rls.test.ts: `SELECT_INSERT_ONLY` = audit_log, agent_task_events, time_recounts, conversation_turns; DELETE tables include blocked_numbers — cost if wrong: one CI round.
- g1-md1b (D1 T2/T3 + A1 T1/T2 merges): CI 38198923179 green; fast-forwarded into g1-agents (7f49765).
Ruling GX-A (confirmed by the controller, amending cross-track Ruling AV): inbound text order in `apps/api/src/hooks/twilio.ts` after the message is stored is S1 `onStormReply` → **G1 claims** (self-contained block marked `// G1 Agents`; acts only when the customer had a claims text in the last 7 days, otherwise passes through; when it consumes a reply it calls D1's path itself for "Thanks, got it." or the continuation) → D1 `queueFrontDeskText`. Merge rule: keep all blocks, in that order — cost if wrong: one hand-ordered merge hunk.
