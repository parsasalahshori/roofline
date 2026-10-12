### Task RC-1 (part of Task RC, built by the S1 lead for the D1 lead): SMS turns, notes order, caller identity, texts.ts fixes, requeue, T19 minors

**Base:** `d1-front-desk` df798d11, branch `d1-rc1`. The D1 lead merges it once CI is green (`CI_JOBS="Platform E2E"`).
**Read first:**
- `ops/sdd/d1/task-rc-brief.md`, including its "Updates since" section and the T19 minors;
- `ops/sdd/d1/pre-review-findings.md`, notes 6, 7, 8, 9, 17/19/25 and 44;
- `ops/sdd/d1/global-constraints.md`;
- `ops/sdd/d1/progress.md` (the rulings).

**Items** (numbers follow task-rc-brief.md):
1. **Note 6, SMS turn positions.**
   - `insertTurn` in `packages/db/src/repos/turns.ts` allocates the position itself: `SELECT ... FOR UPDATE` on the conversation row, then `coalesce(max(position),-1)+1`. Callers no longer pass a position, or the passed one is ignored. Check every caller.
   - `texts.ts` seeds engine state (the turns and the next position) from the stored turns of an existing conversation.
   - Never swallow a unique violation: log the ids and rethrow.
   - `turnLimit` must trip for SMS.
   - Keep d1-rev-d's SMS-detail text dedupe working (`conversations-routes.test.ts`, `d1-t22-view` tests).
   - Tests: three SMS exchanges store 6 turns at positions 0..5; turnLimit trips for SMS.
2. **Note 7.** Push pending system notes only immediately before `llm.answer()` (`state.ts`, the engine's turn logic). Test, with ScriptedLlm: run interrupt, interrupt, reply, and assert no history has a system entry followed by a user entry.
3. **Note 8.** `verify_caller` returns the locked sentence once failures reach MAX, without a repo lookup.
   - Persist the identity and the failure count on `conversations.identity` (jsonb, already in 0019), and restore them in `texts.ts`.
   - Put the new repo helpers in a NEW file, `packages/db/src/repos/conversation-identity.ts`, exported from the db index. Do NOT edit `repos/conversations.ts` (Task CV owns it).
4. **Note 9.** When `verify_caller` or the phone match identifies a customer, write `conversations.customer_id` and `identity` for calls too (`tools/caller.ts`, via the new helper).
5. **Item 6, the `texts.ts` parts:**
   - pass `toE164: conversation.phoneE164` to `buildGateRequest`;
   - stop skipping on `handledBy === 'team'` and rely on `lastTeamReplyAt`;
   - skip blocked numbers;
   - cap AI turns per SMS conversation at the turnLimit;
   - do not pay for a turn for an unknown texter whose reply is discarded (resolve the T7 TODO).
6. **Item 9, note 44.** The requeue path in `texts.ts` requeues only when no assistant turn was stored.
7. **T19 minors:**
   - (a) The router intents (`ask_for_person`, `transfer`, `human`, `not_understood`, plus whatever the engine keys on) become a closed enum in the router's structured-output json_schema (providers/anthropic) and the shared types. Leave the byte-frozen ROUTER_PROMPT text alone. Test with ScriptedLlm.
   - (b) Count a person-ask once per turn: `tools/transfer.ts` and the engine both bump askedForPersonCount today.
   - (c) Import `systemCtx` from `tools/system-ctx.ts` everywhere, and drop the `times.ts` re-export.

**Not yours.** Do not edit these files; they belong to parallel tasks:
- **Task CV (d1-cv):**
  - `engine.ts` `start()`;
  - `after-call.ts`;
  - `repos/calls.ts` and `repos/conversations.ts`;
  - `tools/message.ts`;
  - `hooks/twilio-voice*.ts`;
  - the fd-health job.
- **RA (d1-ra):**
  - `relay-server.ts`, `relay-session-loop.ts`;
  - `recording.ts`, `recording-store.ts`;
  - `routes/calls.ts`;
  - `RecordingPlayer`;
  - in `engine.ts`, the transcriptOff handling and `interrupted()`.
- **E1's d1-rev-c:** the web Front Desk and `routes/conversations.ts`.
- **T25:** `apps/api/test/front-desk/call-rig.ts` and `scenarios/**`.

Items 5, 7 and 8 of task-rc-brief.md stay with the D1 lead.

**Rules:**
- No new migration.
- Every app_system grant on conversations and conversation_turns is gone, so work on the tenant pool inside withTenant.
- A Drizzle update also writes updated_at.
- No live providers; logs carry ids only; the repo is public.

**Local tests (Docker works here; dockerd is running):** run the db and api suites through the slot wrapper. For example:
- `/home/user/roofline/ops/bin/dbtest npx vitest run --project @roofline/api apps/api/test/front-desk`
- `/home/user/roofline/ops/bin/dbtest npx vitest run --project @roofline/db packages/db/test/repos-conversations-turns.test.ts`

Run every test file you touch plus the whole `apps/api/test/front-desk` folder before committing.

**Commit:** `fix(api): front desk keeps SMS threads, identity and notes straight (RC-1)`
