# D1 review D: pre-review notes 20, 31, 32, 33, 35, 43 (branch d1-rev-d)

Base: d1-front-desk 52a274f (merged with `--no-ff`). Note 42 was dropped by the D1 lead (task RA owns recording-store.ts and the recording SID).
Not touched: the T19 and RA/CV/RC files, `packages/db/src/repos/calls.ts`, `conversations.ts`, `routes/calls.ts`.

## Note 20: staff replies and skipped texts in the SMS detail
- `getConversationDetail` (packages/db/src/repos/conversation-inbox.ts) now merges, for `channel = 'sms'`, the conversation's `messages` rows (`messages.conversation_id`) with the turns, in time order. No new turns are written.
- A text is a line of its own unless a turn already shows it: an inbound text whose words sit inside the caller text turns, or an assistant text (`fd-text:`, `fd-book:`, `fd-textback:` keys) whose words sit inside the assistant text turns. A blanked text (retention) is hidden when a blanked turn of that speaker stands for it. Other outbound texts (staff replies) are speaker `team`; blocked, failed and scheduled outbound texts are not shown as said. Latest 500 texts.
- Contract: no new field. Text lines are `TurnView` with `callId` null, `position` 0, `id` = message id (documented in front-desk-views.ts). Web sorts by time, then position (ConversationView.tsx); no new copy needed.
- Tests: api `conversations-routes.test.ts` (merge, no repeats, blocked reply hidden, voice unaffected); web `d1-t22-view.test.tsx` (time order with position-0 lines).
- Caveat: the dedupe is by text, so it follows what T19's texts.ts writes into turns; once T19 changes turn wording, re-check.

## Note 31: grants narrowed in place (0020, Ruling AW)
Removed (no user found in packages/db/src/system/**, repos, apps/api, worker):
- app_system: `calls` SELECT conversation_id / recording_key / recording_status, UPDATE recording_key / recording_status (recording code reads and writes calls through withTenant: recording.ts, recording-store.ts, call-recording.ts); whole `conversations` SELECT(id, company_id, status); whole `conversation_turns` SELECT(id, company_id, at). Their `app_system_all` policies went with them.
- app_tenant: SELECT on `line_lookups` (only system/line-lookups.ts uses it); UPDATE on `blocked_numbers` (the repo only inserts with ON CONFLICT DO NOTHING, selects and deletes).
Kept:
- app_system `calls` SELECT(id, company_id, call_sid, status): system/relay-tokens.ts (relayCallById) and the app_system_all policy on calls.
- app_system SELECT, INSERT, UPDATE on `line_lookups`: system/line-lookups.ts (cachedLineType, saveLineType upsert).
- app_system UPDATE(capabilities, updated_at) on `company_phone_numbers`: the sync's grant for fd-health markVoiceUrlSet (kept as merged).
- app_tenant SELECT, INSERT, DELETE on `blocked_numbers`: blockNumber (insert + select), unblockNumber (delete), calls.ts blocked check.
- app_tenant S/I/U on conversations, calls, claim_intakes, and turn column UPDATE: unchanged (markCallSpam, setCallRecording, retention).
Tests: both privilege lists in rls.test.ts updated (column list, the reads-across-companies test, APP_SYSTEM_RLS_TABLES, blocked_numbers privileges, line_lookups) plus a new negative test. hardening.test.ts lists none of these.
Heads-up for CV/RA/RC: if fd-health's stale-call pass runs on app_system it needs its own grant on calls (status UPDATE with updated_at) and conversations; none exists now.

## Note 32: isOnCallMember
Moved to `packages/db/src/system/on-call.ts` (exported by `@roofline/db/system`). The route reaches it through `apps/api/src/account/inbox-scope.ts` (`inboxScopeOf`), a path already in DB_SYSTEM_ALLOWED, so no allowlist change. routes/conversations.ts changes: one import swap and `scopeOf`.

## Note 33: indexes (0019 amended in place)
`messages_company_conversation_created_idx (company_id, conversation_id, created_at)`, `calls_company_conversation_idx (company_id, conversation_id)`, `conversations_company_customer_idx (company_id, customer_id)`. Declared in schema/tenant.ts; 0019_snapshot.json and 0020_snapshot.json updated. Test in migrations.test.ts.

## Note 35: messages dedupe
- Partial unique index `messages_fd_dedupe_uniq (company_id, dedupe_key) WHERE dedupe_key LIKE 'fd-%'` in 0019 and the schema.
- The only `fd-` select-then-insert writers are `insertAssistantText` (fd-texts.ts) and `insertTextBackMessage` (fd-text-back.ts); both now `INSERT ... ON CONFLICT (company_id, dedupe_key) WHERE dedupe_key LIKE 'fd-%' DO NOTHING` and return null for the loser. Non-`fd-` keys (a test uses `team:1`) insert plainly. claim-intakes.ts has no messages dedupe (it dedupes claim_intakes, which the finding mislabelled), so it is unchanged.
- Existing paths: keys are `fd-text:<inbound id>`, `fd-book:<appointment id>`, `fd-textback:<call id>`, `fd-reply:<conversation>:<uuid>`: each unique per event, and the old guard already made repeats a no-op, so nothing violates the index. The step texts' other keys are not `fd-`.
- Tests: migrations.test.ts (unique per company, others unconstrained), repos-fd-texts.test.ts (three racing inserts insert once).

## Note 43: retention
- `blankExpiredTurns` takes a `limit` (default and sweep batch BLANK_BATCH = 1000, oldest first); `sweepCompanyRetention` loops one statement per transaction until a batch is short. No unbounded UPDATE.
- New `blankExpiredTexts`: sets `messages.body = ''` for messages with `conversation_id` not null, same transcript retention days and 7-day spam rule as the turns, skipping queued and scheduled texts; metadata kept; non-Front Desk messages untouched. Runs in the same sweep on the tenant pool (app_tenant already has UPDATE on messages, no grant change). `SweepResult` gains `messagesBlanked`.
- `purgeCustomerConversations` (not hooked up, Ruling DX) is unchanged and does not blank texts.
- Tests (retention.test.ts): bodies blanked with metadata kept, outside-conversation and fresh/queued/scheduled/other-company texts untouched, limit batching, a 1001-row backlog in one sweep.

## drizzle-kit
`npx drizzle-kit generate` in packages/db after the merge and all edits: "No schema changes, nothing to migrate".

## Checks
Local: `npm run typecheck`, `npm run lint`, web vitest for the two view tests: clean. The api and db suites run only in CI.

## CI
Merged d1-front-desk 092068c8 (smoke guard TRUST_PROXY fix) into d1-rev-d. First run on 61abe402 (38281729989): E2E green; Platform failed on two rls.test assertions I had missed (the app_tenant relation list still named line_lookups, and the app_system column-privilege table still expected the removed grants); fixed in a follow-up commit.

Green run: 38284192214 on head b1c782d5 (Platform, E2E and v1 all success). The report-only commit after it touches ops/ only, which CI skips.
