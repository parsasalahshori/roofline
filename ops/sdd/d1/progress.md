# SDD ledger — plan: docs/superpowers/plans/2026-10-12-roofline-front-desk.md

Spec: docs/superpowers/specs/2026-10-12-roofline-front-desk-design.md. Branch `d1-front-desk`, to be created from `s1-storm` once S1 is merged (C1, E1 and S1 are not built yet; at writing `origin/f3-setup` is 7b988eb). Briefs: `ops/sdd/d1/task-<N>-brief.md`; constraints: `ops/sdd/d1/global-constraints.md`. Rulings use the prefix **D**. Names marked **[C1]** / **[E1]** / **[S1]** come from those plans and briefs and must be checked against the merged branches before each task starts.

## C1 / E1 / S1 dependencies (check against the real code when merged)

| From | Name D1 uses | D1 tasks |
|---|---|---|
| C1 T1 | `appointments` table (gains `confirmed_at`, `confirmed_via`) | T1 |
| C1 T3/T9 | `findSlots`, `DEFAULT_DURATION_MINUTES`, `busyFor`, `bookableMembers`, work hours | T8, T9 |
| C1 T6 | `createJob`, `updateJob`; `jobs.next_step`/`next_step_on` as Today follow-ups | T8, T9 |
| C1 T8 | `createAppointment`, `updateAppointment`, `setAppointmentStatus`, `listAppointmentsForCustomer` (inspection auto-move, calendar push) | T7, T8 |
| C1 T18 | `router.tsx`, `shell/apps.ts`, Settings tabs | T20, T23 |
| C1 T19/T24/T27 | `features/timeline/Timeline.tsx`, `features/appointments/AppointmentDetail.tsx`, `features/today/*` | T26 |
| C1 T25 / E1 T18 / S1 | `features/setup/SetupRow.tsx` | T24 |
| E1 T1 | `STORED_FILE_KINDS` (in `shared/proposals.ts`), `stored_files` | T1, T12 |
| E1 T5/T13 | `ObjectStore` (R2), `storeFile`, `readStoredFile` | T12, T16 |
| E1 T8 | proposal status (`getProposal`) | T7 |
| S1 T1 | migrations end at `0017`; `SMS_CONSENT_SOURCES` has `door` | T1 |
| S1 T9 | `storm_hits` | T7 |
| S1 T21 | `onStormReply` call in `hooks/twilio.ts` (Front Desk goes after it) | T14 |
| C1/E1/S1 T5/T7 | `JOB_NAMES`, `SCHEDULES`, `AppDeps`, mounts already extended | T4 |

## Pre-flight scan

| Pair / task | Produces vs consumes | Finding |
|---|---|---|
| T1↔F1 | `memberships` is global; `users.phone_e164`, `companies.phone_e164` exist | consistent |
| T4↔F3 server | the WebSocket upgrade needs the HTTP server: `server.ts` keeps `const server = app.listen(...)` | consistent |
| T4/T5↔owner rule | Claude via the Anthropic TS SDK only; no live calls in CI | gap → Rulings DA, DB |
| T4↔T7 | `WeatherSource` has only `current`; `FakeWeatherSource` lives in T4's `test/helpers.ts` | conflict → Ruling DC |
| T8↔C1 | bookings through C1's appointment repo | consistent ([C1]) |
| T10↔F3 | signature and routing helpers from `hooks/twilio.ts` / `@roofline/db/system` | consistent |
| T13↔C1 timeline | plan has "timeline cards" for calls; C1's `TimelineItem` is `'activity' \| 'text'` | gap → Ruling DG |
| T14↔S1 | inbound handler order STOP → S1 YES → Front Desk | consistent ([S1]) |
| T17↔F3 | plan sets voice URLs "on `Registrar.ensureNumber` results" — that is F3's provisioning job | conflict → Ruling DE |
| T20↔F2 | the dock badge needs `Shell.tsx` (`badgeFor`, `counts['front-desk']`) | gap → Ruling DH |
| T23↔F1 | transfer phone vs the user's own phone | gap → Ruling DF |
| T26 self | plan names `features/{customer,job}/Timeline*.tsx`, `features/calendar/AppointmentSheet.tsx`, `shell/dock/badges.ts`; real (C1) paths differ | gap → fixed in the T26 brief to C1's paths — cost: none |

