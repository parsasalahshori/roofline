# Roofline Claims, Scheduler and Follow-up Agents (G1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. In this repo the team script runs each task with one Sonnet lead and up to three Haiku builders on the **Split** packages.

**Goal:** Three drafting agents on the R2 pattern — Claims (claim record, claim packet PDF, homeowner nudges, reply extraction, adjuster appointments), Scheduler (tomorrow's reminders, crew agendas, weather watch with install moves, no-show rebooking) and Follow-up (unsigned proposals, unbooked leads, stuck-job nudges, review requests) — starting paused and shown live on the A1 Agents screen.

**Architecture:** Task 1 (schema, skeleton), Task 2 (shared steps, rules, limits), Task 3 (API skeleton: jobs, schedules, `Llm` additions, step handler stubs, hook order), then one lane per agent, then web and e2e. Drafting uses `claude-opus-5-5` through D1's `Llm` seam (new `draftTexts`), extraction `claude-haiku-5-5` (new `extractClaimReply`); both faked by `ScriptedLlm`.

**Tech Stack:** as A1. No new npm packages.

**Spec:** `docs/superpowers/specs/2026-10-12-roofline-more-agents-design.md`. Parents: master §2, §5.3, §8 row 7, §9; F1–F3, C1, E1, S1, D1, A1.

**Branch:** integration branch `g1-agents` from `a1-agents` once A1 is merged; task branches `g1-t<N>`.

---

## Global Constraints

- Everything in the earlier milestones' Global Constraints applies.
- **Customer texts only via `send_personal_texts` steps in approved tasks**, through the gate; the only automatic outbound items are staff agenda emails, rep nudges and Front Desk's "Thanks, got it." reply (D1 path).
- **Every drafted text passes D1's guards plus the claims guard list** before it is stored in a payload, and again at send time.
- **No code path addresses an insurer or adjuster** (no adjuster phone/email used as a recipient; a test greps the send paths).
- **Limits live in one shared function** (`followUpAllowed`) used by all three agents.
- **Lockfile:** untouched. **Migrations:** only Task 1 (`0022` generated, `0023` custom).

## Review Focus

1. **Stop conditions and spacing** (Decisions 7, 8): replies, signatures, bookings, Lost; per-customer and cross-agent limits. (Tasks 2, 13)
2. **Claims boundaries** (Decision 4): no coverage/deductible language; no insurer contact. (Tasks 2, 8)
3. **Consent:** reminders/nudges informational; review requests marketing only. (Tasks 5, 14)
4. **Weather moves:** proposals only, crew availability respected, customers told only after approval. (Task 11)

---

## Parallel lanes

| Task | Depends on | Notes |
|---|---|---|
| 1 Schema, migrations, skeleton | — | |
| 2 Shared steps, rules, limits, guards | 1 | `shared/steps.ts`, `shared/more-agents.ts` |
| 3 API skeleton: jobs, schedules, `Llm` additions, hook order | 1, 2 | `app.ts`/`deps.ts`/`jobs/*`/`tasks/handlers.ts`/`hooks/twilio.ts` |
| 4 Anthropic: `draftTexts` and `extractClaimReply` | 3 | `providers/anthropic/*` |
| 5 `send_personal_texts` handler | 3 | |
| 6 Claims record and API | 3 | |
| 7 Claim packet PDF and `build_claim_packet` | 6 | |
| 8 Claims nudges, reply extraction, `create_appointment` | 4, 5, 6 | |
| 9 NWS hourly forecast | 3 | `weather/*` |
| 10 Scheduler: reminders and crew agendas | 4, 5 | |
| 11 Scheduler: weather watch and `move_appointment` | 9, 10 | |
| 12 Scheduler: no-shows | 10 | |
| 13 Follow-up: finder, drafting, daily task, stuck nudges | 4, 5 | |
| 14 Follow-up: review requests | 13 | |
| 15 A1 integration: baselines, rules, Run now, pause, shipped flag | 8, 11, 13 | `shared/agents.ts`, `agents/*` |
| 16 Web: Claim section and claims board | 6 | |
| 17 Web: review previews for the new steps; Settings → Agents values | 2 | |
| 18 Evals, end-to-end and acceptance | 7–17 | evals by hand |

**Waves:** W1 T1 · W2 T2 · W3 G1 = T3, T16, T17 · W4 G2 = T4, T5, T6 · G3 = T9, T7 · W5 G4 = T8, T10, T13 · W6 G5 = T11, T12, T14 · W7 T15 · W8 T18.

---

## File structure

```
packages/db/migrations/0022_more_agents_schema.sql 0023_more_agents_grants_rls.sql      T1
packages/db/src/repos/ claims.ts (T6) follow-up-log.ts (T5, T13) scheduler.ts (T10–T12) follow-up-finder.ts (T13)
packages/shared/src/ more-agents.ts (T2) steps.ts (T2 edits) agents.ts (T15 edits)
apps/api/src/agents/ claims/{packet,nudges,replies}.ts scheduler/{reminders,agenda,weather,no-shows}.ts followup/{finder,draft,reviews}.ts personal-texts.ts appointments-steps.ts
apps/api/src/providers/anthropic/{draft-texts,extract-claim}.ts (T4)  apps/api/src/weather/nws.ts (T9)
apps/api/src/routes/claims.ts (T6)
apps/web/src/features/job/ClaimSection.tsx  features/agents/ClaimsBoard.tsx (T16)
apps/web/src/features/approvals/steps/{PersonalTexts,ClaimPacket,CreateAppointment,MoveAppointment}Preview.tsx (T17)
apps/web/src/features/settings/AgentRules.tsx (T17)
apps/web/e2e/more-agents.spec.ts  docs/superpowers/g1-acceptance.md (T18)
```

---

### Task 1: Schema, migrations, skeleton

**Split:** Builder 1 schema + `0022` (spec §6); Builder 2 `0023` grants/RLS + tests; Builder 3 placeholders, barrels, constants (`CLAIM_STATUSES`, `FOLLOW_UP_KINDS`, `STEP_TYPES` gains `send_personal_texts`, `build_claim_packet`, `create_appointment`, `move_appointment`; `STORED_FILE_KINDS` gains `claim_packet`).
- [ ] **Tests:** tenant tables with RLS forced; one claim per job; grants.
- [ ] **Commit:** `feat(db): G1 schema (claims, claim events, follow-up log, agent settings)`

### Task 2: Shared steps, rules, limits, guards

**Split:** Builder 1 four step types (payloads, validation, previews, A1 baselines `claim_packet` 30, `reminder_sent` 1, `install_moved` 10, `follow_up_sent` 2); Builder 2 `more-agents.ts`: `followUpAllowed({ log, kind, customerId, now, lastInboundAt, lastStormTextAt })`, `proposalFollowUpDue`, `leadFollowUpDue`, `claimNudgeDue`, `weatherRisk(hourly, workHours, thresholds)`, `CLAIM_STATUS_FLOW`; Builder 3 `claimsGuard` (extends D1 guards: deductible, coverage, "free roof" with insurance) + tests.
- [ ] **Commit:** `feat(shared): G1 step types, follow-up limits, weather risk and claims guards`

### Task 3: API skeleton

**Split:** Builder 1 jobs `claims-daily`, `scheduler-reminders`, `scheduler-agenda`, `scheduler-weather`, `followup-daily` (per company, fan-out schedules `*/15 * * * *` that fire each company at its local hour), step handler stubs; Builder 2 `Llm` gains `draftTexts(i: { instruction: DraftKind; facts: JobFacts[] }) → { texts: { jobId, body }[] }` and `extractClaimReply(text) → ClaimReplyFacts` (+ `ScriptedLlm` support); Builder 3 `hooks/twilio.ts` order (claims replies hook between S1 and D1, stub) + tests.
- [ ] **Commit:** `feat(api): G1 skeleton — agent jobs, drafting and extraction seams, inbound order`

### Task 4: Anthropic `draftTexts` and `extractClaimReply`

Opus 5.5 (`output_config: { effort: 'low', format: json_schema }`, `fallbacks: 'default'`, cached instructions per draft kind, ≤ 25 jobs per request) and Haiku 5.5 extraction (structured output); fixtures; tests (request bodies, parsing, refusal → template fallback signal).
- [ ] **Commit:** `feat(api): Claude drafting for agent texts and claim-reply extraction`

### Task 5: `send_personal_texts` handler

Lease loop (first statement `if (!(await lease.keep())) return { status: 'running', result: {} };`), guard re-check, gate per message, `follow_up_log` row per sent text, result `{ sent, blocked: {rule: n}, scheduled }`; tests.
- [ ] **Commit:** `feat(api): personal texts step — one gated text per customer`

### Task 6: Claims record and API

**Split:** `repos/claims.ts` (promote D1 intakes, status changes with `claim_events`), `routes/claims.ts` (`GET/PUT /api/jobs/:id/claim`, `GET /api/claims?status=` board), role scope; tests.
- [ ] **Commit:** `feat(api): insurance claim records on jobs`

### Task 7: Claim packet PDF

**Split:** Builder 1 facts gathering (S1 hail at home on date of loss, spotter reports ≤ 10 miles, E1 measurement, inspection, intake); Builder 2 PDF layout with C1's renderer + static map image (MapTiler static API through a small `StaticMap` seam with a fake); Builder 3 `build_claim_packet` handler → R2 + `stored_files`, download route; tests (text extraction asserts the "Radar-estimated" line and measurement label).
- [ ] **Commit:** `feat(api): claim packet PDF with storm evidence and measurements`

### Task 8: Claims nudges, replies, adjuster appointments

**Split:** Builder 1 `nudges.ts` daily task (spec §3.3 rules, `draftTexts`, guards, limits); Builder 2 `replies.ts` (7-day window, extraction, live claim update task, D1 continuation or "Thanks, got it."); Builder 3 `create_appointment` handler (availability check, C1 calendar push) + tests.
- [ ] **Commit:** `feat(api): Claims agent — nudges, reply extraction and adjuster visits`

### Task 9: NWS hourly forecast

`WeatherSource.hourly(lat, lng, hours)` → `{ at, precipPct, gustMph }[]` from NWS gridpoint forecast hourly; null on failure; fake fixtures; tests.
- [ ] **Commit:** `feat(api): hourly forecast for the weather watch`

### Task 10: Scheduler — reminders and crew agendas

**Split:** reminders daily task (`send_personal_texts`, expiry 9 PM); crew agenda emails at 6 PM (Mailer; no approval; opt-out per member); tests.
- [ ] **Commit:** `feat(api): Scheduler — tomorrow's reminders and crew agendas`

### Task 11: Scheduler — weather watch and `move_appointment`

**Split:** risk scan (Task 9 + `weatherRisk`), next clear free day for the crew (C1 availability all-day + forecast), task with `move_appointment` + customer texts; `move_appointment` handler (re-check, C1 calendar push, `moved_by_task_id`); tests.
- [ ] **Commit:** `feat(api): Scheduler — propose moving installs before bad weather`

### Task 12: Scheduler — no-shows

No-show → draft text with two times; tests.
- [ ] **Commit:** `feat(api): Scheduler — rebook no-shows`

### Task 13: Follow-up — finder, drafting, daily task, stuck nudges

**Split:** `repos/follow-up-finder.ts` (proposals, leads, stuck jobs with stop conditions); `followup/draft.ts` (Opus drafting, guards, template fallback); daily task assembly + rep nudges (in-app + Today next step); tests.
- [ ] **Commit:** `feat(api): Follow-up agent — proposals, leads and stuck jobs`

### Task 14: Follow-up — review requests

Installed + `review_delay_days`, once per job, marketing consent only, company name + STOP, no gating; settings; tests.
- [ ] **Commit:** `feat(api): review requests after installs, with marketing consent`

### Task 15: A1 integration

Rules sentences for the three agents, Run now wiring, pause honoured by each daily job (start paused on first deploy: `agent_settings` rows inserted paused for existing companies in a data step of this task's code, not a migration), `G1_AGENTS_SHIPPED = true`; tests.
- [ ] **Commit:** `feat(agents): Claims, Scheduler and Follow-up live on the Agents screen, starting paused`

### Task 16: Web — Claim section and claims board

`ClaimSection.tsx` in the job window (status, fields, history, packet build/download), `ClaimsBoard.tsx` on the Claims agent page; tests.
- [ ] **Commit:** `feat(web): claim section on jobs and the claims board`

### Task 17: Web — review previews and Settings → Agents values

Previews for the four steps (personal texts list with per-message Edit and remove; packet; appointment; move with forecast reason) and `AgentRules.tsx` settings form; tests.
- [ ] **Commit:** `feat(web): review G1 drafts and set each agent's rule values`

### Task 18: Evals, end-to-end and acceptance

`scripts/eval-agent-texts.ts` (`--confirm-spend`, spec §9 evals), `apps/web/e2e/more-agents.spec.ts` (turn on Follow-up, Run now, approve the task, texts sent via fake SMS; claim section and packet; weather move review), `docs/superpowers/g1-acceptance.md`.
- [ ] **Commit:** `test: G1 evals by hand, end-to-end and acceptance map`

---

## Rulings

1. **Migrations 0022/0023 only in Task 1;** no dependency changes.
2. **`shared/steps.ts` only in Task 2; `shared/agents.ts` only in Task 15; `hooks/twilio.ts` only in Task 3** (the hook order; Task 8 fills the claims hook body in its own file).
3. **Templates are the fallback, not an alternative:** when `draftTexts` fails or refuses, the task is drafted from templates and says "Written from a template".
4. **Standing approvals are not built** (owner decision pending); every customer text needs an approval.
