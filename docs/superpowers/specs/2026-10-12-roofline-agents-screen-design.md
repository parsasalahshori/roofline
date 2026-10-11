# Roofline SaaS — Sub-project 6: Agents screen

- **Date:** 2026-10-12
- **Status:** written by Architect 2 under the owner's standing rule ("just build, take the recommended option"). Choices are recorded as **Decision: … (recommended because …)**.
- **Parent:** [Master design](2026-10-10-roofline-saas-design.md) §1 feature 4, §5.1 (top bar "N agents working", dock), §5.3 (R2), §7 (`agent_tasks`, `agent_task_steps`), §8 row 6, §14 ("the hours-saved formula: default minutes per task type × the company's hourly rate, default $28/hr"). Builds on F1–F3 (task model, `minutes_saved`, `hourly_rate_cents`), F2 (approvals windows, top bar), and the agents that already create tasks: E1 (Estimator), S1 (Storm Scout), D1 (Front Desk). The Claims, Scheduler and Follow-up agents are specified separately in [G1](2026-10-12-roofline-more-agents-design.md); this screen shows them as "Coming soon" until G1 ships.
- **Delivery:** one milestone, **A1**, one plan (`docs/superpowers/plans/2026-10-12-roofline-agents-screen.md`).

---

## 1. Goal

The owner's feature 4: **one place to see what the AI team did, what it is waiting on, and roughly how much time it saved** — honestly labeled as an estimate.

1. **Agents window `/agents`:** one card per agent (Storm Scout, Estimator, Front Desk; Claims, Scheduler, Follow-up as "Coming soon" until G1): finished today, success rate, time saved this month (estimate), a 14-day mini chart, status (on, paused, waiting on you).
2. **Agent page `/agents/:agent`:** its rules in plain English with "Change" links, an on/pause switch, "Run now" where it makes sense, recent tasks, and its time-saved breakdown.
3. **Activity feed:** everything every agent did, newest first, filterable by agent.
4. **Waiting on a person (hand-off view):** everything an agent handed to a human — approvals, "needs attention", Front Desk messages and transfers not yet called back.
5. **"How we count time saved":** the baseline minutes per kind of work, editable by the owner.

**Not in A1:** the Claims, Scheduler and Follow-up agents themselves (G1), per-user productivity reports, exporting metrics, comparisons between companies.

## 2. What exists already

- `agent_tasks` (`agent`, `kind`, `mode needs_approval|live`, `status`, `minutes_saved` set when the task finishes) and `agent_task_steps` (`type`, `approval_class`, `status`, `payload`, `result`); the runner sums each done step's `stepTypes[type].minutesSaved(payload, result)` into the task (F1).
- Step types with hard-coded minutes: `send_sms_batch` (1.5 per text sent, cap 120), `send_proposal` (20), `order_exact_report` (10), S1's `send_email_batch`, `build_routes`, `create_ad_campaign`.
- `company_settings.hourly_rate_cents` (default 2,800), editable in Settings → Company (F3).
- F2: "N need your OK" pill and window, the R2 review, the top bar "N agents working", the dock's Agents app ("Coming soon").
- D1: Front Desk acts live and writes conversations and calls, but **no agent tasks** (D1 Ruling 3).

## 3. Time saved — the metric

