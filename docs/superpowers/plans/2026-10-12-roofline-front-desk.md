# Roofline Front Desk (D1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. In this repo the team script runs each task with one Sonnet lead and up to three Haiku builders on the **Split** packages.

**Goal:** The roofer's business number forwards to their Roofline number; Twilio ConversationRelay carries each call to a Claude conversation engine (`claude-haiku-5-5` routes each turn, `claude-opus-5-5` answers hard turns with strict tools) that discloses recording and AI, knows the caller, answers job, forecast and hail questions, books, confirms and moves inspections through C1's availability, takes claim details and messages, transfers to the on-call person by the transfer rules, and leaves a recording, transcript, summary and timeline cards with retention limits; the same engine answers inbound texts through the send gate, with a team inbox, missed-call text-back, spam rules and a forwarding test.

**Architecture:**
- **Skeletons first:** Task 1 (schema, migrations, npm dependencies, placeholders, barrels), Task 4 (API seams with fakes — `Llm`, `VoiceSession`, `CallControl`, `LineLookup`, `CallScreen` — config, job names, schedules, hook and route stubs, the `/relay` WebSocket upgrade), Task 20 (web routes, dock flag, Settings slots, copy files).
- **Pure logic in `@roofline/shared`:** guards, sentence buffer, transfer and text-back rules, identity matching, recording-consent states (`front-desk.ts`); tool input schemas (`front-desk-tools.ts`); forwarding codes (`forwarding.ts`).
- **One engine for both channels** (`apps/api/src/front-desk/engine.ts`) over the `Llm` and `VoiceSession` seams; tools run in the company's `app_tenant` transaction with the conversation's identity.
- **Every external call behind a seam with a deterministic fake** (F3 Ruling 29). The Anthropic adapter uses `@anthropic-ai/sdk`; Twilio voice control uses F3's `twilio` package; tests use recorded fixtures.

**Tech Stack:** as C1/E1/S1. New npm (`apps/api`): `@anthropic-ai/sdk` (Claude), `ws` (+ `@types/ws`) for the ConversationRelay WebSocket server.

**Spec:** `docs/superpowers/specs/2026-10-12-roofline-front-desk-design.md` (decisions numbered there). Parents: master §1–2, §6–7, §9, §11, §13–14; F1–F3; C1 (availability, appointments, calendar push, Today); E1 (proposal status, `ObjectStore`); S1 (`storm_hits`, YES replies).

**Branch:** integration branch `d1-front-desk` from `s1-storm` once S1 is merged; task branches `d1-t<N>`.

---

## Global Constraints

