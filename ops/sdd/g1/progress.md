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