**Decision 1: time saved = Σ over finished work of (units × the company's baseline minutes per unit), capped per step, where every baseline is a stated, owner-editable assumption and the result is always shown as an estimate** (recommended because the owner asked for an honest number: it counts only work that actually happened, names its assumptions in plain words next to the number, and lets the owner make them match their own office).

### 3.1 Baselines (defaults; "minutes a person in your office would spend")

| Key | Work | Unit | Default min/unit | Cap per step | Basis shown to the owner |
|---|---|---|---|---|---|
| `text_sent` | Texts an agent sent (batch or personal) | text delivered or sent | 1.5 | 120 | "Looking up the number, writing and sending one text" |
| `email_sent` | Storm emails sent | email | 0.5 | 120 | "Sending one email from a template" |
| `route_built` | Door-knock routes | route | 45 | — | "Planning one walking route on a map" |
| `ad_campaign` | Ad campaign created | campaign | 45 | — | "Setting up one campaign by hand" |
| `proposal_sent` | Proposal texted to a homeowner | proposal | 20 | — | "Building and sending a three-option proposal" |
| `exact_report` | Exact report ordered | order | 10 | — | "Ordering a report on the supplier's site" |
| `call_answered` | Call handled by Front Desk (not spam) | call | 2 + call length | — | "Answering the call yourself, plus 2 minutes of notes" |
| `spam_call` | Spam call ended by Front Desk | call | call length | — | "The time someone would have spent on the line" |
| `booking` | Inspection booked/moved by Front Desk | booking | 3 | — | "Checking the calendar and entering the appointment" |
| `text_reply` | Text reply by Front Desk | reply | 2 | — | "Reading and answering one text" |
| G1 keys | (added by G1: `claim_packet` 30, `reminder_sent` 1, `install_moved` 10, `follow_up_sent` 2) | | | | |

- **This table replaces the hard-coded minutes** in F1/E1/S1 step types (S1's 120 minutes per route becomes 45; S1's ads 45 unchanged; E1's 20 and 10 unchanged). Each step type declares `{ baseline: key, units(payload, result) }` instead of a number.
- **Only finished work counts:** a step counts only when `done`, with units from its **result** (texts actually sent, not recipients drafted). Skipped, failed, declined and expired work counts zero. Blocked-by-gate texts count zero.
- **Owner-editable:** Settings → Agents → "How we count time saved": each row's minutes (0–600, 0.5 steps) and a "Reset to default". Office can view.

### 3.2 Snapshot and history

- **Decision 2: each done step stores its units, minutes per unit and minutes saved at the moment it finishes; editing a baseline changes future work only, unless the owner presses "Recount the last 90 days with these numbers"** (recommended because a number that silently rewrites itself erodes trust, while an explicit, logged recount still lets the owner correct an assumption). The recount is audit-logged with before/after totals.

### 3.3 How it is shown

- Hours, rounded: under 10 hours to the nearest half hour, above to the nearest hour; always with "about" and "(estimate)": "About 31 hours saved this month (estimate)".
- Money: hours × `hourly_rate_cents`: "≈ $870 of staff time at $28/hour" with a link to change the rate.
- An info button opens "How we count": the table above with the company's numbers and "Only finished work counts."
- Periods: today, this week, this month, last 90 days (company time zone).

## 4. The other numbers

- **Finished today:** tasks reaching `done` or `partly_done` today.
- **Success rate:** **Decision 3: success rate = (done + ½ × partly done) ÷ (tasks that ran and finished) over the last 30 days; declined and expired drafts are shown separately as "Not approved", and no rate is shown below 5 finished runs ("Not enough runs yet")** (recommended because a draft the owner declined is the owner's choice, not an agent failure, and small samples mislead). Front Desk's rate: calls that ended with an outcome other than `abandoned` and without a model failure hand-off.
- **Status:** `on`, `paused` (§6), `waiting on you` (drafts or attention items), `coming soon`.
- **Mini chart:** 14 daily bars of finished tasks (SVG, no chart library, accessible as a table for screen readers).

## 5. Front Desk in the task model

- **Decision 4: Front Desk records one `live` agent task per finished conversation** (kind `call` or `text_conversation`, status `done` or `needs_attention` when a hand-off message is still open) **with one internal step** (`front_desk_call` / `front_desk_texts`, `done`, result `{ seconds, bookings, replies, spam }`) (recommended because then every agent is counted, listed and fed the same way, and the approvals queue is unaffected — `live` tasks never appear in "need your OK"). D1's after-call job and text job create them; D1 Ruling 3 (no R2 steps) still holds.

## 6. Rules, pause and Run now

- **Rules in plain English (master row 6):** **Decision 5: rules are sentences generated from the settings each agent already has, each value a link to where it is changed — not a new rules engine** (recommended because the settings exist (threshold, budget, what Front Desk may do…) and a second place to edit them would drift). Examples:
  - Storm Scout: "When hail of **1 inch** or more hits your service area, I draft a storm plan: texts, emails, door-knock routes and ads up to **$270** over **7 days**."
  - Estimator: "When you type an address, I measure the roof and draft a three-option proposal. I order exact reports only when you approve."
  - Front Desk: "I answer every call to **(402) 555-0100**. I can book, confirm and move inspections; I never give prices. I transfer urgent calls to **Sam, then Pat**."
- **Pause:** **Decision 6: each agent has an on/paused switch (owner only); paused agents stop starting new work — Storm Scout stops drafting plans (alerts still go out), Front Desk sends calls to the team ring list then voicemail — and running tasks finish** (recommended because stopping mid-send would leave half-sent batches). Stored in `agent_settings`.
- **Run now:** Storm Scout "Check for hail now" (runs the company's storm match), and G1's three agents (G1 wires them); Estimator and Front Desk show "Works when you ask" / "Answers as calls come in". At most once per 5 minutes per agent.

## 7. Feed and hand-offs

- **Decision 7: an `agent_task_events` table written by the task service** (created, approved (by whom, partial), declined, step done/failed/needs attention, finished, expired) (recommended because the feed needs ordered events with actors, which today are spread over timestamps on two tables, and the service is the one writer).
- **Feed:** "Storm Scout drafted a storm plan for hail near Omaha · 2:14 PM", "Pat approved 3 steps", "Texts: 212 sent, 9 replies", "Front Desk booked an inspection for Maria Lopez". Paged by cursor, filter by agent; reps see only events about their own jobs.
- **Waiting on a person:** drafts waiting for approval (links to F2 review), tasks `needs_attention` with their plain reason, Front Desk messages and transfers whose job follow-up is still open (D1), and G1's items. Each row says who it is waiting on ("You", "Office", "Sam").

## 8. Data (one migration pair)

- **`agent_task_steps` gains** `baseline_key text`, `units numeric(10,2)`, `minutes_per_unit numeric(6,2)`, `minutes_saved numeric(10,2)` (nullable; set when done).
- **`time_baselines`** (tenant): `key`, `minutes_per_unit`, unique `(company_id, key)`; a missing row means the default.
- **`agent_task_events`** (tenant): `task_id`, `step_id` (nullable), `kind`, `actor_type (user|agent|system)`, `actor_user_id`, `data jsonb` (counts only, no message text), `at`; index `(company_id, at desc)`.
- **`agent_settings`** (tenant): `agent`, `paused_at`, `paused_by`, `last_run_now_at`, unique `(company_id, agent)`.
- **`time_recounts`** (tenant): `by_user_id`, `from`, `to`, `before_minutes`, `after_minutes`, `at`.

## 9. API

- `GET /api/agents` (cards), `GET /api/agents/:agent?period=` (rules, status, chart, recent tasks, time breakdown by baseline), `POST /api/agents/:agent/run`, `PUT /api/agents/:agent/paused { paused }` (owner), `GET /api/agents/feed?agent=&cursor=`, `GET /api/agents/waiting`, `GET/PUT /api/agents/time-baselines`, `POST /api/agents/time-baselines/recount` (owner).

## 10. Testing and acceptance

- **Unit:** units per step type from results; caps; rounding and labels; success rate with partial, small samples, declined; rule sentences from settings.
- **Integration:** snapshot at completion; baseline edit affects only later steps; recount over 90 days with an audit entry; Front Desk live tasks from D1 calls and texts; events written by every task transition; feed and waiting lists with role scoping; pause stops Storm Scout drafting and routes Front Desk calls to the team; run-now rate limit; cross-tenant 404s.
- **Browser:** the Agents window (cards, "Coming soon" for G1 agents), an agent page with rules and pause, the feed, waiting list, the baselines table with recount confirmation, a11y, phone.
- **Acceptance (A1):** every number on the screen is reproducible from stored step snapshots; "(estimate)" and "about" appear wherever time or money saved is shown; declined/expired never lower the success rate; owner edits to baselines change future numbers and, only on recount, past ones; all three launch agents appear with real data; G1 agents show "Coming soon"; the dock's Agents app is shipped.

## 11. Owner to-dos

- **Confirm the default baselines** (§3.1) and the hourly rate default ($28) — they are the assumptions behind the headline number on every customer's screen.
- Nothing else: no accounts, credentials or costs.

## 12. Decisions index

1 time saved = finished units × editable baselines, always an estimate · 2 snapshot per step, explicit recount · 3 success rate excludes declined/expired, ≥ 5 runs · 4 Front Desk as live tasks · 5 rules are sentences over existing settings · 6 pause per agent · 7 an event table for the feed.