Ruling DA: the only Claude client is the Anthropic TypeScript SDK (`@anthropic-ai/sdk`) behind the `Llm` seam, with model ids exactly `claude-haiku-5-5` and `claude-opus-5-5`; tests use `ScriptedLlm` only (the adapter's own test uses a scripted fake `fetch` with recorded fixtures) — owner instruction — cost if wrong: none.
Ruling DB: Task 4 adds a guard test: `anthropicFor(testConfig())` is null, the test app's `llm` is `ScriptedLlm`, and `FAKE_PROVIDERS=1` forces `ScriptedLlm` even with a key set; CI has no Anthropic key — no live API call can happen in CI — cost if wrong: none.
Ruling DC: Task 4 adds a `daily()` method returning null to `FakeWeatherSource` in `test/helpers.ts`; Task 7 adds `daily(lat, lng, days)` to `WeatherSource`/`NullWeatherSource`/NWS — keeps `test/helpers.ts` with the skeleton task — cost if wrong: none.
Ruling DE: Task 17 does not edit F3's number provisioning; voice URLs are set when Front Desk settings are first saved and by a repair pass in the `fd-health` schedule — F3's provisioning job is not D1's file — cost if wrong: up to 2 minutes before a new number answers calls.
Ruling DF: the transfer phone is prefilled from `users.phone_e164` and saved to `memberships.transfer_phone_e164` only with the recording acknowledgement — cost if wrong: none.
Ruling DG: calls and text conversations reach C1's timeline as **activities** (`kind 'call'` / `'text_conversation'`, summary text) written by the after-call job; the web timeline adds a link for those kinds — C1's `TimelineItem` type stays unchanged — cost if wrong: calls look like other activity lines.
Ruling DH: Task 20 edits `shell/Shell.tsx` once (the `'front-desk'` count from a placeholder `useFrontDeskUnread()` and a `frontDeskBadge` label); Task 26 fills the hook — the dock badges live in `Shell.tsx`, not a `badges.ts` — cost if wrong: none.

## Waves (from the plan)

- W1: T1. W2: G1 = T2, T3. W3: G2 = T4, T20.
- W4: G3 = T5, T6, T10 · G4 = T7, T8, T9 · G5 = T21, T22, T23.
- W5: G6 = T11, T12, T14 · G7 = T15, T17, T24.
- W6: G8 = T13, T19, T26 · then G9 = T16, T18, T25.
- W7: T27.

## Tasks

## Build log
d1-front-desk started at c1-crm dfa9132 (F2, F3 34/37, C1 T1-T4) as parallel Track B (AGENTS.md "Parallel tracks"). Track lead: session_0166agXYjDy39PFyUw1BXtLR, reporting to the controller session_01LXtxzoHNoWz5SACkLF1d2p. Upstream checks: C1 `appointments` exists (T1); E1 `STORED_FILE_KINDS`/`stored_files` and S1 `door`/`storm_hits` do not exist yet.
Ruling DI: D1 migrations are `0019_front_desk_schema.sql` (generated) and `0020_front_desk_grants_rls.sql` (custom) per Ruling AP; drizzle-kit generates them as 0015 on this base, so Task 1 renames the SQL, snapshot and journal tag (journal idx stays sequential) — cost if wrong: the controller re-orders the journal at track merge.
Ruling DJ: Task 1 leaves `STORED_FILE_KINDS` alone (E1 has not built it). When `e1-estimator` merges into `d1-front-desk`, the merger adds `'call_recording'` to E1's `STORED_FILE_KINDS` and appends the `stored_files` kind CHECK swap to `0020` (pre-release, nothing deployed); Task 12 waits for E1's `ObjectStore` — cost if wrong: one migration edit at merge.
Task 1 (wf_ce2e8d0c-fc0, contact 301; Haiku builders, launched before Ruling AQ reached this track): 94a84fc + CI fix b18462e (unique `messages (company_id, id)` for the `calls.text_back_message_id` composite FK) + report 703cd28. Review clean (0 rounds). CI 38194858730 green at b18462e (Platform, E2E, v1). Task 1: complete. Merged into d1-front-desk bbc2ef2; typecheck, lint clean; playwright-core 1.56.1 only.
Ruling DK: `memberships` gets no app_tenant grant (global table, no RLS; a tenant grant would reach other companies' rows). `transfer_phone_e164`, `on_call_order`, `recording_ack_at` are written through `@roofline/db/system` on the app_system pool, which already has ALL on memberships (0002); Task 23's transfer-phone route uses a system function scoped to the session's own membership — cost if wrong: none.
Ruling DL: 0020 also grants app_system SELECT on `calls.recording_key`/`recording_status` (the retention sweep needs the key to delete the file) — deliberate extension of the brief.
Minors (deferred): rename the rls test 'app_system: column-level SELECT only on the scheduler columns' to 'column-level privileges only'; journal trailing newline.
CI outage (Ruling AS): Actions was down 02:18Z-02:27Z (billing); the repo is now public, so never commit secrets, tokens or real customer data. Owner and controller confirmed the T1 merge push; Rulings DK, DL accepted by the controller; at the cross-track merge keep one `messages (company_id, id)` unique constraint with one name.
Wave 2: T2 (Sonnet builders, Ruling AQ) and T3 branch from d1-t1 b18462e (= the merged T1 code).
Task 2 (shared guards, rules, consent states): built on d1-t1 b18462e. Transfer, caller-match and text-back rules live in `packages/shared/src/front-desk-rules.ts`, not `front-desk.ts`; guards and SentenceBuffer are in `front-desk.ts`; consent states in `recording-consent.ts`. Verify: typecheck, lint, shared vitest 754 passed. See task-2-report.md.
Task 3 (shared tool schemas, forwarding codes): built on d1-t1 b18462e. front-desk-tools.ts (13 strict tools, toolJsonSchemas) and forwarding.ts (12 carriers, forwardingSteps). Review clean. Verify: typecheck, lint, shared vitest 428 passed. See task-3-report.md.
Wave 2 (wf_20b1d59a-ba7, contact 301): T2 7401fa4 (Sonnet builders; review clean after 2 fix rounds; CI 38197247857 green), T3 42fbd7a (review clean, 0 rounds; CI 38196682973 green). Tasks 2 and 3: complete. Merged into d1-front-desk cdd9f45 (T2), 05909e3 (T3); ledger conflict only (kept both). Merged result: typecheck, lint clean; shared vitest 20 files / 801 passed.
Ruling DM: `toolJsonSchemas()` passes zod's string and number limits (minLength/maxLength, uuid and datetime regex patterns) into the strict tool schemas, which Anthropic strict tool use may reject. Carry to Task 5: `strictify` in `packages/shared/src/front-desk-tools.ts` drops the keywords strict tool use does not support (check the current Anthropic docs: string length, numeric bounds, `pattern` where `format` is present; keep the simple IsoDate pattern only if supported), with a test that no emitted schema has them; the engine's zod `.parse` still enforces every limit — cost if wrong: a 400 on the first live call.
Ruling DN: Task 2 put the transfer, caller-match, text-back and turn-limit rules in `packages/shared/src/front-desk-rules.ts` (re-exported from the barrel), not `front-desk.ts`; later tasks import them from `@roofline/shared` — cost if wrong: none.
Carries: Task 6 adds a type-level check that the `transfer_to_person` reason enum equals `Exclude<TransferReason, 'model_failure'>`; Task 24 renders `forwardingSteps` text as data (not duplicated in copy/*.ts). Follow-up before acceptance (Task 27): check the NANP area-code table in `recording-consent.ts` against a NANPA list (written from memory). Minors: coverage guard also blocks the question "Are you covered by insurance?" (conservative); IsoDate is regex-only (2026-13-45 passes).
Merged origin/c1-crm cd7d719 (C1 T5 API skeleton, T18 web skeleton, f3-setup c0d65d8) into d1-front-desk on the controller's word (C1 T5/T18 task branches CI-green; Rulings DM, DN accepted). Clean merge; lockfile unchanged in D1 terms (playwright-core 1.56.1 only); journal 13/14 C1, 15/16 D1 (0019/0020); typecheck, lint, lint:css clean. T4 (running, base 6818b9f) predates C1 T5: its merge resolves JOB_NAMES/SCHEDULES/AppDeps/app.ts mounts/test helpers keep-both (C1 lines first, then the '// D1 Front Desk' blocks).
Ruling DO: Settings has no 'Your profile' area and ScheduleTab is C1's placeholder, so Task 20 appends two tabs to SETTINGS_TABS: 'front-desk' (owner/office; FrontDeskTab) and 'profile' (everyone; ProfileTab holding TransferPhone) — cost if wrong: one extra tab. Wave 3b: T20 (Sonnet builders, Ruling AQ: shell UI) running wf_70922b10-1f4, contact 304, base c7cd3d0.
Task 4 (wf_ac944179-482, contact 301; Sonnet builders): b548ebc, review clean after 1 fix round; CI 38198952859 green on b548ebc (incl. DB suites). Its base predates C1 T5, so d1-front-desk was merged INTO d1-t4 (6a9385a; 6 keep-both conflicts in app.ts, jobs/{handlers,queue,worker}.ts, test/{jobs,pgboss}.test.ts, C1 lines first then the '// D1 Front Desk' blocks; JOB_NAMES = import-customers, texting-registration, calendar-push, fd-after-call, fd-recording-store, fd-text, fd-forwarding-test; JobData gains appointmentId + D1 ids; T4's SendOptions kept). Typecheck and lint clean on 6a9385a; CI on 6a9385a pending before the merge into d1-front-desk.
Ruling DP: there is no SESSION_SECRET, so a missing RELAY_TOKEN_SECRET is derived by HKDF-SHA256 from ENCRYPTION_KEY (info 'relay', empty salt, 32 bytes, base64); Task 11 treats RELAY_TOKEN_SECRET as an opaque string key in both cases. Rotating ENCRYPTION_KEY also ends live relay tokens (calls last minutes) — cost if wrong: none.
Ruling DQ: schedules run in the worker process, so `fd-health` cannot set the API process's `relaySessions.llmHealthy`. Task 6 makes `llmHealthy` a per-process circuit breaker inside RelaySessions, fed by the engine's own Llm call outcomes (consecutive failures mark it unhealthy for a cool-down; no probe calls, no extra table); `fd-health` keeps only the voice-URL repair pass (Ruling DE) and the worker-side checks. The FRONT_DESK_MAX_CALLS cap counts per API process (one always-on host) — cost if wrong: an unhealthy model is detected on the next real turn rather than within 2 minutes.
Carries: Task 6 always calls `llm.answer()` inside its try (UnconfiguredLlm.answer throws synchronously). Minors: config defaults test compares RELAY_TOKEN_SECRET to itself; front-desk-skeleton.test.ts afterAll doesn't close the app; fd-retention shares 03:17 with prune-early-reports.
Task 20 (wf_70922b10-1f4, contact 304; Sonnet builders): f1cae99, review clean after 1 fix round, CI 38198897431 green; lead fix bd85933 (plain 'Google Voice'; copy/forwarding.ts joins VENDOR_FILES in copy-rules.test.ts instead of a split string), CI 38199628512 green. Task 20: complete. Merged into d1-front-desk; typecheck, lint, lint:css clean. Notes for later web tasks: copy/front-desk.ts exists (windowEmpty, conversationEmpty, settingsEmpty, transferPhone.{title,empty}) — extend it; routes are exactly /front-desk and /front-desk/:conversationId (read useParams<{ conversationId: string }>(); add any deeper route to app/router.tsx explicitly); Settings has nine tabs ('front-desk' owner/office with a rep redirect to /settings/company; 'profile' everyone); Task 26 tests the dock badge through the real useFrontDeskUnread and checks the tab nav at 375px.
Ruling AV (controller, amended; AGENTS.md): inbound texts in hooks/twilio.ts run S1 onStormReply, then G1 claims, then D1 queueFrontDeskText. Task 14 exports queueFrontDeskText so G1 can call it directly (to send "Thanks, got it." or continue the conversation) and skips a message an earlier handler consumed. When Task 4 merges, send its merge sha to the G1 session (session_01NbXKpWjMvEQwTqNmQCt6wp), which waits on the Llm seam and ScriptedLlm.
Ruling DR: the plan gives the web tasks and Task 18 no shared API contract, so the track lead added `packages/shared/src/front-desk-views.ts` (branch d1-views 2d9abbc: inbox list/detail, turns and tool cards, calls, recording link, weekly stats, settings with FRONT_DESK_LIMITS, voices, transfer phone incl. GET for the Ruling DF prefill, forwarding test). Tasks 12, 17, 18 return exactly these; Tasks 21-24 and 26 type their hooks with them — cost if wrong: field renames in one file.
Wave 4 web group (wf_1de58b90-968, contact 306; Haiku builders): T21, T22, T23 stacked on d1-views. File ownership to avoid conflicts: hooks in inbox-api.ts / conversation-api.ts / settings/settings-api.ts (T21 adds the re-exports to features/front-desk/api.ts), copy in copy/front-desk-{inbox,conversation,settings}.ts. Merge order: d1-views, T21, T22, T23.
d1-views 2d9abbc (Ruling DR view types): CI 38200901443 green; merged into d1-front-desk, typecheck and lint clean.
Task 21 (web: Front Desk window and stats): inbox-api.ts hooks, FrontDeskWindow, ConversationRow, WeekStats, copy/front-desk-inbox.ts; review 1 clean; web suite 478 passed. Hooks live in inbox-api.ts (api.ts only re-exports); tags are spans, chips are Button with aria-pressed.
Task 22 review fix F1: apps/web/test/d1-routes.test.tsx edited (the '/front-desk/abc' test, lines ~65-80 and a typed CONVERSATION_ABC fixture above the describe block). T22 replaced the T20 placeholder on purpose, so the test now renders the real conversation window (heading 'Pat Lee'; GET /api/conversations/abc and POST /api/conversations/abc/read stubbed). Flag for merge: Task 21 may also touch this file. Verify: d1-routes.test.tsx 5 passed; npm run typecheck clean; @roofline/web vitest 50 files / 482 passed.
Task 23 (Sonnet builders): Front Desk settings tab, on-call list and transfer phone built; review clean after round 2; web verify green (480 tests). Extends copy/front-desk-settings.ts; forwarding slot left empty for Task 24 (`data-forwarding-slot` section in FrontDeskTab).
