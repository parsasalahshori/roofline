### Task RC: engine, texts and tools fixes (pre-review notes 6, 7, 8, 9, 11, 17/19/25 texts parts, 28, 41, 44)

**Base:** `d1-front-desk` after T19 merges. Findings are in `ops/sdd/d1/pre-review-findings.md`. Files: `apps/api/src/front-desk/engine.ts` (not `start`; Task CV owns start), `state.ts`, `engine-state.ts`, `texts.ts`, `tools/caller.ts`, `tools/message.ts` (not the summary write; Task CV owns that), `packages/db/src/repos/conversations.ts` (only the new identity/position helpers), plus tests.

1. **Note 6:** SMS turns after the first exchange are lost. When texts.ts builds state for an existing conversation, seed `nextPosition` from `max(position)+1` and the turns from the stored turns. Better: `insertTurn` allocates the position itself (`SELECT ... FOR UPDATE` on the conversation row, then `coalesce(max(position),-1)+1`). Never swallow a unique violation silently: log ids and rethrow. Test: three SMS exchanges store 6 turns with positions 0..5, and turnLimit trips for SMS.
2. **Note 7:** push pending system notes only immediately before `llm.answer()`. Add a test that no history has a system entry followed by a user entry (run interrupt, interrupt, reply).
3. **Note 8:** verify_caller refuses with the locked sentence once failures >= MAX (no repo lookup). Persist identity and the failure count on the conversation (`conversations.identity` jsonb, already in 0019; add a repo helper) and restore them in texts.ts.
4. **Note 9:** when verify_caller or the phone match identifies a customer, write `conversations.customer_id` and `identity` for calls too.
5. **Note 11 (Ruling EA):** take_message updates a job's next step only for a verified caller.
6. **Notes 17/19/25, texts.ts parts:** pass `toE164: conversation.phoneE164` to buildGateRequest (once d1-rev-b lands; otherwise leave a TODO naming RC); stop skipping on `handledBy === 'team'` once the route stops setting it (d1-rev-c) and rely on lastTeamReplyAt; skip blocked numbers; cap AI turns per SMS conversation at the turnLimit; do not pay for a turn for an unknown texter whose reply is discarded (resolve the T7 TODO).
7. **Note 28:** dedupe the urgent take_message email per conversation (once per conversation).
8. **Note 41:** an fd-health pass ends SMS conversations idle for 24 h (status 'ended') and enqueues after-call by conversation id, so they get a summary and a 'text_conversation' activity. after-call must accept `{conversationId}` without callSid for sms.
9. **Note 44:** the requeue path in texts.ts must not drop a finished turn: requeue only when no assistant turn was stored.

**Verify:** typecheck, lint; api tests on CI via `CI_JOBS="Platform E2E" ops/bin/ci-check`. Commit: `fix(api): front desk keeps SMS threads, identity and notes straight`.

**Also, T19 minors:**
- (a) The engine's person-ask and not-understood counters key on router intents (`ask_for_person`, `transfer`, `human`, `not_understood`) that nothing asks the router to emit. Make them a closed enum in the router's structured-output schema (`output_config.format` json_schema in providers/anthropic) and the shared types. Leave the byte-frozen ROUTER_PROMPT text alone unless the schema can't carry it; if the text must change, say so in the report. Test with ScriptedLlm.
- (b) `tools/transfer.ts` bumps askedForPersonCount on reason 'asked' while the engine also bumps it on the intent: count once per turn.
- (c) Import systemCtx from tools/system-ctx.ts everywhere and drop the times.ts re-export.

**Updates since this brief was written (d1-front-desk now has d1-rev-a/b/d and CV):**
- d1-rev-b added `toE164` to buildGateRequest. Item 6: pass `toE164: conversation.phoneE164` in texts.ts (no TODO).
- d1-rev-d removed every app_system grant on conversations and conversation_turns. The item 8 idle-close pass may only list company ids on the system pool. It ends conversations per company on the tenant pool, inside withTenant. Do not add grants.
- d1-rev-d's SMS detail merges messages with turns and dedupes by text. If item 1 changes what texts.ts writes into turns, keep that dedupe working (conversations-routes.test, d1-t22-view.test).
- T25 moved T19's test rig into `apps/api/test/front-desk/call-rig.ts`; call-paths.test.ts imports it.
