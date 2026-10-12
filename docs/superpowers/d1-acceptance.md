# D1 acceptance checklist (spec section 17)

Status: every automated test below runs in CI (`.github/workflows/ci.yml`: the Platform job for the API, database, shared and web suites, the E2E job for the Playwright specs, desktop and phone projects). The API and database tests are database-backed and, with no Docker on the build machine, were not run locally; the Playwright specs were only listed locally and are proven on CI. Nothing live is covered by CI: the real Claude service, real Twilio calls, real carriers and R2 are the manual smoke (`docs/superpowers/d1-manual-smoke.md`, steps M0 to M14), and the Front Desk code never reaches them from a test (Rulings DA and DB: `testConfig()` has no `ANTHROPIC_API_KEY`, `FAKE_PROVIDERS=1` forces `ScriptedLlm`).

Paths are under `apps/api/test/` (API), `apps/web/e2e/` (Playwright), `apps/web/test/` (web components), `packages/<name>/test/` and `docs/superpowers/`. Test names are quoted exactly as written in the files (a name with a `%s` is a `test.each` title). Where a name is a `describe` group, the group name comes first.

**T19** marks the part that lands with Task 19, the full call path (`apps/api/test/front-desk/call-paths.test.ts`: relay, engine and tools wired together with `FakeVoiceSession` and `ScriptedLlm`, one scenario each for booking, job question, claim, message, transfer on a leak, angry caller, recording objection and spam). Each `T19:` line below names those tests. Task 25 added the thirteen scripted calls of spec section 16 (`apps/api/test/front-desk/scenarios.test.ts`, data in `apps/api/test/front-desk/scenarios/`), played through the same relay loop, engine and tools; where one covers a criterion it is named next to the call path. A name with `%s` is a `test.each` title.

## Tally

42 criteria, from the 13 bullets of spec section 17 (a bullet with several parts is split into one criterion per part, numbered 1 to 42 below). Counted from this file by script (a criterion counts once per kind of proof, so the rows overlap):

| Proof | Criteria | Count |
| --- | --- | --- |
| Automated test or CI check today | all but 34 | 41 |
| T19 call-path scenario (named in the T19 line of each criterion) | 1, 3, 4, 8, 9, 10, 11, 12, 13, 22, 24, 33 | 12 |
| Manual smoke step | 1, 2, 3, 4, 10, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 26, 27, 28, 30, 31, 32, 33, 34, 37, 39 | 28 |
| Manual smoke only (no automated test) | 34 | 1 |

Criterion 41 (the 12px floor) is proven by `npm run lint:css` in the Platform job, which is a CI check rather than a test file.

## A call is answered, recorded, and honours "stop recording"

