# Task 25 report: scripted call evals and the latency report

Status: **built, CI red on one honest assertion (two engine bugs below), waiting on the D1 lead.** Branch `d1-t25`.

## Scenarios (spec section 16, all 13)
`apps/api/test/front-desk/scenarios/*.ts`, one file each, indexed in `index.ts`: booking, booking-taken-slot, job-verified, job-unverified,
claim, price, insurance-coverage, angry-caller, active-leak, spam-pitch, recording-objection, prompt-injection, rambling-caller.
Each holds caller lines, a persona for the simulator, the seed, `scripted` (the ScriptedLlm turn per line), `must` (tools, failed tools,
ending and reasons, outcome, guard hits, phrases heard, words per turn, recording stopped), `mustNot` (phrases, tools; every scenario also
forbids repeating the disclosure) and a tone rubric. `price` and `insurance-coverage` carry a `slip` (a careless sentence CI plays to prove the guard stops it).

## Files added or changed
- `apps/api/test/front-desk/scenarios/{types,grade,world,script-helpers,index}.ts` and the 13 scenario files.
- `apps/api/test/front-desk/call-rig.ts`: T19's `rig`, `seedCaller` and constants moved out of `call-paths.test.ts` (which now imports them; test names unchanged).
- `apps/api/test/front-desk/scenarios.test.ts` (CI runner: definitions, grading unit tests, 13 scripted calls through the real relay loop/engine/tools, slip tests).
- `apps/api/test/front-desk/eval-front-desk.test.ts` (the eval harness proved with a ScriptedLlm, fake simulator/grader, and a scripted fetch for the Claude calls; no database).
- `apps/api/src/scripts/eval-front-desk.ts` and `apps/api/src/providers/anthropic/eval.ts`; `apps/api/package.json` (`eval:front-desk`); `smoke/guards.ts` (`--confirm-spend` sentence).
- `apps/api/test/smoke-front-desk-guards.test.ts` (eval refusals, no workflow runs it, Ruling DA scan; also `TRUST_PROXY` merged from 092068c8).
- `docs/superpowers/d1-latency.md` (template, "not run yet"), `d1-acceptance.md` (12 T19 rows), `d1-manual-smoke.md` (M13, M14 point at the report).

Run: `npm run eval:front-desk -w @roofline/api -- --confirm-spend [--scenario a,b] [--runs 3] [--out f.json]` (the script is in apps/api, as `smoke:front-desk` is).
The live eval does not use the database: tools are answered by `world.ts` doubles built from the seed, and it re-implements the engine's route handling
(`playCall`) using the shared guards, SentenceBuffer and shouldTransfer. DB-backed behaviour is proved by the CI runner; the live eval proves what the real models say and how fast.

## Ruling DA
The only `new Anthropic(` and the only value import of `@anthropic-ai/sdk` stay in `apps/api/src/providers/anthropic/`. The simulator and tone grader are in `providers/anthropic/eval.ts`
(Haiku via `buildClients`, structured output); the script imports `evalModelsFor` from the folder's index. A test scans `apps/api/src` for any other client. No workflow sets `ANTHROPIC_API_KEY` or runs the eval; a test checks both.

## Acceptance rows filled (T19 lines)
Criteria 1, 3, 4, 8, 9, 10, 11, 12, 13, 22, 24, 33 now name real tests (call-paths titles and `scenario %s meets its must and mustNot`); every quoted name was checked to exist verbatim. Criterion 8 has no end-to-end call (listed under Gaps).

## [C1]/[E1]/[S1] names
None used by this task; no differences.

## Engine bugs found (files I may not edit)
1. **`calls.conversation_id` is never set.** Nothing in `engine.start`, `relay-session-loop`, `relay-server` or the repos writes it, so `runAfterCall` sees `call.conversationId === null` and never summarises, ends the conversation or writes the timeline card for a real call. (Inbox, retention, stats and spam marking all join on that column.) Fix: link the call in `engine.start` (it has `callId`) or in the relay server.
2. **`take_message` writes `conversations.summary`** (tools/message.ts), and `runAfterCall` skips the summary step when a summary exists, so even once (1) is fixed, a message call is never set `status = 'ended'` and gets no timeline card. Fix: after-call should key on `status`/a flag, or the tool should not set `summary`.
Both make the assertion in `scenarios.test.ts` `expectRows` ("the summary job ends the conversation", acceptance criterion 24) fail for 12 of 13 scenarios (spam skips it by design). I kept the assertion as the correct behaviour; the test links nothing itself. CI run 38283987813: every must/mustNot grade, DB row check, timing check and slip test passed; only this assertion failed (12 tests).

## CI
Run 38281757972 (first push): Platform red (a bug of mine, since fixed), E2E and v1 green. Run 38283987813 (b45f96a9): Platform red only on the two bugs above, E2E and v1 green. No green Platform run yet.

## Green after Task CV (C1 lead)
- The 12 red scenario tests were the two engine bugs (calls.conversation_id never set; take_message writing the summary), both fixed by Task CV.
- With CV's after-call waiting for a finished call, `expectRows` now ends the call (as Twilio's status callback does) before running after-call (efce699d). The assertion itself is unchanged.
- d1-front-desk bd84d6b (CV) merged in as 2dd74adc; call-paths.test.ts keeps CV's after-call checks and imports the rig from ./call-rig.ts.
- Local (Docker) on the CV merge: @roofline/api + @roofline/db 154 files, 3183 tests passed.
- CI run 38290781537 on 2dd74adc: Platform and E2E green.
