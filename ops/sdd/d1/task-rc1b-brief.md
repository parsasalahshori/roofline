### Task RC-1b (follow-up on d1-rc1, from the E1 lead's final review, via the D1 lead)

**Base:** `d1-rc1` after RC-1. Same file fences as `ops/sdd/d1/task-rc1-brief.md`, and add `d1-rc2`'s files to them: `message.ts`, `after-call`, the engine.start caller match, and the handoff `urgent` field (the engine handoff event and HandoffData). Do not change the engine handoff event or HandoffData.

1. **F2 (texts.ts).** SMS sets customerId but leaves the identity 'unknown' (texts.ts ~137). When the phone match finds exactly one customer, set the identity to 'matched' and persist it through the RC-1 identity helper. The voice side is RC-2's.
2. **F4 (texts.ts; replaces RC-1 item 5's "do not pay for an unknown texter's turn").** With tools wired, an unknown texter's turn has real side effects: a booking creates the customer and job and sends a confirmation, and take_message runs. Today the AI reply is dropped (texts.ts ~183-185, stale `prepared.customerId`). Do NOT skip unknown texters' turns. After the turn, re-read the conversation's customerId (or create and link before it), and send the reply. Test: an unknown texter who books gets the reply text, and the conversation is linked to the new customer.
3. **F5 (engine turn logic).** A tool not offered on the channel (transfer_to_person or end_call on SMS) still ends the turn, because `finish` is set even when the toolNames check fails (engine.ts ~432-450). Set `finish` only when the handler ran. Test with ScriptedLlm: on SMS, a call to end_call is refused and the turn continues to a reply.
4. **F6 (texts.ts).** An SMS handoff leaves the texter with no reply and notifies nobody. Send a fixed copy constant, "I've passed this to the team; someone will text you back.", through the normal send gate, and make sure the team sees the handoff. Use the existing handoff and notification path the voice side uses, without changing the handoff event. Test both.
5. **F7.** Keep the shape of what texts.ts writes into SMS turns: unanswered texts are joined with '\n' into one caller turn. The E1 lead's SMS-detail matcher on d1-rev-f depends on it. If RC-1 changed that shape, restore it.

**Verify:** the same checks as RC-1, with the front-desk api folder run locally with Docker.
**Commit:** `fix(api): SMS front desk answers unknown texters, matches identity, replies on handoff (RC-1b)`

6. **N3 (tools/book.ts ~144).** The fd-book confirmation text (time and address) builds its gate request without toE164, so a thread from the customer's second number gets the confirmation on their primary number. Pass `toE164: conversation.phoneE164`; the gate keeps it only when it is one of the customer's numbers. Test: a booking from the customer's second number sends the confirmation to that number.
7. **Merge fallout (blocking: typecheck is red).** After merging d1-front-desk 6697620a (CV and T25), T25's scenarios (`apps/api/test/front-desk/scenarios/*.ts`, owned by the C1 lead; do not edit) script the router intents `emergency`, `insurance_question`, `pricing` and `prompt_injection`, which RC-1's closed `ROUTER_INTENTS` (packages/shared/src/front-desk-rules.ts) lacks.
   - Add every intent the scenarios, the engine and the smoke use to the enum and the router json_schema.
   - Add `recording_objection`, or whatever the smoke checks for: `apps/api/src/scripts/smoke/front-desk.ts:220` matches /record/i against the intent and can never pass today. Make it pass.
   - Grep all `intent:` literals in the api tests and src, so the enum covers them.
8. **SMS turn limit (open question from RC-1; ruling: the S1 lead takes the recommended option).** The 30-minute turn limit counts from the conversation's created_at, so an SMS thread older than 30 minutes would get no AI reply. For SMS, apply only the AI-turn count cap (SMS_MAX_AI_TURNS), never the duration. Derive SMS_MAX_AI_TURNS from the turnLimit constant rather than duplicating 40. Test: a 2-hour-old SMS thread still gets a reply, and the 41st AI turn does not.
9. **Smaller items from RC-1:**
   - **Restored failure count:** `loadStoredIdentity` counts only verify_caller failures that reached the handler (not invalid-input or lock replies), so the restored count equals the live one.
   - **times.ts:** remove the double blank line.
   - **Note for the ledger:** texts.ts still skips `handledBy 'team'` when teamUntil is null (an open-ended manual switch). Keep it, and say so in the report so the D1 lead can record it as a ruling.

Run the whole `apps/api/test/front-desk` folder (36 files) and the db identity and turns tests locally with Docker before committing. typecheck must be fully clean.