1. **A call to the Roofline number is answered with the disclosure every time**
   - `apps/api/test/front-desk/voice-hooks.test.ts`: "relay TwiML has the disclosure greeting, non-interruptible, callId parameter"; "a withheld caller id (anonymous) is still answered and saved"; "a missing From is answered and saved as anonymous".
   - `apps/api/test/front-desk/voice-transfer-hooks.test.ts`: "after-dial ring-first no answer hands the call to the Front Desk with the disclosure".
   - `packages/shared/test/recording-consent.test.ts`: "disclosureGreeting > exact wording"; "disclosureGreeting > trims and falls back for empty names".
   - T19: the call paths start at the relay setup that follows the greeting and the engine never speaks the disclosure itself: `apps/api/test/front-desk/scenarios.test.ts`: "scenario %s meets its must and mustNot" (every scenario's graded record rejects the disclosure said a second time); `apps/api/test/front-desk/prompt.test.ts`: "prompt names only the four live actions and every tool".
   - Manual: M1 (heard on two carriers).
2. **Recording starts**
   - `apps/api/test/front-desk/recording.test.ts`: "starts once"; "retention 0 never records".
   - `apps/api/test/front-desk/recording-store.test.ts`: "copies the recording to file storage, then deletes it at Twilio"; "a completed recording saves its length and enqueues one store job".
   - `apps/api/test/front-desk/twilio-call-control.test.ts`: "startRecording returns the recording sid".
   - Manual: M7 and M8.
3. **"Stop recording" stops it and the transcript**
   - `apps/api/test/front-desk/recording.test.ts`: "objection stops recording and the transcript"; "a caller objection in the relay loop stores blank turns and a system turn".
   - `apps/api/test/front-desk/recording-store.test.ts`: "a caller who objected keeps stopped_by_caller after the upload".
   - `apps/api/test/front-desk/twilio-call-control.test.ts`: "stopRecording posts Status stopped".
   - `apps/web/test/d1-t22-view.test.tsx`: "says the transcript was not kept at the caller's request when a call did not store it".
   - T19: `apps/api/test/front-desk/call-paths.test.ts`: "recording objection: recording stops, turns are saved with blank text and a system turn"; `apps/api/test/front-desk/scenarios.test.ts`: "scenario %s meets its must and mustNot" (the recording-objection scenario: recording stopped once, one system turn).
   - Manual: M7.

## With the fakes, a caller can use every live action

4. **A caller books an inspection in an open slot: an appointment with source `front_desk`, a Lead job, a calendar push, and a confirmation text through the gate**
   - `apps/api/test/front-desk/tools-booking.test.ts`: "book_inspection > books a new caller in one go: customer, call consent, home, Lead job, front_desk appointment, push, text"; "find_inspection_times > offers at most 6 times, by part of day, inside work hours and after the notice"; "book_inspection > a confirmation text the gate blocks is recorded, and the booking stands"; "book_inspection > a text that fails to send leaves the booking standing".
   - `apps/web/test/d1-t26-appointment.test.tsx`: "shows Booked by Front Desk for a front desk booking".
   - T19: `apps/api/test/front-desk/call-paths.test.ts`: "booking: find times, book the offered slot, then goodbye"; `apps/api/test/front-desk/scenarios.test.ts`: "scenario %s meets its must and mustNot" (the booking and booking-taken-slot scenarios).
   - Manual: M2.
5. **A booking onto a slot taken meanwhile offers the next two and writes nothing, and a repeated try makes one appointment**
   - `apps/api/test/front-desk/tools-booking.test.ts`: "book_inspection > a slot taken meanwhile returns the next two and writes nothing"; "book_inspection > the same conversation and slot gives the same appointment, and one text"; "book_inspection > two tries at once still make one appointment"; "book_inspection > two callers cannot take one inspector at one time".
6. **A caller confirms an appointment**
   - `apps/api/test/front-desk/tools-booking.test.ts`: "confirm_appointment > confirms any kind of visit for the verified caller, by call"; "confirm_appointment > an unverified caller cannot confirm"; "confirm_appointment > another customer's visit cannot be confirmed"; "the C / confirm text > confirms the next visit that is not confirmed yet, one text at a time".
   - `apps/api/test/front-desk/texts.test.ts`: "C confirms the next visit and the reply says which one".
   - `apps/api/test/front-desk/tools-booking.test.ts`: "confirm_appointment > the appointment view the web reads carries confirmedAt and confirmedVia".
7. **A caller moves their own inspection**
   - `apps/api/test/front-desk/tools-booking.test.ts`: "move_inspection > moves the caller's own inspection, clears the confirmation, queues the calendar push"; "move_inspection > a new time that was taken returns the next two and leaves the visit alone"; "move_inspection > an unverified caller cannot move"; "move_inspection > another customer's inspection is not found"; "move_inspection > with moving switched off it is refused"; "cancel_inspection > cancels the caller's own inspection with the reason, and queues the calendar push".
8. **A caller is refused moving an install, and offered a message instead**
   - `apps/api/test/front-desk/tools-booking.test.ts`: "move_inspection > an install is refused with a message suggestion"; "cancel_inspection > an install is refused with a message suggestion".
   - T19: no end-to-end call covers an install being refused; the refusal is proved at the tool above, and the hand-over to a message is the call path `apps/api/test/front-desk/call-paths.test.ts`: "message: a non-urgent take_message sets the job next step and leaves an activity" (a gap, listed under Gaps).
9. **A caller gives claim details: a claim intake on the job**
   - `apps/api/test/front-desk/tools-claim.test.ts`: "claim intake is stored and linked to the verified caller's single open job"; "verified caller with no open job gets a new Lead job with source front_desk"; "unknown caller's claim is stored without a job"; "the same claim twice in one conversation stores one row"; "a repeated claim with several open jobs creates one job, one row and one activity".
   - T19: `apps/api/test/front-desk/call-paths.test.ts`: "claim: take_claim_details links the intake to the verified caller job"; `apps/api/test/front-desk/scenarios.test.ts`: "scenario %s meets its must and mustNot" (the claim scenario).
10. **A caller leaves a message, which becomes a Today follow-up**
    - `apps/api/test/front-desk/tools-message.test.ts`: "message sets the assigned rep's job next step due today and writes a front_desk_message activity with { conversationId, urgent, reason }"; "unassigned job keeps assignee null (office)"; "no job: conversation outcome is message and nothing throws"; "urgent message emails each on-call member once, a second urgent message in the same conversation sends none"; "non-urgent message sends no email".
    - `apps/web/test/today-front-desk.test.tsx`: "shows From Front Desk for a message"; "shows Urgent, from Front Desk for an urgent message".
    - T19: `apps/api/test/front-desk/call-paths.test.ts`: "message: a non-urgent take_message sets the job next step and leaves an activity" (Ruling EA: a verified caller updates the job's next step); `apps/api/test/front-desk/scenarios.test.ts`: "scenario %s meets its must and mustNot" (the rambling-caller, job-unverified and prompt-injection scenarios each end in a message with no job touched).
    - Manual: M6.
11. **A caller is transferred on request**
    - `packages/shared/test/front-desk-rules.test.ts`: "shouldTransfer" (the rows of the table); "transferPlan" (the rows of the table).
    - `apps/api/test/front-desk/tools-handoff.test.ts`: "transfer plan rings all on-call members in work hours"; "asked increments askedForPersonCount, not_understood increments failedUnderstanding".
    - `apps/api/test/front-desk/engine.test.ts`: "router route transfer hands off and route end says goodbye then ends"; "transfer_to_person and end_call finish the turn with their event".
    - `apps/api/test/front-desk/relay-loop.test.ts`: "a handoff event sends an end with handoffData kind transfer and still saves the turn row"; "dtmf 0 sends an end with a transfer request".
    - `apps/api/test/front-desk/voice-transfer-hooks.test.ts`: "after-relay with a transfer in work hours dials every on-call member with a whisper URL"; "whisper asks to press 1 with numDigits 1 timeout 8"; "whisper-result takes the call on 1 and hangs up that leg otherwise"; "after-dial answered ends the call as answered".
    - T19: `apps/api/test/front-desk/call-paths.test.ts`: "angry caller: the router sends a transfer and the call ends with reason angry"; "transfer on a leak: transfer_to_person ends the call with a transfer handoff".
    - Manual: M5.
12. **A caller is transferred on "water is coming through my ceiling"**
    - `apps/api/test/front-desk/tools-handoff.test.ts`: "after hours leak reason gives ring_each".
    - `apps/api/test/front-desk/voice-transfer-hooks.test.ts`: "after-relay urgent out of hours rings each member in turn".
    - `packages/shared/test/front-desk-rules.test.ts`: "shouldTransfer" (the leak rows).
    - T19: `apps/api/test/front-desk/call-paths.test.ts`: "transfer on a leak: transfer_to_person ends the call with a transfer handoff"; `apps/api/test/front-desk/scenarios.test.ts`: "scenario %s meets its must and mustNot" (the active-leak scenario).
    - Manual: M5.
13. **A caller is transferred when angry**
    - `packages/shared/test/front-desk-rules.test.ts`: "shouldTransfer" (the angry rows).
    - `apps/api/test/front-desk/engine.test.ts`: "router route transfer hands off and route end says goodbye then ends".
    - T19: `apps/api/test/front-desk/call-paths.test.ts`: "angry caller: the router sends a transfer and the call ends with reason angry"; `apps/api/test/front-desk/scenarios.test.ts`: "scenario %s meets its must and mustNot" (the angry-caller scenario).
14. **Nobody answering returns the caller to a message**
    - `apps/api/test/front-desk/voice-transfer-hooks.test.ts`: "after-dial no answer returns to the relay in message_only mode"; "after-relay with no on-call members goes to message mode"; "after-dial no answer with members left dials the next one"; "after-dial voicemail mode, not answered, records a message".
    - `apps/api/test/front-desk/tools-handoff.test.ts`: "no on-call members gives message mode"; "after hours and not urgent gives message mode".
    - `apps/api/test/front-desk/relay-loop.test.ts`: "message-only mode sends kind end for a handoff".
    - `apps/api/test/front-desk/relay.test.ts`: "a message_only reconnect works for a call in status %s".
    - Manual: M6.

## Guards, in calls and in texts

15. **The price guard blocks every listed phrase**
    - `packages/shared/test/front-desk-guards.test.ts`: "guardSentence blocked > %s -> %s" (every price row); "guardSentence allowed > %s"; "guardSentence replacements > exact coverage and damage text"; "guardSentence replacements > replacement sentences never trip a guard"; "guardSentence replacements > table size".
    - `apps/api/test/front-desk/engine.test.ts`: "guard replacement is recorded in guard_hits"; "opus route streams guarded sentences"; "fast reply is guarded".
    - `apps/api/test/front-desk/texts.test.ts`: "guard applied to texts".
    - `apps/api/test/front-desk/prompt.test.ts`: "fillers pass guards unchanged and cover every slow tool"; "prompt forbids prices coverage and damage claims".
    - Manual: M0 (`--llm`, the price line) and M3.
16. **The coverage guard blocks every listed phrase**
    - `packages/shared/test/front-desk-guards.test.ts`: "guardSentence blocked > %s -> %s" (every coverage row); "guardSentence replacements > exact coverage and damage text".
    - `apps/api/test/front-desk/engine.test.ts`: "guard replacement is recorded in guard_hits"; "fast reply is guarded".
    - `apps/api/test/front-desk/texts.test.ts`: "guard applied to texts".
    - Manual: M0 (`--llm`, the insurance line) and M4.
17. **The damage guard blocks every listed phrase**
    - `packages/shared/test/front-desk-guards.test.ts`: "guardSentence blocked > %s -> %s" (every damage row); "guardSentence allowed > %s" (a question about damage is allowed); "guardSentence replacements > two hits list both once, in order, replacements joined"; "guardSentence replacements > repeated hits of one kind appear once".
    - `apps/api/test/front-desk/engine.test.ts`: "guard replacement is recorded in guard_hits".
    - `apps/api/test/front-desk/tools-jobs.test.ts`: "with no records it says so and claims nothing about damage".
    - Manual: M4.

## Texts

18. **Texts get replies through the gate**
    - `apps/api/test/front-desk/texts.test.ts`: "three quick texts produce one reply"; "the reply goes through the gate as informational"; "an opted-out customer gets a blocked reply and nothing is sent"; "STOP never reaches Front Desk"; "a reply within 10 minutes of the customer text sends at 23:00 company time despite quiet hours"; "the engine is offered TEXT_CHANNEL_TOOLS only".
    - `apps/api/test/front-desk/conversations-routes.test.ts`: "reply goes through the gate as informational, sets handledBy team and teamUntil = now+2h, message row queued"; "reply to a blocked/unsubscribed customer is not sent"; "reply validates the body and only works on texts".
    - `apps/web/e2e/front-desk.spec.ts`: "a staff reply to a text goes out through the gate and puts the team in charge; the switch hands it back".
    - `apps/web/test/d1-t22-reply.test.tsx`: "sends the typed text and clears the box"; "shows the send-gate sentence plainly and keeps the typed text".
    - Manual: M10.
19. **...unless a team member replied in the last 2 hours**
    - `apps/api/test/front-desk/texts.test.ts`: "a team reply silences the assistant for 2 hours"; "a team reply older than 2 hours does not silence it".
    - `apps/api/test/front-desk/conversations-routes.test.ts`: "reply goes through the gate as informational, sets handledBy team and teamUntil = now+2h, message row queued".
    - `apps/web/e2e/front-desk.spec.ts`: "a staff reply to a text goes out through the gate and puts the team in charge; the switch hands it back".
    - Manual: M10.
20. **...or the conversation is set to "Team is handling"**
    - `apps/api/test/front-desk/texts.test.ts`: "handled_by team is silent".
    - `apps/api/test/front-desk/conversations-routes.test.ts`: "handling switch".
    - `apps/web/e2e/front-desk.spec.ts`: "a staff reply to a text goes out through the gate and puts the team in charge; the switch hands it back".
    - `apps/web/test/d1-t22-summary.test.tsx`: "switches the team on: a switch on an assistant conversation posts by team"; "switches the team off: a checked switch posts by assistant".
    - Manual: M10.

## Missed-call text-back, spam

21. **Missed-call text-back follows Decision 11**
    - `packages/shared/test/front-desk-rules.test.ts`: "shouldTextBack" (the rows of the table).
    - `apps/api/test/front-desk/after-call.test.ts`: "a mobile caller who hung up before the first turn is texted back as informational with call consent"; "a failed call of 40 seconds is texted back"; "a completed call with 2 caller turns and 60 seconds is skipped"; "a second missed call from the same number within 24 hours is skipped"; "a spam call is skipped"; "the company setting off skips the text-back"; "during quiet hours the text waits: scheduled, not sent"; "a failed call with no conversation gets the missed-call text through the job".
    - `apps/api/test/front-desk/after-call.test.ts`: "lookup cached: two calls from the same mobile number look it up once"; "an unknown answer is not cached: the number is looked up again next time".
    - `apps/api/test/front-desk/lookup.test.ts`: "calls Lookup v2 with Basic auth"; "maps a missing line_type_intelligence to unknown".
    - `apps/api/test/front-desk/spam-rules.test.ts`: "a fully eligible call is texted back unless it is marked spam".
    - Manual: M11.
22. **Spam rules reject or end calls as specified**
    - `apps/api/test/front-desk/spam.test.ts`: "a blocked number is rejected before the relay with no ai seconds"; "STIR failure from an unknown number rejects only after more than 3 calls in an hour"; "STIR failure with at most 3 calls in an hour is not rejected"; "a known customer is never rejected by the STIR rule".
    - `apps/api/test/front-desk/spam-rules.test.ts`: "the STIR limit is three calls an hour"; "the suffixed failed verstat counts as failed"; "the reason constants match the stored strings".
    - `apps/api/test/front-desk/spam-engine.test.ts`: "a sales_pitch intent ends politely and marks the conversation spam"; "a spam intent with route end ends politely and marks the conversation spam"; "a spam intent wins over a fast reply from the router"; "end_call tool with reason spam marks the conversation spam"; "a normal intent is unaffected".
    - `apps/api/test/front-desk/voice-hooks.test.ts`: "a screened call is rejected and the row is rejected".
    - `apps/api/test/front-desk-fakes.test.ts`: "screenCall rejects a blocked number".
    - `apps/api/test/front-desk/texts.test.ts`: "a spam text gets no reply and ends the conversation".
    - `apps/api/test/front-desk/retention.test.ts`: "spam is swept at 7 days".
    - T19: `apps/api/test/front-desk/call-paths.test.ts`: "spam: a sales pitch is answered with the polite ending and marked spam on the conversation and the call"; `apps/api/test/front-desk/scenarios.test.ts`: "scenario %s meets its must and mustNot" (the spam-pitch scenario).
    - Manual: M12.
23. **"Mark as spam" blocks the number**
    - `apps/api/test/front-desk/spam.test.ts`: "marking a call as spam blocks the number, sets the call spam reason and the conversation outcome"; "marking the same call twice is idempotent"; "the office can mark a call as spam"; "a rep cannot mark spam (403)"; "unmarking returns 204 and the next call from that number is no longer rejected".
    - `apps/web/e2e/front-desk.spec.ts`: "Mark as spam blocks the number and moves the call to the Spam filter".
    - `apps/web/test/d1-t22-summary.test.tsx`: "marks the last call as spam on a voice conversation"; "hides Mark as spam for a text conversation"; "shows the spam mark instead of the button once the call is marked".
    - Manual: M12.

## After each call

24. **A summary is written and the conversation closed**
    - `apps/api/test/front-desk/after-call.test.ts`: "saves the summary on the conversation and closes it"; "no transcript stored: summary from actions only"; "the fd-after-call job does the same work from the queue".
    - `apps/web/e2e/front-desk.spec.ts`: "a call opens with its disclosure, transcript, action cards and summary, and is marked read".
    - T19: `apps/api/test/front-desk/scenarios.test.ts`: "scenario %s meets its must and mustNot" runs the after-call job at the end of every scenario except spam (a spam call is billed and left unsummarised by design) and checks the summary, the closed conversation and, for a booking, claim or message, the outcome.
    - Manual: M13.
25. **The outcome is set (actions win over the model)**
    - `apps/api/test/front-desk/after-call.test.ts`: "actions win over the model outcome when the job runs"; "outcome precedence: actions win over the model".
    - `apps/web/test/d1-t21-window.test.tsx`: "renders name, outcome, unread badge, the link to the conversation, and the unknown caller".
26. **A timeline card is created**
    - `apps/api/test/front-desk/after-call.test.ts`: "timeline card created".
    - `apps/web/test/d1-t26-timeline.test.tsx`: "a call activity shows summary, outcome chip and a conversation link"; "a text conversation shows the text label"; "a call without data is a plain activity row".
    - Manual: M13.
27. **`ai_call_minute` is recorded once**
    - `apps/api/test/front-desk/after-call.test.ts`: "one usage event even if the job runs twice"; "spam calls bill AI seconds only"; "forwarding-test calls are skipped".
    - `apps/api/test/front-desk/relay.test.ts`: "ai_seconds is measured from the clock between open and close".
    - Manual: M13 (the count of events for a real call is 1).

## Retention

28. **The retention sweep deletes recordings per the settings**
    - `apps/api/test/front-desk/retention.test.ts`: "boundaries by days"; "recording_retention_days = 0 sweeps nothing"; "is idempotent"; "sweeping company A never touches company B"; "fans out across companies and isolates failures"; "forwarding-test calls are skipped".
    - `apps/api/test/front-desk/recording-playback.test.ts`: "delete removes the object, and a missing key does not throw"; "a call with no stored recording is 404".
    - Manual: M8 (blocked until R2 is wired).
29. **...and blanks transcripts per the settings**
    - `apps/api/test/front-desk/retention.test.ts`: "turn text is blanked, metadata and summaries kept"; "purgeCustomerConversations purges at once"; "archiving a customer does not purge".
    - `apps/api/test/front-desk/conversations-routes.test.ts`: "detail hides turn text when not stored"; "a swept tool record ({name, ok}) still reads as done, and a deleted or never-made recording is not playable".
    - `apps/web/test/d1-t22-view.test.tsx`: "says the transcript was removed after the retention period when it was stored".
30. **Twilio's copy of a recording is deleted once stored**
    - `apps/api/test/front-desk/recording-store.test.ts`: "copies the recording to file storage, then deletes it at Twilio"; "running twice puts once and does not throw"; "a failed upload throws, and the next attempt succeeds"; "without file storage the recording stays at Twilio and nothing throws".
    - `apps/api/test/front-desk/twilio-call-control.test.ts`: "deleteRecording sends DELETE".
    - Manual: M8.

## Forwarding

31. **The forwarding test verifies and turns the `phone_number` setup step done**
    - `apps/api/test/front-desk/forwarding.test.ts`: "a call from the test caller to the company line marks forwarding verified and the setup item done"; "a spoofed test call (right From, no ForwardedFrom, no passing verstat) does not verify"; "ForwardedFrom equal to the business phone verifies"; "StirVerstat TN-Validation-Passed-A verifies"; "no arrival by the 30 s timeout fails the test with the likely cause"; "the test call is placed at most once a minute per company"; "another company's pending test is not matched by a call to a different company's line".
    - `apps/web/e2e/front-desk.spec.ts`: "Settings: the forwarding guide shows codes per carrier, and the test verifies, then Front Desk can be turned on".
    - `apps/web/test/d1-t24-test.test.tsx`: "shows calling, then verified after the poll, and posts once"; "shows the not-received message and a retry label, and posting again starts a new test".
    - `apps/web/test/d1-t24-guide.test.tsx`: "shows the Verizon all-calls code and the off code"; "shows the AT&T codes"; "renders the steps as ordered lists with the strings from forwardingSteps".
    - `packages/shared/test/forwarding.test.ts`: "verizon all-calls codes"; "AT&T, T-Mobile and other GSM use **21 / **61 codes"; "landline uses *72 / *73 in both modes"; "is deterministic".
    - Manual: M9 (the codes on a real phone for each carrier).
32. **Front Desk cannot be enabled before verification, unless the owner overrides**
    - `apps/api/test/front-desk/forwarding.test.ts`: "Front Desk cannot be enabled before verification unless override: true from the owner (Task 18)".
    - `apps/api/test/front-desk/settings-routes.test.ts`: "enable blocked before verification"; "a company without a number cannot enable, even with override"; "office can save but cannot override"; "owner override:true enables without verification".
    - `apps/web/test/d1-t23-front-desk-tab.test.tsx`: "turns the switch off with the blocked sentence when forwarding is not verified"; "enables the switch when nothing blocks it".
    - `apps/web/e2e/front-desk.spec.ts`: "Settings: the switch is blocked until forwarding is verified, facts save, and bad numbers are refused".
    - Manual: M9.

## Latency

33. **Per-turn timings are stored**
    - `packages/db/test/repos-conversations-turns.test.ts`: "insertTurn stores timings tokens and guard hits".
    - `apps/api/test/front-desk/stats-routes.test.ts`: "p50 first reply ms is the median and null with no replies"; "stats from seeded calls, conversations and turns (exact numbers)".
    - T19: `apps/api/test/front-desk/call-paths.test.ts`: "booking: find times, book the offered slot, then goodbye"; "job question (verified): verify_caller then lookup_my_jobs shows the job"; "recording objection: recording stops, turns are saved with blank text and a system turn"; `apps/api/test/front-desk/scenarios.test.ts`: "scenario %s meets its must and mustNot" (every assistant turn of all thirteen scenarios has its router and total time, and an Opus turn its first-token time).
    - Manual: M13 (the percentile query over real turns).
34. **The eval report lists p50 and p95**
    - Manual: M13 and M14. No automated test can produce the numbers, because they need the real models. Task 25 built the scripted evals (`npm run eval:front-desk -w @roofline/api -- --confirm-spend`) and the report template with its empty results tables (`docs/superpowers/d1-latency.md`, "not run yet"; the owner fills it in by hand after the first run).
   - Automated proof of the plumbing (no model): `apps/api/test/front-desk/eval-front-desk.test.ts`: "runs the chosen scenarios, writes the json and markdown files, and exits 0"; "latencyRows gives p50 and p95 per scenario and route, and for all scenarios"; "cost comes from usage at the model price, and an unknown model is priced as Opus". `apps/api/test/smoke-front-desk-guards.test.ts`: "without --confirm-spend it prints the refusal, reads no setting and exits 1"; "without ANTHROPIC_API_KEY it stops before any request"; "apps/api/package.json has the script, and no workflow runs it".

## Tenancy

35. **No route reaches another company's data**
    - `apps/api/test/front-desk/conversations-routes.test.ts`: "cross-tenant 404 on GET detail, reply, handling, read".
    - `apps/api/test/front-desk/settings-routes.test.ts`: "cross-tenant: a user of company B never changes company A".
    - `apps/api/test/front-desk/stats-routes.test.ts`: "cross-tenant: company B sees none of A data".
    - `apps/api/test/front-desk/spam.test.ts`: "cross-tenant call ids are 404 and company A rows are untouched"; "cross-tenant blocked-number ids are 404 and company A rows are untouched".
    - `apps/api/test/front-desk/recording-playback.test.ts`: "another company's call, an unknown id and a non-UUID id are 404".
    - `apps/api/test/front-desk/forwarding.test.ts`: "another company's test is not found".
    - `apps/api/test/front-desk/voice-hooks.test.ts`: "company B's number never routes to company A".
    - `apps/api/test/front-desk/voice-transfer-hooks.test.ts`: "company B number never reaches company A members".
    - `apps/api/test/front-desk/retention.test.ts`: "sweeping company A never touches company B".
    - `packages/db/test/repos-conversations-turns.test.ts`: "company B cannot see or update company A turns".
    - `packages/db/test/rls.test.ts`: "front desk tables" (the group: both companies seeded, each sees only its own rows; the privilege tests "app_tenant cannot DELETE conversation_turns" and "app_system holds exactly the column privileges the call, turn and conversation fan-outs need").
36. **No tool reaches another company's data, or an id it was not shown**
    - `apps/api/test/front-desk/engine.test.ts`: "unknown id is refused and the handler does not run"; "a shown id is allowed"; "invalid tool input is an error result and the handler does not run".
    - `apps/api/test/front-desk/tools-caller.test.ts`: "another company's customer with the same phone is never matched"; "another company's customer cannot be verified".
    - `apps/api/test/front-desk/tools-booking.test.ts`: "confirm_appointment > another customer's visit cannot be confirmed"; "move_inspection > another customer's inspection is not found".
    - `apps/api/test/front-desk/tools-jobs.test.ts`: "a property id the model was not shown is refused"; "needs verification".
    - `apps/api/test/front-desk/tools-forecast.test.ts`: "a property id that was not shown is rejected".
37. **No socket reaches another company's data**
    - `apps/api/test/front-desk/relay-token.test.ts`: "token for company A does not verify for company B"; "token for call 1 does not verify for call 2"; "expired token (now advanced by TTL+1ms) is false".
    - `apps/api/test/front-desk/relay.test.ts`: "company A token with company B call closes 1008"; "a bad token closes 1008"; "a second socket for the same call closes 1008"; "an oversized frame closes the socket"; "the pre-auth cap refuses extra upgrades with 503"; "a token for a %s call is refused".
    - `apps/api/test/front-desk-skeleton.test.ts`: "the /relay upgrade closes with 1008 and any other upgrade path is refused".
    - Manual: M1 (a real call connects through the relay with its own token).
38. **Reps see only their customers' conversations**
    - `apps/api/test/front-desk/conversations-routes.test.ts`: "rep sees only conversations of their customers"; "rep sees unknown-number conversations only when on call".
    - `apps/web/e2e/front-desk.spec.ts`: "a field rep sees none of the owner conversations and has no Front Desk settings".
    - `apps/web/test/d1-settings.test.tsx`: "is hidden from a field rep"; "sends a field rep who opens it to Company".
39. **...without recordings of transferred legs**
    - `apps/api/test/front-desk/conversations-routes.test.ts`: "canPlayRecording per role (owner true, rep own-customer true, rep transferred call false)".
    - `apps/api/test/front-desk/recording-playback.test.ts`: "a rep cannot play a transferred leg even for their own customer"; "a rep plays a call of a customer they created but not another rep's customer"; "%s gets a 302 to a signed url"; "Accept: application/json answers url and expiresAt, 300 seconds after the app clock".
    - `apps/web/test/d1-t22-summary.test.tsx`: "renders nothing when the role cannot play the recording".
    - Manual: M8 (a rep sees the player for their own customer's call only).

## UI rules

40. **Copy rules: vendor names only in `copy/connections.ts`, `copy/forwarding.ts` and `legal.ts`; plain words**
    - `apps/web/test/copy-rules.test.ts`: "uses no technical words"; "uses no enum tokens"; "names vendors only where connecting accounts or paying".
    - `apps/web/test/d1-copy.test.ts`: "names no carrier in the Front Desk words"; "has no empty Front Desk words"; "leaves the step sentences to the shared package".
41. **12px floor**
    - `npm run lint:css` (stylelint rule `roofline/min-font-size`, `stylelint.config.js`), run by the Platform job on every push; it covers every Front Desk stylesheet. `apps/web/test/d1-t23-on-call-list.test.tsx`: "gives the up, down and remove buttons a 40px minimum size in the stylesheet" covers the 40px rule.
42. **axe has no serious or critical violations, and there is no horizontal scroll at 375px**
    - `apps/web/e2e/a11y.spec.ts`: "Front Desk inbox has no serious accessibility violations"; "Front Desk conversation has no serious accessibility violations"; "Front Desk text conversation has no serious accessibility violations"; "Settings Front Desk has no serious accessibility violations"; "Settings Your profile has no serious accessibility violations".
    - `apps/web/e2e/phone.spec.ts`: "D1 Front Desk pages do not scroll sideways" (the inbox, a call, a text conversation, Settings, Front Desk and Your profile at 375 by 812).

## Browser flows (Playwright, `apps/web/e2e/front-desk.spec.ts`)

Not a separate criterion; these are the spec section 16 browser items and where each is proven:

- The Front Desk window with seeded conversations: "an empty inbox says calls will show up once forwarding is on"; "the inbox lists calls and texts, newest first, with live, unread and urgent states".
- A call's transcript with action cards: "a call opens with its disclosure, transcript, action cards and summary, and is marked read".
- The dock badge: "the dock badge counts conversations that need attention and drops when one is opened".
- A text reply through the inbox: "a staff reply to a text goes out through the gate and puts the team in charge; the switch hands it back".
- Settings and the transfer phone: "Settings: the switch is blocked until forwarding is verified, facts save, and bad numbers are refused"; "Settings: your profile saves the transfer phone only with the recording acknowledgement".
- The forwarding test with fakes: "Settings: the forwarding guide shows codes per carrier, and the test verifies, then Front Desk can be turned on". The stack runs with `TWILIO_TEST_CALLER_NUMBER` set; the fake call control takes the test call and the test posts the call Twilio would forward, signed with the company's token.
- Rep isolation: "a field rep sees none of the owner conversations and has no Front Desk settings".

## Gaps

- Everything that needs a real provider is the manual smoke: the real Claude models (M0, M13, M14), real calls and the disclosure as heard (M1), a real transfer (M5, M6), the codes on real carrier phones (M9), real texts (M10, M11).
- R2 is not wired in this build (`apps/api/src/providers/r2.ts` returns nothing until E1's object store merges), so the recording-in-R2 and deleted-at-Twilio proof (criteria 28 and 30 in the real world, M8) cannot be run yet. The fakes prove the copy and the delete.
- Criterion 34 (the p50 and p95 report) has no automated test and belongs to Task 25 and the manual runs M13 and M14.
- Criterion 8 (an install the caller wants moved is refused, then a message is offered) has no end-to-end call: the refusal is proved at the tool and the message at the call-path level, but no scripted call asks to move an install. A scenario for it would need an install appointment whose id the model has been shown; spec section 16 does not list it.
- The scripted scenarios in CI use a ScriptedLlm, so they prove the plumbing, the data and the grading code, not what the real models say. That is the by-hand eval (criterion 34).
