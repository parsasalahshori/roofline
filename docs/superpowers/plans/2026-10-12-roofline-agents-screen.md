# Roofline Agents Screen (A1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. In this repo the team script runs each task with one Sonnet lead and up to three Haiku builders on the **Split** packages.

**Goal:** The Agents window: one card per agent with finished-today, success rate, time saved (an honest estimate from owner-editable baselines snapshotted per step) and a 14-day chart; agent pages with plain-English rules, pause and Run now; an activity feed from a new event table; a "waiting on a person" list; Front Desk counted as live tasks.

**Architecture:** Task 1 (schema, skeleton), Task 2 (shared baselines, metrics and rule sentences), Task 3 (the task service — the single writer of events and step snapshots), then API read models and web. No new providers or dependencies.

**Tech Stack:** as D1. No new npm packages.

**Spec:** `docs/superpowers/specs/2026-10-12-roofline-agents-screen-design.md`. Parents: master §5.1, §5.3, §8 row 6, §14; F1–F3; E1; S1; D1.

**Branch:** integration branch `a1-agents` from `d1-front-desk` once D1 is merged; task branches `a1-t<N>`.

---

## Global Constraints

- Everything in the earlier milestones' Global Constraints applies.
- **Every time-saved number comes from step snapshots** (`agent_task_steps.minutes_saved`); no read model recomputes minutes from current baselines (except the explicit recount, Task 7).
- **"about" and "(estimate)"** accompany every time or money saved figure in the UI (a copy test enforces it on the components that show them).
- **Feed data never stores message text or customer names in `agent_task_events.data`** — counts and ids only; names are joined at read time under the reader's role scope.
- **Lockfile:** untouched. **Migrations:** only Task 1 (`0020` generated, `0021` custom).

## Review Focus

1. **Honest numbers:** only done steps with result units; caps; snapshot at completion; recount only by the owner, audited. (Tasks 2, 3, 7)
2. **One writer:** `tasks/service.ts` writes every event and snapshot; no other module inserts events. (Task 3)
3. **Role scope in aggregates:** reps' feed and cards count only their jobs' work; company totals for owner/office. (Tasks 5, 6)
4. **Pause semantics:** paused agents start nothing new; running work finishes. (Task 7)

---

## Parallel lanes

| Task | Depends on | Notes |
|---|---|---|
| 1 Schema, migrations, skeleton | — | |
| 2 Shared baselines, metrics, rule sentences | 1 | `shared/agents.ts`, `shared/steps.ts` |
| 3 Task service: events and step snapshots | 1, 2 | `tasks/service.ts` only here |
| 4 Front Desk live tasks | 3 | D1 `after-call.ts`, `texts.ts` |
| 5 Cards, agent detail and chart API | 3 | |
| 6 Feed and waiting API | 3 | |
| 7 Baselines settings, recount, pause, Run now | 3 | |
| 8 Web skeleton | 2 | |
| 9 Web: Agents window | 8 | |
| 10 Web: agent page | 8 | |
| 11 Web: feed and waiting | 8 | |
| 12 Web: "How we count time saved" | 8 | |
| 13 End-to-end and acceptance | 4–12 | |

**Waves:** W1 T1 · W2 G1 = T2, T8 · W3 G2 = T3, T9, T10 · W4 G3 = T4, T5, T6 · G4 = T7, T11, T12 · W5 T13.

---

## File structure

```
packages/db/migrations/0020_agents_schema.sql 0021_agents_grants_rls.sql                T1
packages/db/src/repos/ agent-events.ts (T3) agent-metrics.ts (T5) agent-feed.ts (T6) time-baselines.ts agent-settings.ts (T7)
packages/shared/src/ agents.ts (T2) steps.ts (T2 edits)
apps/api/src/tasks/service.ts (T3)   apps/api/src/agents/ rules.ts run-now.ts recount.ts (T7) metrics.ts (T5)
apps/api/src/routes/agents.ts (T5–T7)  apps/api/src/front-desk/{after-call,texts}.ts (T4 edits)
apps/web/src/features/agents/ (T9–T12)  apps/web/src/copy/agents.ts
apps/web/e2e/agents.spec.ts (T13)  docs/superpowers/a1-acceptance.md (T13)
```

---

### Task 1: Schema, migrations, skeleton

