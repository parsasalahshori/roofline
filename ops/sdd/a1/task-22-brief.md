### Task 22 (track lead): Front Desk combined fixes (Tasks 4 + 21 group check)

**Base:** branch `a1-t4` with Task 4 (b8be9ca) and Task 21 merged. Held from a1-agents until d1-front-desk contains D1's T10/T13/T14 (Ruling AZ).

**Fix (each with a test that fails before the fix; db/api tests CI-only):**
1. **Double-counted follow-ups (important).** In `packages/db/src/repos/agent-waiting.ts` T21's `followUpQuery` (feeds both `listFrontDeskFollowUps` and `countFrontDeskFollowUps`) must skip a job that already has an open live Front Desk task: `not exists (select 1 from agent_tasks t where t.company_id = jobs.company_id and t.agent = 'front_desk' and t.mode = 'live' and t.status = 'needs_attention' and t.subject_type = 'job' and t.subject_id = jobs.id)`. Test: seed both (a needs_attention live task on job J and a message conversation for J's customer with J's next step open) → one waiting item and Front Desk `waitingCount` 1.
2. **Calls the AI never answered (important).** In `apps/api/src/front-desk/after-call.ts` record the non-spam live task only when the AI handled the call (`call.conversationId !== null || call.aiSeconds > 0`, check the real field names). Spam recording stays (screening runs before the pause/on-off decision) — record that in the report. Test: a paused or voicemail call (no conversation, aiSeconds 0) creates no task.
3. **Pause for queued texts.** Also check `isAgentPaused(tx, ctx, 'front_desk')` at the start of `runFrontDeskText` (a debounced job queued before the pause must not reply). Test.
4. **Archive closes the live task.** When a job is archived (C1's archive route / `setJobArchived`), close its open live Front Desk tasks through `closeLiveTasksForSubject` (one finished event). Keep the C1 edit to one call line. Test.
5. **One writer.** Add `setStepResult` (and any repo helper Task 4 added that writes task/step rows, e.g. the `insertTask` status/result overload if exported) to the ESLint one-writer restriction (tasks/service.ts only) + boundaries test. Delete the stale "SHELL: Package A implements these bodies" comment in tasks/service.ts. Lock the step row (`FOR UPDATE`) in `addToLiveTask`'s read-modify-write.
6. **Acceptance doc** `docs/superpowers/a1-acceptance.md`: cite Task 4's tests (front-desk-live-tasks.test.ts, front-desk-live-text-tasks.test.ts, live-tasks-service.test.ts) in the live-task and Front Desk card rows; correct the rule-sentence row: transfer names are empty until D1 exposes the on-call names (say so).
7. **Report-only:** text-task bookings are 0 until D1's booking tools land (ledger gap); the PATCH hook runs on any job PATCH (fine: closes only when no next step).

**Files:** agent-waiting.ts, after-call.ts, texts.ts (runFrontDeskText first line only), C1 job archive route (one line), agents/front-desk-tasks.ts, tasks/service.ts (comment only), eslint.config.js, boundaries test, the acceptance doc, tests.

Commit: `fix(api): Front Desk follow-ups counted once, only AI-handled calls counted, pause covers queued texts`