- **Everything in C1's, E1's and S1's Global Constraints applies** (TypeScript/ESM, `enumCheck`, forced RLS and composite FKs, `app_system` column grants + `app_system_all`, no raw queries from routes, `{error, field?}` with module-constant messages, secrets only from `config.ts`, copy rules, hooks in `features/<feature>/api.ts`, 12px / AA / 40px / 375px, company time zone, integer cents).
- **Models:** exactly `claude-opus-5-5` and `claude-haiku-5-5` (config `FRONT_DESK_ANSWER_MODEL`, `FRONT_DESK_ROUTER_MODEL` default to these). Opus: `thinking` omitted (adaptive; can't be disabled), `output_config.effort: 'low'`, streaming, tools with `strict: true` and `eager_input_streaming: true`, `tool_choice: { type: 'auto' }` (forced choice is a 400), no prefill, `fallbacks: 'default'` with beta `server-side-fallback-2026-07-01`; check `stop_reason` (`refusal`, `max_tokens`) before running tools; validate every tool input with the shared zod schema. Haiku: effort `low`, structured output via `output_config.format`, no server-side fallback. SDK error classes (`Anthropic.RateLimitError`, …), never message matching.
- **Caching:** tools → frozen system prompt (cache breakpoint, 1 h) → company block (breakpoint) → messages; nothing time-varying before the last breakpoint; operator notes mid-call as `{ role: 'system' }` messages. A test asserts the prefix bytes are identical across two calls of one company.
- **The model never chooses scope:** tool handlers take company, identity and channel from the engine's state; ids in tool inputs must be in the conversation's shown-ids set.
- **Nothing the assistant says bypasses the guards** (`priceGuard`, `coverageGuard`, `damageGuard`): every outgoing sentence, spoken or texted, including Haiku's `fastReply` and fillers.
- **Every outbound text goes through the F1 gate** (`informational`). Front Desk never sends marketing.
- **`@roofline/db/system`** is allowed in `apps/api/src/hooks/twilio-voice*.ts` and `apps/api/src/front-desk/relay-server.ts` (number → company, call token → company) and `jobs/scheduler/**` (retention fan-out).
- **Secrets and personal data:** no transcript text, phone number or recording URL in logs (log call id and company id); Anthropic and Twilio keys only via `config.ts`.
- **Lockfile:** only Task 1 edits `package-lock.json`. **Migrations:** only Task 1 (`0018` generated, `0019` custom) — S1 used 0016/0017.

## Review Focus

1. **Never says what it mustn't.** Disclosure every call (welcome greeting not interruptible); guards on every sentence; no prices, no coverage promises; refusal and errors → hand-off. (Tasks 2, 6, 10)
2. **One caller, one company, one customer.** WebSocket tokens bind to a call and company; tools can't reach ids not shown; job details only after verification; reps see their own customers' conversations only. (Tasks 4, 7, 11, 18)
3. **Bookings are real and right.** Slot re-check in the transaction, idempotency by conversation + slot, same-home buffer, calendar push, confirmation text through the gate; inspections only. (Task 8)
4. **Recording law and retention.** Recording starts after the disclosure, stops on objection with transcript storage, R2 copy then Twilio delete, sweep deletes on time, signed URLs short-lived. (Tasks 12, 16)
5. **Latency and cost.** Speculative Opus start and cancel, sentence streaming, cached prefix stable, timings and tokens on every turn, one `ai_call_minute` event per call. (Tasks 5, 6, 11, 13)

---

## Parallel lanes

| Task | Depends on (D1) | Notes |
|---|---|---|
| 1 Schema, migrations, dependencies, skeleton | — | only lockfile and migration edits |
| 2 Shared guards, rules and consent states | 1 | `shared/front-desk.ts` |
| 3 Shared tool schemas and forwarding codes | 1 | `shared/front-desk-tools.ts`, `shared/forwarding.ts` |
| 4 API skeleton: seams, fakes, config, jobs, hooks, `/relay` upgrade | 1, 3 | only `app.ts`/`server.ts`/`config.ts`/`deps.ts`/`test/helpers.ts`/`jobs/*` edits |
| 5 Anthropic adapter | 4 | `providers/anthropic/*` |
| 6 Conversation engine and prompt | 2, 4 | `front-desk/engine.ts`, `prompt.ts` |
| 7 Tools: caller, jobs, forecast, hail | 3, 4 | `weather/*` (daily) |
| 8 Tools: inspection times, book, confirm, move, cancel | 3, 4 | |
| 9 Tools: claims, messages, transfer, end | 3, 4 | |
| 10 Voice webhooks and transfers | 4 | `hooks/twilio-voice*.ts` |
| 11 Relay WebSocket server | 6, 10 | `front-desk/relay-server.ts` |
| 12 Recording | 10 | |
| 13 After the call: summary, outcome, metering, text-back, timeline | 5, 11 | |
| 14 Text channel | 6 | `hooks/twilio.ts` one call added |
| 15 Spam | 10 | |
| 16 Retention sweep | 12, 13 | |
| 17 Number voice setup and the forwarding test | 4 | `shared/setup.ts` + `repos/setup.ts` |
| 18 Conversations, settings and stats API | 6, 13, 14 | |
| 19 Wiring the engine's tools and the full call path | 7, 8, 9, 11 | `front-desk/tools/index.ts` |
| 20 Web skeleton | 3 | only `router.tsx`/`apps.ts`/Settings slots |
| 21 Web: Front Desk window and stats | 20 | |
| 22 Web: conversation view and inbox reply | 20 | |
| 23 Web: Settings → Front Desk and transfer phones | 20 | |
| 24 Web: forwarding guide and test | 20 | |
| 25 Scripted call evals and latency report | 5, 19 | by hand with real models; CI with `ScriptedLlm` |
| 26 Web: timelines, Today, appointments, dock badge | 20 | |
| 27 End-to-end, acceptance map, docs; manual smoke | 10–26 | smoke by hand |

**Waves (proposed team groups of three):**
- **Wave 1:** T1.
- **Wave 2:** G1 = T2, T3.
- **Wave 3:** G2 = T4, T20.
- **Wave 4:** G3 = T5, T6, T10 · G4 = T7, T8, T9 · G5 = T21, T22, T23.
- **Wave 5:** G6 = T11, T12, T14 · G7 = T15, T17, T24.
- **Wave 6:** G8 = T13, T19, T26 · then G9 = T16, T18, T25.
- **Wave 7:** T27.

**Shared files:** barrels get every D1 line in Task 1; `shared/steps.ts` is not edited (Front Desk acts live, no R2 steps); `shared/setup.ts` and `repos/setup.ts` only in Task 17 (`phone_number`); `hooks/twilio.ts` only in Task 14 (one call after S1's reply hook); `weather/source.ts`/`nws.ts` only in Task 7; `send-gate/src/decide.ts` only in Task 14 (the `inReplyToInboundAt` input); `front-desk/tools/index.ts` only in Task 19 (Tasks 7–9 export handlers from their own files).

---

## File structure

```
packages/db/migrations/0018_front_desk_schema.sql 0019_front_desk_grants_rls.sql          T1
packages/db/src/schema/{global,tenant,enums}.ts                                         T1
packages/db/src/repos/ conversations.ts turns.ts (T6, T14, T18) calls.ts (T10, T13) claim-intakes.ts (T9)
                       front-desk-settings.ts (T18) blocked-numbers.ts (T15) fd-booking.ts (T8) fd-caller.ts (T7)
packages/db/src/system/ voice-routing.ts (T10) relay-tokens.ts (T11) line-lookups.ts (T13) fd-retention.ts (T16)
packages/shared/src/ front-desk.ts (T2) front-desk-tools.ts forwarding.ts (T3) recording-consent.ts (T2)
apps/api/src/providers/ llm.ts voice-session.ts call-control.ts line-lookup.ts call-screen.ts fakes/{scripted-llm,voice-session,call-control,line-lookup}.ts (T4)
                        anthropic/{client,route,answer,summarize,errors}.ts (T5) twilio/{voice,lookup}.ts (T10, T12, T13)
apps/api/src/front-desk/ engine.ts prompt.ts state.ts fillers.ts (T6) relay-server.ts (T11) recording.ts (T12)
                         after-call.ts text-back.ts (T13) texts.ts (T14) spam.ts (T15) forwarding-test.ts (T17)
                         tools/{caller,jobs,forecast,hail}.ts (T7) tools/{times,book,confirm,move}.ts (T8) tools/{claim,message,transfer,end}.ts (T9) tools/index.ts (T19)
apps/api/src/hooks/ twilio-voice.ts twilio-voice-transfer.ts (T10) twilio-voice-recording.ts (T12)
apps/api/src/routes/ conversations.ts front-desk.ts (T18)
apps/api/src/jobs/scheduler/ fd-retention.ts (T16) fd-health.ts (T6)
apps/api/src/scripts/ eval-front-desk.ts (T25) smoke/front-desk.ts (T27)
apps/api/test/front-desk/scenarios/*.ts (T25)
apps/web/src/features/front-desk/ (T21, T22) settings/{FrontDeskTab,ForwardingGuide,TransferPhone}.tsx (T23, T24)
apps/web/src/copy/ front-desk.ts forwarding.ts (new)
apps/web/e2e/ front-desk.spec.ts (T27)
docs/superpowers/ d1-acceptance.md d1-manual-smoke.md d1-latency.md (T25, T27)
```

---

### Task 1: Dependencies, D1 schema and the module skeleton

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
- [ ] **Tests:** tables are tenant tables with RLS forced; `call_sid` unique across companies; one active SMS conversation per number; grant lists; `app_tenant` can't DELETE turns.
- [ ] **Verify:** db suite on CI (`ops/bin/ci-check`); typecheck, lint locally.
- [ ] **Commit:** `feat(db): D1 schema (conversations, calls, turns, claim intakes, blocked numbers) and skeleton`

---

### Task 2: Shared guards, rules and consent states

**Split:** Builder 1 guards + sentence buffer; Builder 2 transfer, text-back, identity and limit rules; Builder 3 `recording-consent.ts` + tests.

**Files:** Modify `packages/shared/src/front-desk.ts`; Create `packages/shared/src/recording-consent.ts`; Test `packages/shared/test/{front-desk-guards,front-desk-rules,recording-consent}.test.ts`.

**Interfaces:**
```ts
export type GuardHit = 'price' | 'coverage' | 'damage';
export function guardSentence(s: string, ctx: { repName: string | null }): { text: string; hits: GuardHit[] };   // replacement sentences from spec §7.2; numbers in words ("two thousand dollars") caught
export class SentenceBuffer { push(token: string): string[]; flush(): string[] }   // releases whole sentences (., ?, !, or 140 chars at a comma/space); never splits "Dr." "St." "a.m."/"p.m." or decimals
export type TransferReason = 'asked' | 'leak' | 'danger' | 'angry' | 'trade_caller' | 'not_understood' | 'model_failure';
export function shouldTransfer(i: { intent: string; urgent: boolean; mood: 'calm' | 'upset' | 'angry'; askedForPersonCount: number; taskInProgress: boolean; failedUnderstanding: number }): TransferReason | null;
export function transferPlan(i: { reason: TransferReason; urgent: boolean; inWorkHours: boolean; onCall: { userId: string; phone: string }[] }): { mode: 'ring_all' | 'ring_each' | 'message'; targets: { userId: string; phone: string }[]; timeoutSeconds: 20 };
export function shouldTextBack(i: { callerTurns: number; secondsInCall: number; status: 'failed' | 'completed' | 'no_answer' | 'busy'; lineType: 'mobile' | 'landline' | 'voip' | 'unknown'; spam: boolean; textedBackLast24h: boolean; enabled: boolean }): boolean;   // spec Decision 11 (voip counts as textable only when Lookup says SMS-capable — treat 'voip' as false in D1)
export function turnLimit(i: { turns: number; minutes: number }): 'ok' | 'offer_person' | 'end';   // 40 / 25 → offer; 30 min → end
export function matchCaller(phoneMatches: { customerId: string; firstName: string; lastName: string; streets: string[] }[]): IdentityLevel;
export function verifyCaller(c: { lastName: string; streets: string[] }, said: { name: string; street: string }): boolean;   // case/punctuation-insensitive; street number optional; "Elm" matches "Elm St"
// recording-consent.ts
export const ALL_PARTY_STATES: readonly string[];   // CA, CT, FL, IL, MD, MA, MI, MT, NH, OR, PA, WA (documented with a note: CT/OR/MI nuances; behaviour is the same everywhere — spec Decision 12)
export function stateForAreaCode(npa: string): string | null;   // static NANP table (US only)
export function consentRegime(i: { callerE164: string; companyState: string | null; transferState?: string | null }): 'all_party' | 'one_party';
export function disclosureGreeting(companyName: string): string;   // "Thanks for calling {Company}. I'm {Company}'s virtual assistant, and this call is recorded. How can I help?"
```
- [ ] **Tests:** guard table (≥ 60 cases, both blocked and allowed — "we've been in business 20 years" passes; "$12,000", "twelve grand", "about 400 a square", "insurance will pay for it", "your roof is definitely damaged" blocked); sentence buffer edge cases; transfer rule table; text-back table; verification table; area code → state samples; disclosure contains "virtual assistant" and "recorded".
- [ ] **Commit:** `feat(shared): Front Desk guards, transfer and text-back rules, recording consent states`

---

### Task 3: Shared tool schemas and forwarding codes

**Split:** Builder 1 tool zod schemas + JSON Schema export (strict-compatible: `additionalProperties: false`, all properties `required`, nullable instead of optional); Builder 2 `forwarding.ts`; Builder 3 tests.

**Files:** Modify `packages/shared/src/{front-desk-tools,forwarding}.ts`; Test `packages/shared/test/{front-desk-tools,forwarding}.test.ts`.

**Interfaces:**
```ts
export const FRONT_DESK_TOOLS = {
  lookup_my_jobs:        { input: z.object({}).strict() },
  verify_caller:         { input: z.object({ name: z.string().min(2).max(80), street: z.string().min(2).max(80) }).strict() },
  check_forecast:        { input: z.object({ date: IsoDate, propertyId: z.string().uuid().nullable() }).strict() },
  hail_at_my_home:       { input: z.object({ propertyId: z.string().uuid().nullable() }).strict() },
  find_inspection_times: { input: z.object({ propertyId: z.string().uuid().nullable(), address: z.string().max(200).nullable(), fromDate: IsoDate.nullable(), partOfDay: z.enum(['any','morning','afternoon']) }).strict() },
  book_inspection:       { input: z.object({ slotStart: z.string().datetime(), slotUserId: z.string().uuid(), propertyId: z.string().uuid().nullable(), address: z.string().max(200).nullable(), firstName: z.string().max(60), lastName: z.string().max(60), notes: z.string().max(500) }).strict() },
  confirm_appointment:   { input: z.object({ appointmentId: z.string().uuid() }).strict() },
  move_inspection:       { input: z.object({ appointmentId: z.string().uuid(), slotStart: z.string().datetime(), slotUserId: z.string().uuid() }).strict() },
  cancel_inspection:     { input: z.object({ appointmentId: z.string().uuid(), reason: z.string().max(200) }).strict() },
  take_claim_details:    { input: z.object({ jobId: z.string().uuid().nullable(), insurer: z.string().max(80), claimNumber: z.string().max(40).nullable(), dateOfLoss: IsoDate.nullable(), description: z.string().max(1000), adjusterVisitAt: z.string().datetime().nullable() }).strict() },
  take_message:          { input: z.object({ reason: z.string().max(500), urgent: z.boolean(), callbackWhen: z.string().max(100).nullable(), name: z.string().max(80).nullable() }).strict() },
  transfer_to_person:    { input: z.object({ reason: z.enum(['asked','leak','danger','angry','trade_caller','not_understood']), summary: z.string().max(200) }).strict() },
  end_call:              { input: z.object({ reason: z.enum(['goodbye','spam','silence']) }).strict() },
} as const;
export type FrontDeskToolName = keyof typeof FRONT_DESK_TOOLS;
export const TOOL_DESCRIPTIONS: Record<FrontDeskToolName, string>;      // plain-English descriptions used in the API tool list (stable text: part of the cached prefix)
export function toolJsonSchemas(): { name: FrontDeskToolName; description: string; input_schema: object }[];   // deterministic order (alphabetical) for cache stability
export const TEXT_CHANNEL_TOOLS: readonly FrontDeskToolName[];          // all but transfer_to_person and end_call
// forwarding.ts
export const CARRIERS = ['verizon','att','tmobile','other_gsm','landline','ringcentral','google_voice','ooma','spectrum','comcast','grasshopper','other'] as const;
export function forwardingSteps(carrier: Carrier, mode: 'all' | 'no_answer', roofline: string /* E.164 */): { kind: 'dial' | 'steps'; on: string[]; off: string[] };   // spec §12 codes, number as 10 digits
```
- [ ] **Tests:** every schema converts to a strict JSON Schema (no optional keys, `additionalProperties: false`); order is stable; forwarding codes per carrier and mode; E.164 → 10 digits.
- [ ] **Commit:** `feat(shared): Front Desk tool schemas and call-forwarding codes`

---

### Task 4: API skeleton — seams, fakes, config, jobs, hooks, the `/relay` upgrade

**Split:** Builder 1 config, deps, test helpers, env docs; Builder 2 the five seams and fakes + `front-desk-fakes.test.ts`; Builder 3 job names, schedules, hook/route stubs and mounts, the WebSocket upgrade hook in `server.ts`.

**Files:**
- Create: `apps/api/src/providers/{llm,voice-session,call-control,line-lookup,call-screen}.ts`, `apps/api/src/providers/fakes/{scripted-llm,voice-session,call-control,line-lookup}.ts`, stubs `providers/anthropic/index.ts` (`anthropicFor(config): Llm | null` → null), `providers/twilio/voice.ts` (`twilioCallControlFor` → null), `providers/twilio/lookup.ts` (`twilioLookupFor` → null), all `front-desk/*.ts` stubs, `hooks/twilio-voice*.ts` routers returning 501, `routes/{conversations,front-desk}.ts`, `jobs/scheduler/{fd-retention,fd-health}.ts`, `apps/api/test/front-desk-fakes.test.ts`
- Modify: `apps/api/src/{config,deps,app,index,server}.ts`, `apps/api/src/jobs/{queue,handlers,worker}.ts`, `apps/api/test/helpers.ts`, `.env.example`, `README.md`

**Interfaces:**
```ts
// providers/llm.ts
export type RouteInput = { companyBlock: string; state: EngineStateSummary; callerText: string; channel: 'voice' | 'sms' };
export type RouteDecision = { intent: string; urgent: boolean; mood: 'calm' | 'upset' | 'angry'; route: 'fast' | 'opus' | 'transfer' | 'end'; fastReply: string | null };
export type AnswerInput = { companyId: string; companyBlock: string; history: Anthropic.MessageParam[]; tools: FrontDeskToolName[]; signal: AbortSignal };
export type LlmEvent = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: FrontDeskToolName; input: unknown }
  | { type: 'done'; stopReason: 'end_turn' | 'tool_use' | 'refusal' | 'max_tokens'; usage: TurnUsage; assistantContent: Anthropic.ContentBlock[] };
export type TurnUsage = { model: string; inputTokens: number; cachedTokens: number; outputTokens: number; firstTokenMs: number | null; totalMs: number };
export interface Llm { readonly configured: boolean;
  route(i: RouteInput, signal: AbortSignal): Promise<RouteDecision & { usage: TurnUsage }>;
  answer(i: AnswerInput): AsyncIterable<LlmEvent>;
  summarize(i: { companyBlock: string; transcript: string; actions: string[] }): Promise<{ summary: string; outcome: ConversationOutcome; followUps: string[]; usage: TurnUsage }> }
export class LlmUnavailableError extends Error {}
// providers/voice-session.ts — the ConversationRelay protocol, typed
export type RelayIn = { type: 'setup'; callSid: string; from: string; to: string; customParameters: Record<string, string> } | { type: 'prompt'; voicePrompt: string; last: boolean }
  | { type: 'interrupt'; utteranceUntilInterrupt: string; durationUntilInterruptMs: number } | { type: 'dtmf'; digit: string } | { type: 'error'; description: string };
export type RelayOut = { type: 'text'; token: string; last: boolean; interruptible?: boolean } | { type: 'end'; handoffData: string } | { type: 'play'; source: string };
export interface VoiceSession { onMessage(h: (m: RelayIn) => void): void; send(m: RelayOut): void; close(): void; onClose(h: () => void): void }
// providers/call-control.ts
export interface CallControl { readonly configured: boolean;
  startRecording(sub: SubaccountRef, callSid: string): Promise<{ recordingSid: string }>;
  stopRecording(sub: SubaccountRef, callSid: string, recordingSid: string): Promise<void>;
  fetchRecording(sub: SubaccountRef, recordingSid: string): Promise<Uint8Array>;      // mp3
  deleteRecording(sub: SubaccountRef, recordingSid: string): Promise<void>;
  placeTestCall(i: { to: string; from: string; statusCallback: string }): Promise<{ callSid: string }>;   // Roofline's own account
  setVoiceUrl(sub: SubaccountRef, phoneNumberSid: string, url: string, statusCallback: string): Promise<void> }
// providers/line-lookup.ts
export interface LineLookup { lineType(e164: string): Promise<'mobile' | 'landline' | 'voip' | 'unknown'> }
// providers/call-screen.ts
export type ScreenInput = { from: string; stirVerstat: string | null; blocked: boolean; callsLastHour: number; knownCustomer: boolean };
export function screenCall(i: ScreenInput): { action: 'allow' | 'reject'; reason: string | null };   // rules in Task 15; stub allows all
```
- **Fakes:** `ScriptedLlm` (constructor takes a `Script`: ordered rules `{ when: RegExp; route: RouteDecision; answer?: ScriptStep[] }` where steps are `text` / `tool` / `refuse`; default rule answers "Sorry, could you say that again?"; records `calls` with the exact request prefix for cache tests; `failNext(n)`; `delayMs` to simulate latency), `FakeVoiceSession` (in-memory pair: `caller.say(text)`, `caller.interrupt(spoken)`, `assistantText()`; records `sent`), `FakeCallControl` (recordings as bytes, `calls`), `FakeLineLookup` (`+1555…` mobile, `+1556…` landline, else unknown).
- **Config:** `ANTHROPIC_API_KEY` (required in production when any company enables Front Desk — startup warning in D1), `FRONT_DESK_ROUTER_MODEL` (default `claude-haiku-5-5`), `FRONT_DESK_ANSWER_MODEL` (default `claude-opus-5-5`), `FRONT_DESK_OPUS_FAST` (bool, default false), `FRONT_DESK_MAX_CALLS` (global, default 40), `RELAY_PUBLIC_URL` (wss URL, default derived from `PUBLIC_BASE_URL`), `TWILIO_TEST_CALLER_NUMBER` (E.164; Roofline's own number for forwarding tests), `RELAY_TOKEN_SECRET` (≥ 32 bytes; or derived from `SESSION_SECRET` via HKDF `relay`).
- **`AppDeps` gains** `llm`, `callControl`, `lineLookup`, `relaySessions` (the live-session registry, for caps and health); `TestApp` gains the fakes.
- **Jobs:** `'fd-after-call'` (`{ companyId, callId }`, singletonKey callId), `'fd-recording-store'` (`{ companyId, callId, recordingSid }`), `'fd-text'` (`{ companyId, conversationId }`, singletonKey conversationId, `startAfter` 20 s), `'fd-forwarding-test'` (`{ companyId, testId }`).
- **Schedules:** `fd-retention` `17 3 * * *`, `fd-health` `*/2 * * * *`.
- **Mounts:** `/hooks/twilio/voice*` beside F3's Twilio hooks (before the session gate); `/api/conversations`, `/api/front-desk`, `/api/calls`, `/api/blocked-numbers`, `/api/me/transfer-phone`; `server.ts` `upgrade` handler for `/relay` (stub closes 1008).
- [ ] **Tests:** config groups and defaults; fakes' documented behaviour; `/hooks/twilio/voice` reachable without a session (501 stub); the upgrade on another path is refused; `JOB_NAMES`/`SCHEDULES` gain the names.
- [ ] **Commit:** `feat(api): D1 skeleton — LLM, voice session, call control and lookup seams with fakes; voice hooks and relay socket`

---

### Task 5: Anthropic adapter

**Split:** Builder 1 `client.ts` + `errors.ts` (one `Anthropic` client from config, `maxRetries: 1`, timeout 20 s for answers / 5 s for routes; error mapping to `LlmUnavailableError` by SDK class); Builder 2 `route.ts` + `summarize.ts` (Haiku, `output_config: { effort: 'low', format: { type: 'json_schema', schema } }`, zod-validated, `max_tokens` 300 / 800); Builder 3 `answer.ts` (Opus stream) + tests with recorded SSE fixtures through an injected `fetch`.

**Files:** Fill `apps/api/src/providers/anthropic/{client,route,answer,summarize,errors,index}.ts`; Create `apps/api/test/fixtures/anthropic/*.sse` and `*.json` (shapes from the SDK docs; Task 27 replaces them with scrubbed real captures); Test `apps/api/test/anthropic-adapter.test.ts`.

**Interfaces:**
- `answer`: `client.beta.messages.stream({ model, max_tokens: 1024, betas: ['server-side-fallback-2026-07-01', ...(fast ? ['fast-mode-2026-02-01'] : [])], fallbacks: 'default', ...(fast ? { speed: 'fast' } : {}), output_config: { effort: 'low' }, system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } }, { type: 'text', text: companyBlock, cache_control: { type: 'ephemeral', ttl: '1h' } }], tools: toolJsonSchemas() filtered by channel with `strict: true, eager_input_streaming: true`, tool_choice: { type: 'auto' }, messages }, { signal })`; yields `text` deltas as they arrive, a `tool_use` event per completed tool block (input from the final message, `JSON.parse`d and zod-checked by the engine), and `done` with usage (`cache_read_input_tokens` → `cachedTokens`) and the full assistant content (echoed back unchanged in history, thinking blocks included).
- Fast mode on 429: drop `speed` and retry once at standard speed (note: cache miss).
- `route`: the router prompt is its own frozen text (cached); output schema `{ intent: string (≤ 40), urgent: boolean, mood: enum, route: enum, fastReply: string | null (≤ 200) }`.
- Refusal: `stop_reason === 'refusal'` → `done` with `stopReason: 'refusal'` (the engine hands off). `fallback` content blocks are ignored for display.
- [ ] **Tests:** request bodies match fixtures (model ids, effort, betas, fallbacks, tool order, cache breakpoints, no `thinking` field, no `tool_choice` any/tool); text deltas stream in order; tool input assembled; refusal surfaced; 429 with fast mode retries without it; usage mapping; keys never logged.
- [ ] **Commit:** `feat(api): Claude adapter — Haiku 5.5 routing and summaries, Opus 5.5 streaming answers with strict tools`

---

### Task 6: Conversation engine and prompt

**Split:** Builder 1 `state.ts` + `engine.ts` (turn loop: route and speculative answer in parallel, cancel on fast/transfer/end, tool loop ≤ 4 tool rounds per turn, sentence buffering and guards, fillers, limits, refusal/error → hand-off); Builder 2 `prompt.ts` (frozen system prompt: role, disclosure already spoken, the four live actions only, tool-use instructions, verification rule, never prices/coverage/damage, short spoken sentences, one question at a time, read times as "Thursday at ten"; the company block builder from settings, hours, services, towns, facts) + `fillers.ts`; Builder 3 `repos/{conversations,turns}.ts` (turn insert with timings/tokens/guard hits) + `fd-health` schedule (LLM health flag in `relaySessions`) + tests.

**Files:** Fill the listed files; Test `apps/api/test/front-desk/engine.test.ts`.

**Interfaces:**
```ts
export type EngineEvent = { type: 'say'; text: string } | { type: 'filler'; text: string } | { type: 'handoff'; reason: TransferReason; summary: string }
  | { type: 'end'; reason: 'goodbye' | 'spam' | 'silence' | 'limit' } | { type: 'turn_saved'; turnId: string };
export type ToolHandler<N extends FrontDeskToolName> = (ctx: ToolContext, input: z.infer<(typeof FRONT_DESK_TOOLS)[N]['input']>) => Promise<{ ok: boolean; forModel: string; shownIds?: string[]; action?: string }>;
export type ToolContext = { deps: AppDeps; companyId: string; conversation: ConversationState; now: Date };
export function createEngine(deps: AppDeps, tools: Partial<{ [N in FrontDeskToolName]: ToolHandler<N> }>): {
  start(i: { companyId: string; channel: 'voice' | 'sms'; phone: string; callId?: string }): Promise<ConversationState>;
  turn(state: ConversationState, callerText: string, signal: AbortSignal): AsyncIterable<EngineEvent>;
  interrupted(state: ConversationState, spoken: string): Promise<void>;
  note(state: ConversationState, systemNote: string): void }          // appended as a mid-conversation system message
```
- **Rules:** shown-ids check before any tool runs (unknown id → tool result "That isn't one of this caller's records." and `ok: false`); tool inputs zod-validated (invalid → `is_error` tool result, one retry); `stop_reason: 'max_tokens'` → say "Sorry — let me put that more simply." and retry once with a system note; history kept as full content blocks (append-only; never edited — preserved-thinking rule).
- [ ] **Tests (with `ScriptedLlm`):** fast route speaks Haiku's reply and cancels Opus (`signal.aborted`); opus route streams sentences through guards; guard replacement recorded in `guard_hits`; tool loop with filler; unknown id refused; refusal → handoff; two model errors → handoff; turn limits; cached prefix identical across two turns and two calls of a company, different between companies; history is append-only.
- [ ] **Commit:** `feat(api): the Front Desk conversation engine — routing, streaming answers, tools and guards`

---

### Task 7: Tools — caller, jobs, forecast, hail

**Split:** Builder 1 `repos/fd-caller.ts` + `tools/caller.ts` (match by phone at start; `verify_caller`); Builder 2 `tools/jobs.ts` (`lookup_my_jobs`: plain stage words, next appointment, rep first name, E1 proposal state; verified only, matched callers hear only "you have an appointment on Thursday") + `tools/hail.ts` (S1 `storm_hits` for the caller's homes, last 30 days); Builder 3 `weather/{source,nws}.ts` `daily(lat, lng, days)` (NWS `/points` → `forecast` periods; null on failure) + fake + `tools/forecast.ts` + tests.

**Files:** Fill the listed files; Modify `apps/api/src/weather/{source,nws}.ts`, `apps/api/src/providers/fakes/weather.ts` (or wherever F3's fake lives); Test `apps/api/test/front-desk/tools-info.test.ts`.
- **Tool results for the model** are short plain sentences with ids only where a later tool needs them (`shownIds`), e.g. `"Job a1b2… at 123 Elm St: waiting on the customer's signature; proposal sent Oct 6, opened Oct 7. Next: none."`.
- [ ] **Tests:** match one/two/no customers; verification success/failure (three failures → transfer suggestion in the result); unverified job lookup gives only the day of the next appointment; forecast null → "I can't reach the forecast right now"; hail result says "radar-estimated"; another company's customer with the same phone is never matched.
- [ ] **Commit:** `feat(api): Front Desk tools for knowing the caller, their jobs, the forecast and hail`

---

### Task 8: Tools — inspection times, book, confirm, move, cancel

**Split:** Builder 1 `tools/times.ts` (C1 availability union for inspectors, next 10 days, ≤ 6 slots, by part of day, same-home buffer via `propertyId`; address-only → geocode first (service-area check)); Builder 2 `repos/fd-booking.ts` + `tools/book.ts` (one transaction: customer, consent `express` source `call`, property, Lead job, appointment `front_desk`; slot re-check with `findSlots` on fresh busy data under an advisory lock per inspector; idempotency key conversation + slot; C1 calendar push job; confirmation text via the gate after commit); Builder 3 `tools/{confirm,move}.ts` (`confirm_appointment` any kind for the verified caller; `move_inspection`/`cancel_inspection` inspections only, settings switches, C1 calendar push) + "C"/"confirm" text handling helper for Task 14 + tests.

**Files:** Fill the listed files; Test `apps/api/test/front-desk/tools-booking.test.ts`.
- [ ] **Tests:** slots respect work hours, buffers and notice; booking a slot taken meanwhile → result offers the next two; same idempotency key → same appointment; outside service area → message suggestion; unverified caller can't move/cancel; install → refused with message suggestion; settings off → tools absent from the tool list; confirmation text blocked by the gate is recorded, booking still stands.
- [ ] **Commit:** `feat(api): Front Desk books, confirms and moves inspections against the calendar`

---

### Task 9: Tools — claims, messages, transfer, end

**Split:** Builder 1 `repos/claim-intakes.ts` + `tools/claim.ts` (job required for verified callers with one open job, else a new Lead job; activity "Claim details taken by Front Desk"); Builder 2 `tools/message.ts` (Today follow-up to the job's rep or the office, urgent → in-app + email to on-call members); Builder 3 `tools/{transfer,end}.ts` (return `handoff`/`end` engine events; `transferPlan` from on-call members with transfer phones and work hours) + tests.

**Files:** Fill the listed files; Test `apps/api/test/front-desk/tools-handoff.test.ts`.
- [ ] **Tests:** claim intake stored and linked; message follow-up assignee rules; urgent notice once; transfer plan modes by hours/urgency; no on-call members → message mode; end with spam marks the conversation.
- [ ] **Commit:** `feat(api): Front Desk takes claim details and messages and hands off to people`

---

### Task 10: Voice webhooks and transfers

**Split:** Builder 1 `hooks/twilio-voice.ts` (`POST /voice`: signature (subaccount token), route `To` → company via `system/voice-routing.ts`, call row, screen (Task 15's `screenCall`; stub allows), caps (company and global), Front Desk off → `<Dial>` team then voicemail `<Record>`, ring-first, then `<Connect><ConversationRelay …>` with `welcomeGreeting = disclosureGreeting(company)`, `welcomeGreetingInterruptible="none"`, `interruptible="speech"`, providers and voice from settings, `<Parameter name="callId">`, `action` → after-relay); `POST /voice/status`); Builder 2 `hooks/twilio-voice-transfer.ts` (`/after-relay`: reads `HandoffData` JSON `{ kind: 'transfer' | 'end', reason, summary }` → `<Dial timeout=20 action=/after-dial><Number url=/whisper>…</Number>…</Dial>` per `transferPlan`; `/whisper` → `<Gather numDigits=1 timeout=8>` "Roofline call from … Press 1 to take it." → no digit `<Hangup/>` (that leg); `/after-dial` → answered: done; no answer → `<Connect><ConversationRelay>` again with `<Parameter name="mode" value="message_only">` and a greeting "Nobody could pick up right now. I'll take a message."); Builder 3 `providers/twilio/voice.ts` (`CallControl` real: `twilio` REST with the subaccount, `setVoiceUrl`, test call from the main account) + tests with signed form fixtures.

**Files:** Fill the listed files and `packages/db/src/system/voice-routing.ts`, `packages/db/src/repos/calls.ts`; Test `apps/api/test/front-desk/voice-hooks.test.ts`.
- [ ] **Tests:** unsigned → 403; unknown number → 404; TwiML snapshots (relay with greeting containing the disclosure, ring-first, off mode, over-cap); after-relay transfer TwiML per plan; whisper; no-answer returns to message mode; status callback updates the call; company B's number never routes to A.
- [ ] **Commit:** `feat(api): Twilio voice webhooks — the relay with the disclosure greeting, ring-first and warm transfers`

---

### Task 11: Relay WebSocket server

**Split:** Builder 1 `relay-server.ts` upgrade (`?t=` token: HMAC of `callId.companyId.exp` (10 minutes) under `RELAY_TOKEN_SECRET`, verified constant-time; `X-Twilio-Signature` on the upgrade checked when present; one socket per call; `setup.customParameters.callId` must equal the token's call) + `system/relay-tokens.ts`; Builder 2 the session loop (ConversationRelay JSON → `VoiceSession` → engine; `prompt` with `last: true` starts a turn, partials ignored; `interrupt` aborts the turn and records truncation; `dtmf` 0 → transfer request; engine `say`/`filler` → `{type:'text', token, last}` sentence by sentence; `handoff`/`end` → `{type:'end', handoffData}`); Builder 3 accounting (`ai_started_at`, `ai_seconds` on close, session registry for caps, heartbeat/idle 20 s silence prompt "Are you still there?" then end after another 20 s) + tests with a scripted relay client over a real `ws` loopback.

**Files:** Fill the listed files; Modify `apps/api/src/server.ts` (replace the stub handler — Ruling 2); Test `apps/api/test/front-desk/relay.test.ts`.
- [ ] **Tests:** bad/expired token → close 1008; token for company A with B's call → 1008; a full scripted call (setup → prompt → text tokens → end with handoff) through `ScriptedLlm`; interruption truncates and cancels; idle handling; `ai_seconds` measured; registry decrements on close; no transcript text in logs (log spy).
- [ ] **Commit:** `feat(api): the ConversationRelay socket — authenticated, streaming, interruptible`

---

### Task 12: Recording

**Split:** Builder 1 `front-desk/recording.ts` (start when the relay session opens — after the non-interruptible greeting began — `recordingStatusCallback` → `/voice/recording`; objection handling: engine note + `stopRecording` + `calls.transcript_stored = false` from that turn on (turns stored with `text = ''` and a `system` turn "Recording and transcript stopped at the caller's request")); Builder 2 `hooks/twilio-voice-recording.ts` + the `fd-recording-store` job (fetch from Twilio, put to R2 `recordings/<companyId>/<callId>.mp3` via `ObjectStore`, `stored_files` row kind `call_recording`, then `deleteRecording` at Twilio; retries; R2 not configured → keep at Twilio up to 7 days and warn); Builder 3 signed playback (`GET /api/calls/:id/recording` → 302 to a 5-minute signed R2 URL; roles per spec §11) + tests.

**Files:** Fill the listed files; Modify `apps/api/src/providers/object-store.ts` only to add `signedGetUrl(key, seconds)` if E1 lacks it (Ruling 6); Test `apps/api/test/front-desk/recording.test.ts`.
- [ ] **Tests:** recording starts once; objection stops recording and transcript storage; store job copies then deletes at the fake Twilio, idempotent; playback roles (rep only for own customers, not transferred legs; office/owner yes); company B 404.
- [ ] **Commit:** `feat(api): call recordings — stop on objection, copy to R2, delete at Twilio, signed playback`

---

### Task 13: After the call — summary, outcome, metering, text-back, timeline

**Split:** Builder 1 `after-call.ts` (`fd-after-call` job: transcript → Haiku summary (skipped text when transcript not stored: summary from actions only), outcome (actions win over the model: booked > moved > confirmed > claim > transferred > message), conversation and call close, activity on the customer/job timeline, `ai_call_minute` usage event unique on call id with `ceil(ai_seconds/60)`); Builder 2 `text-back.ts` + `providers/twilio/lookup.ts` + `system/line-lookups.ts` (cache 90 days; `shouldTextBack`; gate informational with consent `express` source `call` recorded for the caller; once per number per 24 h); Builder 3 tests.

**Files:** Fill the listed files; Test `apps/api/test/front-desk/after-call.test.ts`.
- [ ] **Tests:** summary saved; outcome precedence; one usage event even if the job runs twice; spam calls bill AI seconds only; text-back table cases end-to-end through the gate (blocked by quiet hours → scheduled); lookup cached; timeline card created.
- [ ] **Commit:** `feat(api): after each call — summary, outcome, AI minutes, timeline and missed-call text-back`

---

### Task 14: Text channel

**Split:** Builder 1 the one call in `hooks/twilio.ts` after S1's `onStormReply` (`await queueFrontDeskText(tx, message)` when Front Desk texts are on, the message isn't STOP/HELP/START, and S1 didn't consume it) + conversation grouping (active SMS conversation per number; new after 24 h) + `messages.conversation_id`; Builder 2 `texts.ts` (`fd-text` job, debounced 20 s: gather unanswered inbound texts, skip when `handled_by = 'team'` or a team reply within 2 h; "C"/"confirm" shortcut via Task 8's helper; engine with `TEXT_CHANNEL_TOOLS`; reply joined to ≤ 2 segments where possible; send through the gate as `informational` with `inReplyToInboundAt`); Builder 3 `send-gate/decide.ts` (`inReplyToInboundAt?: Date` — quiet hours don't delay a reply sent within 10 minutes of the customer's text) + tests.

**Files:** Fill the listed files; Modify `apps/api/src/hooks/twilio.ts` (one call), `packages/send-gate/src/decide.ts` (+ its test); Test `apps/api/test/front-desk/texts.test.ts`, `packages/send-gate/test/decide.test.ts` (extend).
- [ ] **Tests:** three quick texts → one reply; team reply silences for 2 h; "Team is handling" silences; STOP never reaches Front Desk; S1 YES reply never double-answered; quiet-hours exception only within 10 minutes; guard applied to texts; confirm shortcut.
- [ ] **Commit:** `feat(api): Front Desk answers texts through the send gate unless the team is handling it`

---

### Task 15: Spam

**Split:** Builder 1 `providers/call-screen.ts` real rules (spec Decision 13) + `repos/blocked-numbers.ts` + calls-per-hour count; Builder 2 router intents `spam`/`sales_pitch` → engine `end_call` path + conversation outcome `spam`; Builder 3 `POST /api/calls/:id/spam` (block number, outcome spam) + `DELETE /api/blocked-numbers/:id` + tests.

**Files:** Fill the listed files; Modify `apps/api/src/hooks/twilio-voice.ts` only to pass real inputs to `screenCall` (Task 10 left the call site); Test `apps/api/test/front-desk/spam.test.ts`.
- [ ] **Tests:** rule table; blocked number rejected before the relay (no AI seconds); known customers never auto-rejected by STIR rules; sales pitch ends politely; mark/unmark spam; text-back never to spam.
- [ ] **Commit:** `feat(api): spam calls — STIR/SHAKEN, the company blocklist and polite endings`

---

### Task 16: Retention sweep

**Split:** Builder 1 `system/fd-retention.ts` (per company: recordings older than `recording_retention_days` (spam: 7) → delete from R2 and mark `deleted`; turns older than `transcript_retention_days` (spam: 7) → `text = ''`, `tool_calls` reduced to names); Builder 2 `jobs/scheduler/fd-retention.ts` fan-out + customer-delete hook (F1's delete path calls `purgeCustomerConversations`); Builder 3 tests.

**Files:** Fill the listed files; Modify the F1 customer delete function (one call); Test `apps/api/test/front-desk/retention.test.ts`.
- [ ] **Tests:** boundaries by days; spam 7 days; `recording_retention_days = 0` means calls are never recorded (Task 12 checks it) and nothing to sweep; summaries kept; customer delete purges at once; idempotent.
- [ ] **Commit:** `feat(api): Front Desk retention — recordings, transcripts and spam on schedule`

---

### Task 17: Number voice setup and the forwarding test

**Split:** Builder 1 voice URL setup (`setVoiceUrl` on the company's number when Front Desk settings are first saved and on `Registrar.ensureNumber` results; an `fd-number-voice` repair in `fd-health` for numbers without it); Builder 2 `forwarding-test.ts` (`POST /api/front-desk/forwarding-test` owner/office → `placeTestCall` from `TWILIO_TEST_CALLER_NUMBER` to the business number (`companies.phone_e164` from F3's company basics; missing → 422 field `phone` "Add your business phone number in Settings → Company first."); the voice hook recognises `From = TWILIO_TEST_CALLER_NUMBER` + a pending test for that company → answers `<Say>Forwarding works.</Say><Hangup/>` and marks verified; 30 s timeout → failed with the likely cause); Builder 3 `phone_number` in `shared/setup.ts`/`repos/setup.ts` (done when verified; "Coming with" removed) + tests.

**Files:** Fill the listed files; Modify `apps/api/src/hooks/twilio-voice.ts` (the test-call branch, first statement after routing), `packages/shared/src/setup.ts`, `packages/db/src/repos/setup.ts`; Test `apps/api/test/front-desk/forwarding.test.ts`.
- [ ] **Tests:** test call placed once per minute max; arrival marks verified and the setup item done; timeout fails; another company's pending test is not matched; Front Desk can't be enabled before verification unless `override: true` from the owner.
- [ ] **Commit:** `feat(api): Front Desk number setup and a one-click call-forwarding test`

---

### Task 18: Conversations, settings and stats API

**Split:** Builder 1 `routes/conversations.ts` (list with filters and cursor; detail with turns (`text` hidden when not stored), tool action cards, links; reply (gate) — sets `team_until = now + 2 h`; handling switch; read); Builder 2 `routes/front-desk.ts` settings (zod, owner/office; facts ≤ 2,000 chars; enabling checks forwarding) + `PUT /api/me/transfer-phone` (E.164, `ackRecording` required) + voices list; Builder 3 stats (`GET /api/front-desk/stats?week=`: answered, booked, transferred, messages, spam, p50 first reply ms, guard blocks, AI minutes vs plan) + tests.

**Files:** Fill the listed files and `packages/db/src/repos/front-desk-settings.ts`; Test `apps/api/test/front-desk/routes.test.ts`.
- [ ] **Tests:** rep sees only conversations of their customers (and unknown-number conversations only if they're on-call); recordings links per role; reply goes through the gate and silences the AI; settings validation; stats from seeded turns; cross-tenant 404 on every route.
- [ ] **Commit:** `feat(api): conversations inbox, Front Desk settings and weekly stats`

---

### Task 19: Wiring the tools and the full call path

**Split:** Builder 1 `tools/index.ts` (the handler map, filtered by channel and settings; tool descriptions from shared); Builder 2 relay ↔ engine ↔ tools in one integration test per scenario (booking, job question verified, claim, message, transfer leak, angry, recording objection, spam) using `FakeVoiceSession` + `ScriptedLlm`; Builder 3 fix-ups found by those tests inside Tasks 6–11 files (owner of the file's task reviews).

**Files:** Fill `apps/api/src/front-desk/tools/index.ts`; Create `apps/api/test/front-desk/call-paths.test.ts`.
- [ ] **Tests:** each scenario reaches its outcome, records turns with timings, creates the right records, and ends with the right TwiML/handoff.
- [ ] **Commit:** `feat(api): Front Desk end to end on the server — calls through the engine and its tools`

---

### Task 20: Web skeleton

**Split:** Builder 1 routes (`/front-desk`, `/front-desk/:conversationId`), dock flag (`front_desk` shipped, no "Coming soon"); Builder 2 placeholders and `api.ts`, Settings slots (`FrontDeskTab` for owner/office; `TransferPhone` under "Your profile" for everyone); Builder 3 copy files (`front-desk`, `forwarding` — carrier and VoIP names allowed in `forwarding.ts`), `test/d1-routes.test.tsx`.
- [ ] **Tests:** routes render placeholders; dock opens `/front-desk`; Settings tab visibility by role.
- [ ] **Commit:** `feat(web): routes and slots for Front Desk`

---

### Task 21: Web: Front Desk window and stats

**Split:** Builder 1 `FrontDeskWindow.tsx` (list with filters, unread, outcome chips, live call rows with a pulsing dot, polling 5 s while any call is live, else 30 s); Builder 2 `WeekStats.tsx` (numbers in a row of stat tiles; AI minutes as "212 of 500 minutes"); Builder 3 hooks + tests; empty state "No calls yet. Once forwarding is on, every call shows up here."
- [ ] **Commit:** `feat(web): Front Desk window — calls and texts with this week's numbers`

---

### Task 22: Web: conversation view and inbox reply

**Split:** Builder 1 `ConversationView.tsx` (header, transcript with speaker styles, truncated marks, "Transcript not kept at the caller's request", tool action cards linking to records); Builder 2 `RecordingPlayer.tsx` (fetches the signed URL on play; native `<audio controls>`) + summary panel + "Mark as spam" / "Call back"; Builder 3 `ReplyBox.tsx` (texts; gate errors shown plainly) + handling switch + tests.
- [ ] **Commit:** `feat(web): conversation view with transcript, recording, summary and replies`

---

### Task 23: Web: Settings → Front Desk and transfer phones

**Split:** Builder 1 `FrontDeskTab.tsx` (on/off with reason, texts, voice previews, facts with a counter, what it may do, ring team first, text-back, retention, concurrency); Builder 2 on-call list ordering (drag handle + up/down buttons for keyboard) showing members' transfer phones; Builder 3 `TransferPhone.tsx` (own phone, prefilled from `users.phone_e164`, recording acknowledgement checkbox) + tests.
- [ ] **Commit:** `feat(web): Front Desk settings and the on-call list`

---

### Task 24: Web: forwarding guide and test

**Split:** Builder 1 `ForwardingGuide.tsx` (carrier picker, mode all/no-answer, codes from `forwardingSteps` in large type with copy buttons, VoIP steps); Builder 2 test button and status polling ("Calling your business number…", "Forwarding works", "We didn't receive the call — check the code and try again"); Builder 3 setup checklist link (`phone_number` opens this) + tests.
- [ ] **Commit:** `feat(web): call-forwarding guide per carrier with a one-click test`

---

### Task 25: Scripted call evals and latency report

**Split:** Builder 1 scenarios `apps/api/test/front-desk/scenarios/*.ts` (spec §16 list: caller lines, seeded data, `must` (tools called, outcome, guard hits = 0 or expected), `mustNot` (phrases, tools), tone rubric) + the CI runner over `ScriptedLlm` scripts derived from each scenario (proves plumbing and rubric code); Builder 2 `scripts/eval-front-desk.ts` (`npm run eval:front-desk -- --confirm-spend [--scenario x] [--runs 3]`: real `Llm`, a Haiku 5.5 caller-simulator that plays the caller's script turn by turn, code-graded must/mustNot, a Haiku 5.5 tone grader with a fixed rubric, refuses without `ANTHROPIC_API_KEY` and `--confirm-spend`); Builder 3 latency report (p50/p95 router, first token, total per scenario and route; cost per run from usage) written to `docs/superpowers/d1-latency.md` by hand after a run + `smoke-guards` test that the script refuses without the flag.

**Files:** Create the listed files; Modify `apps/api/package.json` (`eval:front-desk`).
- [ ] **Commit:** `test(front-desk): scripted call evals with real models by hand, and a latency report`

---

### Task 26: Web: timelines, Today, appointments, dock badge

**Split:** Builder 1 call/text cards in C1's customer and job timelines (summary, outcome, link to the conversation); Builder 2 "Booked by Front Desk" on appointments and confirmed marks; Builder 3 Today follow-up rendering for Front Desk items + the dock badge (unread conversations needing attention) + tests.

**Files:** Modify `apps/web/src/features/{customer,job}/Timeline*.tsx` (card type only), `apps/web/src/features/calendar/AppointmentSheet.tsx` (badge), `apps/web/src/features/today/*` (item kind), `apps/web/src/shell/dock/badges.ts`.
- [ ] **Commit:** `feat(web): Front Desk calls and bookings across timelines, the calendar and Today`

---

### Task 27: End-to-end, acceptance map, docs; manual smoke

**Files:** Create `apps/web/e2e/front-desk.spec.ts`, `docs/superpowers/{d1-acceptance,d1-manual-smoke}.md`, `apps/api/src/scripts/smoke/front-desk.ts`, `apps/api/test/smoke-front-desk-guards.test.ts`; Modify `apps/web/e2e/{phone,a11y}.spec.ts`, `README.md` (Anthropic, relay URL, test caller number, eval and smoke commands), the e2e reset (seed conversations through a new `seedFrontDeskFixture(pools)` exported from `apps/api/src/index.ts`).
- **E2E:** the window lists seeded conversations; open a call with transcript and action cards; reply to a text (fake SMS adapter receives it); "Team is handling"; Settings save; the forwarding test with fakes (fake call control "arrives" the call); a11y on `/front-desk`, a conversation and Settings → Front Desk; phone no-scroll on the window and conversation.
- **Manual smoke (`smoke:front-desk --confirm-real-providers`):** a staging number with ConversationRelay: call it — disclosure heard, book an inspection on a test company, "what's the price?" → guard line, "water's coming in" → transfer to a test phone with whisper, decline → message; "stop recording"; recording in R2 and gone from Twilio; a forwarded call from each test carrier phone; a text conversation; latency numbers from real calls into `d1-latency.md`; scrubbed Anthropic fixtures replace Task 5's.
- **`d1-acceptance.md`:** every spec §17 bullet → its tests.
- [ ] **Verify:** typecheck, lint, `npx playwright test --list`; CI via `ci-check`.
- [ ] **Commit:** `test(e2e): Front Desk inbox, settings and forwarding; D1 acceptance map and manual smoke`

---

## Rulings

1. **All D1 schema is in Task 1's migrations (0018, 0019);** Task 1 is the only lockfile edit (`@anthropic-ai/sdk`, `ws`, `@types/ws`).
2. **Skeleton tasks own the hotspots:** Task 1 (schema, barrels, lockfile), Task 4 (`app.ts`, `server.ts` upgrade stub, `config.ts`, `deps.ts`, `jobs/*`, `test/helpers.ts`, env docs), Task 20 (`router.tsx`, `shell/apps.ts`, Settings slots). Exceptions: Task 11 replaces the upgrade stub in `server.ts`; Task 17 adds the test-call branch in `hooks/twilio-voice.ts`; Task 15 fills the `screenCall` inputs there.
3. **No R2 steps for Front Desk:** its live actions are allowed by master §2 without approval; every action still leaves an activity and an audit-log entry with actor `agent:front_desk`.
4. **History is append-only** (preserved-thinking rule on Opus 5.5): the engine never edits or deletes earlier messages; operator notes are new system messages; truncation on interruption appends a short note instead of rewriting the assistant turn sent to the model.
5. **The router never has tools and never acts;** only Opus calls tools. A Haiku `fastReply` is limited to 200 characters and guarded like everything else.
6. **`ObjectStore.signedGetUrl`** is added by Task 12 only if E1's `ObjectStore` lacks it (R2 presigned GET via `aws4fetch`; the memory store returns a local test URL).
7. **The welcome greeting is Twilio's, not the model's,** so the disclosure has zero model latency and can't be skipped by a model error; the model's prompt says it has already been said.
8. **Calls over the company cap or during an LLM outage never reach the model:** they ring the on-call list, then record a voicemail (`<Record maxLength=120>`, stored like recordings) and send the text-back.
9. **Evals with real models are manual and cost money;** CI runs the same scenarios with `ScriptedLlm` to prove the plumbing and rubric code, never quality.
10. **Spanish and other languages are out of D1** (spec Decision 17); a Spanish-speaking caller is offered a person (router intent `other_language` → transfer, or message when nobody answers).
