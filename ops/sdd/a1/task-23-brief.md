### Task 23 (track lead): Front Desk review fixes

**Base:** `a1-agents` 106d80b (or newer). Findings with file:line evidence: `ops/sdd/a1/review/findings-front-desk-numbers.md` (FD-*) and the scope/integration review summarised below (FS-*). Re-verify each against the code; every fix gets a test that fails before it (db/api tests are CI-only).

**Feed (FD-2 / FS-I1, important).** Live tasks must not read as drafts: `FeedRow` gains the task mode; for `mode = 'live'` the feed shows ONE row per task: hide `created` and `step_done` (query filter in `packages/db/src/repos/agent-feed.ts`, keeping cursor paging correct) and render the creation-time `finished` (or `step_attention`) as a Front Desk sentence using the title and the customer first name under scope, e.g. "Front Desk answered a call for Maria", "Front Desk took a message for Maria", "Front Desk answered 3 texts from Maria", "Front Desk blocked a spam call"; a later close-time `finished` reads "{Agent}: {title} is done". Add `front_desk_call` / `front_desk_texts` unit words. Tests in feed-text.test.ts and agent-feed-repo.test.ts.

**Success rate (FD-1 important, FD-7, FS-M2).** `frontDeskConversationCounts` (agent-metrics.ts): voice conversations only (`channel = 'voice'`), `spam` excluded from the denominator, rep scope through `customerScope(ctx)`. Text model failures: in `runFrontDeskText` (`apps/api/src/front-desk/texts.ts`), when the engine hands off with reason `model_failure`, call `recordModelFailureHandoff` in the same transaction that marks the conversation handled by the team (so a future text-channel rate is right too). Tests.

**Waiting (FS-I2, FS-I3/FD-6 important; FS-I4).**
- `followUpQuery` (agent-waiting.ts) skips a job when any open live Front Desk task exists on any job of the same customer (join through jobs.customer_id) — test with two jobs → one item, waitingCount 1.
- `/waiting` (apps/api/src/routes/agents-feed.ts): a `front_desk` attention row whose subject is a job waits on the job's assignee by name (else the office) and its text shows the job's next step, like the follow-up rows. Test (owner sees "Sam", rep Sam sees "You").
- A live Front Desk task also closes when the job's next step text changes (not only when cleared) — `onJobNextStepChanged` compares before/after (one finished event). Test. Merge rule for D1 T9 (report): key follow-ups on D1's marked next step once it exists.

**Numbers (FD-3, FD-4, FD-5, FD-8).**
- `addToLiveTask` (tasks/service.ts) snapshots incrementally: previous `minutes_saved` + minutes of the added replies/bookings at today's baseline; units add; minutes per unit = minutes/units (past replies keep their value; only a recount revalues). Test (baseline changed between two replies).
- `listRecountSteps` (packages/db/src/repos/time-baselines.ts) locks the steps it will rewrite (`FOR UPDATE`; lock order step then task, as addToLiveTask).
- `runFrontDeskText` counts a reply only when `sendQueuedText` returned 'sent'; a scheduled reply is not counted (report as a known gap).
- after-call.ts: a rejected spam call (status 'rejected' and `aiStartedAt` null — screening rejected it before Front Desk ran) makes no task; fix the stale "spam is recorded" comment. Test.

**Rules (FS-M1).** `apps/api/src/agents/rule-facts.ts`: transfer names from D1's on-call list (a system-pool helper next to `onCallMembers` / `listOnCallRows` in packages/db/src/system/: active members with on_call_order and a transfer phone, ordered, first names); add `canCancel` to `AgentRuleFacts.frontDesk` and the sentence in `packages/shared/src/agent-rules.ts`. Tests.

**Acceptance doc (FS-M3).** Fix the stale a1-dock test names and the pause citations (voice-hooks.test.ts, texts.test.ts) in `docs/superpowers/a1-acceptance.md`; add rows for the new tests.

**Report-only:** D1 gap `calls.conversation_id` never set (sent to D1); text bookings 0 until D1's text booking tools.

Commit: `fix(api): Front Desk feed, success rate, waiting and snapshots (A1 Front Desk review)`
