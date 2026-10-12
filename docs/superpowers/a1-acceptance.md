# A1 acceptance checklist (spec section 10, Agents screen)

Status: the API, database, worker, shared and web component tests below are the repo's own suites; the database-backed ones run on CI (`.github/workflows/ci.yml`, the Platform job), because this machine has no Docker. The new Playwright specs (`agents.spec.ts`, `agents-settings.spec.ts`, and the Agents additions to `a11y.spec.ts` and `phone.spec.ts`) were only listed locally with `npx playwright test --list -c apps/web/playwright.config.ts` and are proven by CI's E2E job. Front Desk is not built on this base (Ruling AX-M: D1's after-call and text jobs do not exist), so every Front Desk row below is marked **pending D1 (Task 4)** and cites no test.

Paths are under `apps/api/test/` (API), `apps/web/e2e/` (Playwright), `apps/web/test/` (web components), `packages/<name>/test/` and `docs/superpowers/`. Spec: `docs/superpowers/specs/2026-10-12-roofline-agents-screen-design.md` section 10. Plan: `docs/superpowers/plans/2026-10-12-roofline-agents-screen.md` (Review Focus).

## Unit
- **Units per step type from results; caps; rounding and labels**
  - `packages/shared/test/agents.test.ts`: "text_sent is 1.5 minutes per text, uncapped below 120 minutes"; "text_sent caps the step at 120 minutes"; "the cap holds when an override is set"; "keys without a cap are not capped"; "minutes are not rounded"; "negative and NaN units count as zero"; "zero units give zero minutes and the base per-unit minutes"; "bookings count at 3 minutes each".
  - `packages/shared/test/steps.test.ts`: "send_sms_batch counts only the \"sent\" units: {sent: 31, blocked: 2} is 31 units and 46.5 minutes"; "every step type reports a baseline key that exists in TIME_BASELINES"; "send_sms_batch saves 1.5 minutes per text sent, at most 120".
  - `packages/shared/test/steps-storm.test.ts`: "minutes saved is half a minute per email, capped at 120"; "minutes saved is 45 per route built (A1 route_built), counted from the result"; "minutes saved is 45 per campaign created (A1 ad_campaign), counted from the result".
  - `packages/shared/test/steps-e1.test.ts`: "saves 20 minutes whatever the result"; "saves 10 minutes whatever the result".
  - `packages/shared/test/metrics.test.ts`: `hoursLabel` and `moneyLabel` tables (rounding and labels); "negative and NaN minutes are treated as 0".
- **Success rate with partial runs, small samples, declined**
  - `packages/shared/test/metrics.test.ts`: "null when ran is under 5"; "null when ran is not finite"; "all done at five runs is 1"; "partly done counts half"; "nothing done is 0"; "mixed run".
- **Rule sentences from settings**
  - `packages/shared/test/agent-rules.test.ts`: "exact sentence and three links"; "fractional threshold is plural"; "one day is singular"; "different facts produce different text"; "no storm facts gives no sentences"; "every link label is a substring of its sentence and points into settings".
  - `apps/api/test/agents-rule-facts.test.ts`: "changed company settings flow into the Storm Scout facts"; "rulesFor gives Storm Scout one sentence with three settings links and Front Desk none".
  - Front Desk rule sentence, number and transfer names: `apps/api/test/agents-rule-facts.test.ts` (Front Desk facts from D1 settings); sentence builder in `packages/shared/test/agent-rules.test.ts`: "exact three sentences for the full facts".
- **Local-day periods and 14-day series**
  - `packages/shared/test/agent-periods.test.ts`: "Chicago in daylight time starts at 05:00Z"; "DST end day (Nov 1) starts at 05:00Z, the day after at 06:00Z"; "month is the local month"; "last90 covers 90 local days including today"; "14 local dates, oldest first, ending today".

## Integration
- **Snapshot at completion**
  - `apps/api/test/task-events.test.ts`: "a step that finishes writes step_done by the agent with units and minutes"; "a failed step writes step_failed and no snapshot"; "a step that needs attention writes step_attention and no snapshot"; "a stale runner writes neither a snapshot nor an event".
  - `packages/db/test/agent-events.test.ts`: "setStepSnapshot rounds to 2 decimals; the sum counts only done steps"; "sumStepMinutesSaved is 0 with nothing done".
- **Baseline edit affects only later steps**
  - `apps/api/test/task-events.test.ts`: "the snapshot uses the override at that moment"; "a later override change leaves old snapshots alone".
  - `apps/api/test/agents-recount.test.ts`: "editing a baseline alone changes no old snapshot until a recount runs".
  - `apps/api/test/agents-settings.test.ts`: "PUT time-baselines sets an override that GET then returns"; "PUT time-baselines writes an audit entry".
  - `apps/web/e2e/agents-settings.spec.ts`: "settings agents: saving a baseline alone does not change past totals".
- **Recount over 90 days with an audit entry**
  - `apps/api/test/agents-recount.test.ts`: "recount dry run returns before and after and writes nothing"; "recount real run updates snapshots, inserts one time_recounts row and one audit_log entry with before and after totals"; "recount only touches steps from the last 90 days"; "recount is owner only: office and rep get 403 and company B is untouched"; "recount task minutes_saved equals the rounded sum of its steps".
  - `apps/web/test/time-baselines-recount.test.tsx`: "owner recount runs a dry run first and shows before and after"; "Confirm runs the real recount, then shows the success line and invalidates agents queries".
- **Front Desk live tasks from D1 calls and texts**: pending D1 (Task 4).
- **Events written by every task transition**
  - `apps/api/test/task-events.test.ts`: "createTask writes one created event with the agent as actor"; "approving a whole plan writes one approved event by the approver"; "a plan with a step left for the owner is partly_approved"; "declining a plan writes one declined event by the user"; "expiry writes one expired event by the system"; "a task that reaches done writes exactly one finished event"; "a task that lands in needs_attention writes no finished event"; "after attention then retry to done, finished is written once with status done".
  - `packages/db/test/agent-events.test.ts`: "insertAgentEvent then listTaskEvents returns events in order".
- **Feed and waiting lists with role scoping**
  - `apps/api/test/agent-feed-repo.test.ts`: "rep sees only events of tasks on jobs inside jobScope and customers inside customerScope, and none of tasks with no subject"; "owner sees all"; "company B events never appear for company A"; "row data never contains message text"; "cursor pages without gaps or repeats (limit 2 over 5 events)".
  - `apps/api/test/agents-feed-routes.test.ts`: "rep sees only own-job events"; "rep sees only drafts and attention tasks within their scope"; "waiting: a spend draft shows you for owner, office without delegation shows office, rep sees office"; "waiting href is /approvals/<id> for a draft and /jobs/<id> for a job-subject attention task"; "expired drafts are not waiting"; "items contain text and no message body (the sms STOP body is absent from the JSON)".
  - `apps/api/test/agents-api.test.ts`: "rep scope (AX-J): a rep sees only tasks on their own jobs and customers".
  - `packages/db/test/agent-metrics.test.ts`: "rep scope: a rep sees only tasks on their jobs and customers".
- **Pause stops Storm Scout drafting**
  - `apps/api/test/storm-pause.test.ts`: "a paused Storm Scout drafts nothing"; "an unpaused Storm Scout reaches the drafting body".
  - `apps/api/test/agents-settings.test.ts`: "pause is owner only and sets paused_at and paused_by"; "resume clears the pause"; "pausing does not change a running task"; "pausing a G1 agent is 409".
- **Front Desk pause routes calls to the team**
  - `apps/api/test/front-desk/voice-hooks.test.ts`, `apps/api/test/front-desk/voice-transfer-hooks.test.ts` (paused goes the Front Desk off path to the team ring list then voicemail; unpaused answers); `apps/api/test/front-desk/texts.test.ts` (a paused Front Desk does not answer texts).
- **Run-now rate limit**
  - `apps/api/test/agents-run-now.test.ts`: "run now starts Storm Scout and returns 202 with the next allowed time five minutes out"; "a second run within five minutes is 409 with a plain sentence"; "run now is allowed again after five minutes (advance the test clock t.clock)"; "two concurrent run now calls start exactly one run"; "run now limit is per company: company B can still run after company A did"; "a rep cannot run now (403 Your role can't do that. Ask the owner.)"; "run now queues one storm-match-company job for the company".
- **Cross-tenant 404s**
  - `apps/api/test/agents-api.test.ts`: "unknown agent is 404 and system is 404"; "company B isolation: cross-tenant data is never counted; unknown agent is 404 for both".
  - `apps/api/test/agents-run-now.test.ts`: "unknown agent is 404".
  - `apps/api/test/agents-settings.test.ts`: "pausing an unknown agent is 404"; "pausing in company A leaves company B on"; "PUT time-baselines in company A does not change company B".
  - `apps/api/test/agents-feed-routes.test.ts`: "company B feed never shows company A tasks".
  - `packages/db/test/agent-metrics.test.ts`: "company B data is never counted for company A"; `packages/db/test/agent-events.test.ts`: "another company sees none of them".

## Browser
- **The Agents window: cards, "Coming soon" for the G1 agents**
  - `apps/web/e2e/agents.spec.ts`: "agents window: cards show the numbers from the seeded tasks"; "agents window: totals line says about and (estimate)"; "agents window: the G1 agents say Coming soon"; "rep sees a smaller Agents window".
  - `apps/web/test/agents-window.test.tsx`: "shows the honest totals line and the cards in order".
  - `apps/web/test/agents-card.test.tsx`: "shows no numbers on a coming soon card".
- **An agent page with rules and pause**
  - `apps/web/e2e/agents.spec.ts`: "agent page: Storm Scout shows its rule sentence and links to storm settings"; "agent page: the owner pauses Storm Scout through the confirm sheet and the card shows paused"; "agent page: Run now shows the cooldown text".
  - `apps/web/test/agent-page.test.tsx`: "renders the rule with its link"; "pausing asks first"; "shows the pause switch to the owner only".
- **The feed and the waiting list**
  - `apps/web/e2e/agents.spec.ts`: "feed: rows and filter chips"; "waiting list: rows link to the approvals review".
  - `apps/web/test/agents-feed.test.tsx`: "filters by agent and back to All"; `apps/web/test/agents-waiting.test.tsx`: "groups rows by who they wait on: You, Office, then each person".
- **The baselines table with recount confirmation**
  - `apps/web/e2e/agents-settings.spec.ts`: "settings agents: owner changes a baseline, saves, recounts, and the month total changes"; "settings agents: office sees the table read-only"; "settings agents: reps cannot see the Agents tab".
  - `apps/web/test/time-baselines.test.tsx`: "owner edits one number and Save sends only that key"; "office sees read-only text".
  - `apps/web/test/a1-settings.test.tsx`: "hides Agents from a rep and sends the rep to Company".
- **Accessibility**
  - `apps/web/e2e/a11y.spec.ts`: "agents window has no serious accessibility violations"; "agent page has no serious accessibility violations"; "agents feed has no serious accessibility violations"; "agents waiting list has no serious accessibility violations"; "settings agents tab has no serious accessibility violations".
- **Phone**
  - `apps/web/e2e/phone.spec.ts`: "agents screens fit the phone".

## Acceptance (A1)
- **Every number on the screen is reproducible from stored step snapshots**
  - `apps/api/test/agents-api.test.ts`: "numbers come from seeded tasks and snapshots"; "detail returns breakdown and minutesInPeriod per period".
  - `packages/db/test/agent-metrics.test.ts`: "minutesByAgent sums only done step snapshots in range"; "breakdownByBaseline groups by baseline_key, minutes descending".
  - `apps/web/e2e/agents.spec.ts`: "agents window: cards show the numbers from the seeded tasks".
- **"(estimate)" and "about" appear wherever time or money saved is shown**
  - `apps/web/test/agents-window-copy.test.tsx`: "marks every time and money figure on a live card as an estimate".
  - `apps/web/test/agents-card.test.tsx`: "link accessible name includes the name, the time figure and (estimate)"; `apps/web/test/agent-page.test.tsx`: "shows time saved as an estimate".
  - `apps/web/test/agents-window.test.tsx`: "shows the honest totals line and the cards in order".
  - `packages/shared/test/metrics.test.ts`: `hoursLabel` and `moneyLabel` tables (the "about" words).
  - `apps/web/e2e/agents.spec.ts`: "agents window: totals line says about and (estimate)"; `apps/web/e2e/agents-settings.spec.ts`: "settings agents: owner changes a baseline, saves, recounts, and the month total changes" (new total keeps "about" and "(estimate)").
- **Declined and expired never lower the success rate**
  - `packages/db/test/agent-metrics.test.ts`: "agentCounts counts finished today, 30-day inputs and waiting per agent" (seeds a declined and an expired task: both land in `notApproved30d`, outside `ran30d`).
  - `packages/shared/test/metrics.test.ts`: "all done at five runs is 1"; "partly done counts half"; "mixed run" (the rate is over `ran` only).
  - `apps/api/test/agents-api.test.ts`: "successRate is null under five runs".
- **Owner edits to baselines change future numbers and, only on recount, past ones**
  - `apps/api/test/task-events.test.ts`: "the snapshot uses the override at that moment"; "a later override change leaves old snapshots alone".
  - `apps/api/test/agents-recount.test.ts`: "editing a baseline alone changes no old snapshot until a recount runs"; "recount real run updates snapshots, inserts one time_recounts row and one audit_log entry with before and after totals".
  - `apps/web/e2e/agents-settings.spec.ts`: "settings agents: saving a baseline alone does not change past totals"; "settings agents: owner changes a baseline, saves, recounts, and the month total changes".
- **All three launch agents appear with real data**
  - Storm Scout and Estimator: `apps/api/test/agents-api.test.ts`: "GET /api/agents returns six cards in order"; "numbers come from seeded tasks and snapshots"; `apps/web/e2e/agents.spec.ts`: "agents window: cards show the numbers from the seeded tasks".
  - Front Desk card with real data: pending D1 (Task 4).
  - Front Desk success rate: `packages/db/test/agent-metrics.test.ts` (finished and succeeded conversation counts, model_failure hand-offs, rep scope); `apps/api/test/agents-api.test.ts` (successRate null under five).
  - Front Desk waiting follow-ups: `packages/db/test/agent-waiting.test.ts`; `apps/api/test/agents-feed-routes.test.ts` (waiting lists Front Desk follow-ups).
  - Bookings folded into call and text rows: `apps/web/test/agents-window-copy.test.tsx` ("says Front Desk call and text rows include bookings").
- **G1 agents show "Coming soon"**
  - `apps/api/test/agents-api.test.ts`: "G1 agents are coming_soon with zeros and an empty series, even with seeded work".
  - `apps/web/test/agents-card.test.tsx`: "shows no numbers on a coming soon card"; "coming soon link name is just the agent name".
  - `apps/web/e2e/agents.spec.ts`: "agents window: the G1 agents say Coming soon".
- **The dock's Agents app is shipped**
  - `apps/web/test/a1-dock.test.tsx`: "shows Agents as shipped: no Coming soon note"; "keeps the Coming soon note on Front Desk only"; "ships every app but Front Desk (with E1 and S1 merged in)".
  - `apps/web/test/a1-routes.test.tsx`: "/agents shows the overview in the Agents window".

## Plan Review Focus
1. **Honest numbers (done steps with result units; caps; snapshot at completion; recount owner-only and audited)**
   - `apps/api/test/task-events.test.ts`: "a failed step writes step_failed and no snapshot"; "send_sms_batch counts sent texts only and caps at 120 minutes".
   - `packages/db/test/agent-events.test.ts`: "setStepSnapshot rounds to 2 decimals; the sum counts only done steps".
   - `apps/api/test/agents-recount.test.ts`: "recount is owner only: office and rep get 403 and company B is untouched"; "recount real run updates snapshots, inserts one time_recounts row and one audit_log entry with before and after totals".
2. **One writer (`tasks/service.ts` writes every event and snapshot)**
   - `apps/api/test/task-events.test.ts`: the transition tests listed under "Events written by every task transition".
   - `apps/api/test/boundaries.test.ts`: "agent event writer boundary"; `packages/shared/test/one-writer.test.ts`: only `packages/db/src/repos/agent-events.ts` inserts into `agent_task_events`.
3. **Role scope in aggregates (reps count only their jobs' work)**
   - `apps/api/test/agents-api.test.ts`: "rep scope (AX-J): a rep sees only tasks on their own jobs and customers".
   - `packages/db/test/agent-metrics.test.ts`: "rep scope: a rep sees only tasks on their jobs and customers".
   - `apps/api/test/agent-feed-repo.test.ts`: "rep sees only events of tasks on jobs inside jobScope and customers inside customerScope, and none of tasks with no subject".
   - `apps/web/e2e/agents.spec.ts`: "rep sees a smaller Agents window".
4. **Pause semantics (paused agents start nothing new; running work finishes)**
   - `apps/api/test/storm-pause.test.ts`: "a paused Storm Scout drafts nothing".
   - `apps/api/test/agents-settings.test.ts`: "pausing does not change a running task".
   - Front Desk pause routing calls to the team: `apps/api/test/front-desk/voice-hooks.test.ts`, `apps/api/test/front-desk/voice-transfer-hooks.test.ts`, `apps/api/test/front-desk/texts.test.ts`.

## Front Desk rows (live tasks and the card pending D1 (Task 4))
- Front Desk live tasks from D1 calls and texts: pending D1 (Task 4).
- Front Desk success rate: see Integration above (`packages/db/test/agent-metrics.test.ts`, `apps/api/test/agents-api.test.ts`).
- Front Desk pause routing calls to the team: `apps/api/test/front-desk/voice-hooks.test.ts`, `apps/api/test/front-desk/texts.test.ts`.
- Front Desk card with real data: pending D1 (Task 4).
- Front Desk rule sentence: `apps/api/test/agents-rule-facts.test.ts`.

## Gaps and notes
- **Known seam:** Storm Scout "Run now" enqueues a job whose S1 handler is still a stub; the e2e spec asserts the 202 and cooldown text only and never drains the queue.
- **Not yet run on CI:** the Playwright specs above are listed, not proven, until the E2E job runs (`ops/bin/ci-check`).

## Owner to-dos (spec section 11)
- Confirm the default time baselines (spec section 3.1). They are the assumptions behind the headline number on every customer's screen.
- Confirm the hourly rate default ($28 an hour). Nothing else: no accounts, credentials or costs.
