### Task 1: Dependencies, D1 schema and the module skeleton

**Base:** `d1-front-desk`, branched from `s1-storm` once S1 is merged. **[S1]** S1 ends at migration `0017`; D1 takes `0018`/`0019`. Real (F1–F3): `messages` (gains `conversation_id`), `memberships` (global), `company_settings`, `AGENTS` has `front_desk`, `JOB_SOURCES`, `companies.phone_e164`, `users.phone_e164`. **[C1]** `appointments` (gains `confirmed_at`, `confirmed_via`; C1 T1). **[E1]** `STORED_FILE_KINDS` (in `shared/proposals.ts`, gains `call_recording`), `stored_files`. **[S1]** `JOB_SOURCES` unchanged; `SMS_CONSENT_SOURCES` has `door` (Ruling SF).

Read first: `ops/sdd/d1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-front-desk-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** come from those plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`, `ops/sdd/s1/`), not from built code: check each against `c1-crm`/`e1-estimator`/`s1-storm` before starting and report any difference.

**Split:** Builder 1 schema TS + `0018`; Builder 2 `0019` grants/RLS + `rls.test.ts`/`migrations.test.ts`; Builder 3 npm dependencies, placeholders, barrels, shared enum constants.

**Files:**
- Modify: `packages/db/src/schema/{global,tenant,enums}.ts`, `packages/db/src/{index,system/index}.ts`, `packages/shared/src/index.ts`, `apps/api/package.json`, `package-lock.json`
- Create: `packages/db/migrations/0018_front_desk_schema.sql` (generated), `0019_front_desk_grants_rls.sql` (custom), meta; placeholders (`export {};`) for every file in the file structure that later tasks fill
- Test: `packages/db/test/{migrations,rls}.test.ts` (extend)

**Interfaces:**
- **npm (`apps/api`):** `@anthropic-ai/sdk`, `ws`; dev `@types/ws`.
- **Shared constants** (`packages/shared/src/front-desk.ts` now; Task 2 adds the logic): `CONVERSATION_CHANNELS = ['voice','sms'] as const`, `CONVERSATION_STATUSES = ['active','ended'] as const`, `HANDLED_BY = ['assistant','team'] as const`, `CONVERSATION_OUTCOMES = ['booked','confirmed','moved','canceled','job_question','claim','message','transferred','spam','abandoned','other'] as const`, `IDENTITY_LEVELS = ['unknown','matched','verified'] as const`, `CALL_STATUSES = ['ringing','ai','ringing_team','transferred','ended','rejected','failed'] as const`, `RECORDING_STATUSES = ['none','recording','stopped_by_caller','stored','deleted'] as const`, `CONSENT_REGIMES = ['all_party','one_party'] as const`, `TRANSFER_RESULTS = ['answered','no_answer','none'] as const`, `TURN_SPEAKERS = ['caller','assistant','team','system'] as const`, `TURN_ROUTES = ['fast','opus','transfer','end'] as const`, `CONFIRMED_VIA = ['call','text','manual'] as const`, `CLAIM_TAKEN_BY = ['front_desk','user'] as const`, `FRONT_DESK_VOICES` (four ids with labels), `JOB_SOURCES` gains `'front_desk'` if absent; `STORED_FILE_KINDS` gains `'call_recording'`.
- **Tables** — columns exactly as spec §10: tenant `conversations` (index `(company_id, last_message_at desc)`; unique active SMS conversation per `(company_id, phone_e164)` where `channel='sms' and status='active'`), `calls` (`call_sid` unique), `conversation_turns` (unique `(conversation_id, position)`), `claim_intakes`, `blocked_numbers` (unique `(company_id, e164)`); global `line_lookups`; `messages.conversation_id`, `appointments.{confirmed_at, confirmed_via}`, `memberships.{transfer_phone_e164, on_call_order, recording_ack_at}`, the `company_settings` columns with CHECKs.
- **`0019`:** tenant grants on the five tables (no DELETE except `blocked_numbers`; `conversation_turns` UPDATE limited to `text`, `tool_calls`, `truncated` for the sweep); `app_system` column grants + `app_system_all` on `calls (id, company_id, call_sid, status, conversation_id)`, `conversations (id, company_id, status)`, `conversation_turns (id, company_id, text, tool_calls, at)` (UPDATE `text`, `tool_calls` for retention), `calls (recording_key, recording_status)` UPDATE for retention; `line_lookups` SELECT/INSERT/UPDATE to `app_system` and SELECT to `app_tenant`; tenant UPDATE grants on the new settings, appointment and membership columns.

**Tests:**
- tables are tenant tables with RLS forced; `call_sid` unique across companies; one active SMS conversation per number; grant lists; `app_tenant` can't DELETE turns.

**Carries and rulings:**
- Barrels and the lockfile (`@anthropic-ai/sdk`, `ws`, `@types/ws`) are this task's only.

**Verify notes:**
- db suite on CI (`ops/bin/ci-check`); typecheck, lint locally.
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(db): D1 schema (conversations, calls, turns, claim intakes, blocked numbers) and skeleton`