**Split:** Builder 1 schema + `0020`; Builder 2 `0021` grants/RLS + tests; Builder 3 placeholders, barrels, constants (`AGENT_EVENT_KINDS = ['created','approved','partly_approved','declined','step_done','step_failed','step_attention','finished','expired'] as const`, `AGENT_STATUSES_VIEW = ['on','paused','waiting','coming_soon'] as const`, `STEP_TYPES` gains `'front_desk_call'`, `'front_desk_texts'`).
- **Tables/columns:** spec §8. Grants: tenant SELECT/INSERT on `agent_task_events` (no UPDATE/DELETE), SELECT/INSERT/UPDATE on `time_baselines`, `agent_settings`, INSERT/SELECT on `time_recounts`; UPDATE on the four new step columns.
- [ ] **Tests:** tenant tables, RLS forced, grants; events immutable for `app_tenant`.
- [ ] **Commit:** `feat(db): A1 schema (step time snapshots, baselines, agent events and settings)`

### Task 2: Shared baselines, metrics and rule sentences

**Split:** Builder 1 `agents.ts` baselines and `minutesFor`; Builder 2 `steps.ts` refactor (each step type's `minutesSaved` replaced by `baseline` + `units(payload, result)`; new `front_desk_call`/`front_desk_texts` types, `internal`, not user-creatable); Builder 3 metrics helpers, rule sentence builders, tests.

**Interfaces:**
```ts
export const TIME_BASELINES = { text_sent: { minutes: 1.5, capMinutes: 120, unit: 'text', basis: '…' }, email_sent: …, route_built: …, ad_campaign: …, proposal_sent: …, exact_report: …, call_answered: { minutes: 2, perCallLength: true }, spam_call: { minutes: 0, perCallLength: true }, booking: …, text_reply: … } as const;   // spec §3.1
export type BaselineKey = keyof typeof TIME_BASELINES;   // G1 extends the object in its own task
export function minutesFor(key: BaselineKey, units: number, overrides: Partial<Record<BaselineKey, number>>, extra?: { callMinutes?: number }): { minutesPerUnit: number; minutes: number };
export function successRate(i: { done: number; partlyDone: number; ran: number }): number | null;   // null under 5
export function hoursLabel(minutes: number): string;   // 'about 31 hours' / 'about 4.5 hours'
export function moneyLabel(minutes: number, hourlyRateCents: number): string;   // '≈ $870'
export type RuleSentence = { text: string; links: { label: string; href: string }[] };
export function rulesFor(agent: Agent, s: AgentRuleFacts): RuleSentence[];   // spec §6 examples; facts gathered by the API
```
- [ ] **Tests:** table defaults; caps; overrides; units from results (sent counts only); every step type has a baseline; labels; success rate edge cases; rule sentences for each launch agent.
- [ ] **Commit:** `feat(shared): time-saved baselines, success rate and plain-English agent rules`

### Task 3: Task service — events and step snapshots

**Split:** Builder 1 snapshot on step `done` (units from result, the company's override or default, minutes; task `minutes_saved` = sum of step snapshots); Builder 2 `repos/agent-events.ts` + an event at each transition in `tasks/service.ts` (create, approve/partial, decline, step done/failed/attention, finish, expire); Builder 3 tests.
- [ ] **Tests:** each transition writes exactly one event with actor; snapshot uses the override at that moment; later override change leaves old snapshots; F1/F2 task tests stay green.
- [ ] **Commit:** `feat(api): task events and per-step time-saved snapshots`

### Task 4: Front Desk live tasks

**Split:** Builder 1 `after-call.ts` → `createLiveTask(…)` (kind `call`, step `front_desk_call` result `{ seconds, bookings, spam }`, status `needs_attention` when a message follow-up is open; closes to `done` when the follow-up job's next step is cleared — hook in C1's next-step update via an event listener in `agents/front-desk-tasks.ts`); Builder 2 `texts.ts` → one live task per text conversation per day (`front_desk_texts`, result `{ replies, bookings }`); Builder 3 tests.
- [ ] **Tests:** one task per call (idempotent on call id); spam call minutes = call length; live tasks never in "need your OK"; follow-up cleared → task done.
- [ ] **Commit:** `feat(api): Front Desk calls and texts counted as live agent tasks`

### Task 5: Cards, agent detail and chart API

**Split:** Builder 1 `repos/agent-metrics.ts` (finished today, 30-day success inputs, minutes by period, 14-day series, by baseline; role-scoped); Builder 2 `agents/metrics.ts` + `GET /api/agents`, `GET /api/agents/:agent`; Builder 3 rules facts gathering (settings of S1, E1, D1) + tests.
- [ ] **Tests:** numbers from seeded tasks; rep scope; G1 agents return `coming_soon` until their flag (`G1_AGENTS_SHIPPED` in shared, false); company B isolation.
- [ ] **Commit:** `feat(api): agent cards, detail, chart and time breakdown`

### Task 6: Feed and waiting API

**Split:** Builder 1 `repos/agent-feed.ts` (events joined to tasks and subjects, cursor paging, agent filter, role scope); Builder 2 `GET /api/agents/waiting` (drafts by approver class, attention tasks, open Front Desk follow-ups, who it waits on); Builder 3 plain sentences per event kind in `agents/feed-text.ts` (copy constants) + tests.
- [ ] **Commit:** `feat(api): agent activity feed and the waiting-on-a-person list`

### Task 7: Baselines settings, recount, pause, Run now

**Split:** Builder 1 `GET/PUT /api/agents/time-baselines` (owner edits, office reads) + `recount.ts` (owner; last 90 days; one transaction per 1,000 steps; `time_recounts` + audit log); Builder 2 `PUT /api/agents/:agent/paused` + honouring it: S1 `storm/settle.ts` skips drafting when paused, D1 `twilio-voice.ts` treats paused like Front Desk off (two one-line checks, owned here); Builder 3 `POST /api/agents/:agent/run` (Storm Scout → `storm-match-company` now; others 409 "This agent works when you ask"; 5-minute limit via `last_run_now_at`) + tests.
- [ ] **Commit:** `feat(api): editable time baselines with an audited recount, agent pause and Run now`

### Task 8: Web skeleton

**Split:** routes `/agents`, `/agents/:agent`, `/agents/feed`, `/agents/waiting`; dock flag `agents` shipped; Settings → Agents slot; `copy/agents.ts`; route tests.
- [ ] **Commit:** `feat(web): routes and slots for the Agents screen`

### Task 9: Web: Agents window

**Split:** Builder 1 `AgentCard.tsx` (numbers, status chip, "Coming soon" variant); Builder 2 `MiniChart.tsx` (SVG bars + hidden table); Builder 3 `AgentsWindow.tsx` (grid, totals line "About 31 hours saved this month (estimate) · ≈ $870", info popover) + tests.
- [ ] **Commit:** `feat(web): Agents window with honest time-saved estimates`

### Task 10: Web: agent page

**Split:** rules list with links, pause switch with confirm, Run now with cooldown text, recent tasks (open in F2 review), time breakdown table by baseline; tests.
- [ ] **Commit:** `feat(web): agent page with plain-English rules, pause and Run now`

### Task 11: Web: feed and waiting

**Split:** `ActivityFeed.tsx` (infinite list, filter chips), `WaitingList.tsx` (grouped by who it waits on); top bar "N agents working" links to `/agents/feed`; tests.
- [ ] **Commit:** `feat(web): agent activity feed and waiting-on-a-person list`

### Task 12: Web: "How we count time saved"

**Split:** `TimeBaselines.tsx` (table: work, unit, basis, minutes input, reset), recount dialog showing before/after totals from a dry-run endpoint (`?dryRun=1`), hourly-rate link; tests.
- [ ] **Commit:** `feat(web): owner-editable time-saved baselines`

### Task 13: End-to-end and acceptance

**Files:** `apps/web/e2e/agents.spec.ts`, `docs/superpowers/a1-acceptance.md`, a11y/phone spec edits, e2e seed `seedAgentsFixture`.
- **Tests:** cards from seeded tasks; changing a baseline then recount changes the month total; pause Storm Scout; feed and waiting rows link correctly; "(estimate)" visible; a11y; 375px.
- [ ] **Commit:** `test(e2e): Agents screen and A1 acceptance map`

---

## Rulings

1. **Migrations 0020/0021 only in Task 1;** no dependency changes.
2. **`tasks/service.ts` is edited only in Task 3;** `shared/steps.ts` only in Task 2; S1/D1 files only in Tasks 4 and 7 (named lines).
3. **E1/S1 minute values are superseded by the baselines table** (S1 routes 120 → 45 minutes per route), stated in the spec; existing finished tasks keep their stored totals.
4. **G1 agents appear as "Coming soon"** until G1 sets `G1_AGENTS_SHIPPED`; A1 ships without them.
