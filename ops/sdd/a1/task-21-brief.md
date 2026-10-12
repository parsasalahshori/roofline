### Task 21 (track lead): Front Desk wiring on the Agents screen (Rulings AX-D, AX-K, AX-N)

**Base:** branch `a1-t4` after the d1-w5b merge (Ruling AZ: this work merges into a1-agents only after d1-front-desk contains D1's T10/T13/T14). Runs in parallel with Task 4 (live tasks), on a disjoint file set.

Read first: `ops/sdd/a1/progress.md` (AX-D, AX-J, AX-K, the T5/T6/T14 seams), spec §4 (Front Desk success rate), §6 (rules, pause), §7 (waiting), D1's ledger on `origin/d1-front-desk:ops/sdd/d1/progress.md` for names (Front Desk settings columns `front_desk_enabled`, `front_desk_can_move`, `front_desk_can_cancel`, the on-call/transfer list, the Front Desk number, conversations.outcome, transfer reasons incl. `model_failure`, follow-up next steps D1 creates on jobs).

**Do:**
1. **Rule facts** (`apps/api/src/agents/rule-facts.ts`): fill `frontDesk` from D1's settings: the Front Desk phone number (formatted like D1's web formatPhone or the shared phone helper), the transfer names in on-call order (first names), and what it may do (book always; confirm; move/cancel per settings). `rulesFor('front_desk', …)` gives the spec sentence. Reps: same rule as Storm Scout (no links; nothing sensitive is in this sentence, but links go to settings reps cannot open). Links to `/settings/front-desk`; fix `FRONT_DESK_SETTINGS` in `packages/shared/src/agent-rules.ts` if it differs. Tests.
2. **Pause** (Decision 6): a paused Front Desk sends calls to the team ring list then voicemail, exactly like Front Desk off. Add the one-line `isAgentPaused(tx, ctx, 'front_desk')` check where `hooks/twilio-voice.ts` decides Front Desk on/off, and the same for inbound texts in `front-desk/texts.ts` `queueFrontDeskText` (a paused Front Desk does not answer texts; the message stays for people). Running conversations finish. Tests (db-backed): paused → the off path; unpaused → Front Desk answers.
3. **Success rate (AX-D)** for `front_desk` (`packages/db/src/repos/agent-metrics.ts` + `apps/api/src/agents/metrics.ts`): over the last 30 days, finished conversations; success = outcome is not `abandoned` and the conversation had no `model_failure` hand-off; `successRate` null under 5; `finishedToday` for Front Desk stays from tasks (Task 4 makes one live task per conversation). Role scope: reps count only conversations whose job is in jobScope (or none if there is no job link; follow AX-J). Tests.
4. **Waiting (T6 seam)** (`packages/db/src/repos/agent-waiting.ts`, `apps/api/src/routes/agents-feed.ts`): fill the `front_desk_follow_up` seam: Front Desk messages and transfers whose job follow-up (the next step D1 creates on the job) is still open, waiting on the person the follow-up is assigned to (by name), else the office; href to the job. Card `waitingCount` for front_desk includes them (keep card and list agreement via the shared helper). Tests.
5. **AX-N (bookings):** decided: Front Desk steps fold booking minutes into their call/text step (spec Decision 4: one internal step). The time breakdown labels these rows "Calls answered (incl. bookings)" / "Text replies (incl. bookings)" in the web copy map; no schema change. Web copy only (`apps/web/src/copy/agents.ts` baseline label map) + a web test.
6. **Acceptance:** update `docs/superpowers/a1-acceptance.md`: every "pending D1 (Task 4)" row that this task covers now cites its tests (Task 4 fills the live-task rows).

**Do not edit:** `front-desk/after-call.ts`, `agents/front-desk-tasks.ts`, `tasks/service.ts` (Task 4 / Task 20 own them). `texts.ts`: only the one-line pause check at the start of `queueFrontDeskText`.

**Verify:** typecheck, lint, lint:css, shared + web vitest; `ci-check` with `CI_JOBS="Platform E2E"`.

Commit: `feat(api): Front Desk rules, pause, success rate and follow-ups on the Agents screen`
