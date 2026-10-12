### Task 4: API skeleton — seams, fakes, config, jobs, hooks, the `/relay` upgrade

**Base:** `d1-front-desk` after Tasks 1 and 3 are merged. Real (F3): `config.ts`, `deps.ts` (`AppDeps`, `buildDeps`), `server.ts` (`const server = app.listen(...)` — the `upgrade` handler attaches to it), `jobs/{queue,handlers,worker}.ts`, `test/helpers.ts` (`FakeWeatherSource`, `testConfig`), `hooks/twilio.ts` (mount before the session gate), `providers/registrar.ts` (`SubaccountRef { accountSid, authToken }`), the `twilio` npm package (^6, already in `apps/api`). **[C1]**/**[E1]**/**[S1]** their T5/T7 skeletons already extended `JOB_NAMES`, `SCHEDULES`, `AppDeps` and mounts — append after them.

Read first: `ops/sdd/d1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-front-desk-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** come from those plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`, `ops/sdd/s1/`), not from built code: check each against `c1-crm`/`e1-estimator`/`s1-storm` before starting and report any difference.

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

**Tests:**
- config groups and defaults; fakes' documented behaviour; `/hooks/twilio/voice` reachable without a session (501 stub); the upgrade on another path is refused; `JOB_NAMES`/`SCHEDULES` gain the names.

**Carries and rulings:**
- **LLM rules (Ruling DA):** the only Claude client is `@anthropic-ai/sdk` (`new Anthropic({ apiKey, fetch?, maxRetries })`) inside `apps/api/src/providers/anthropic/`; model ids exactly `claude-haiku-5-5` (router, summaries) and `claude-opus-5-5` (answers), from config defaults. Tests use `ScriptedLlm`; the adapter's own test injects a scripted fake `fetch` serving recorded fixtures. **No test or CI step ever reaches api.anthropic.com**: `testConfig()` leaves `ANTHROPIC_API_KEY` unset so `anthropicFor()` returns null, and CI sets no key.
- **Ruling DC:** add `daily()` to `FakeWeatherSource` in `test/helpers.ts` now (returns `null`), so T7 changes only `weather/*` and its own tests.

- **Ruling DB:** add `test('tests and CI never build a real Claude client')`: `anthropicFor(testConfig())` is null, `makeTestApp().deps.llm` is the `ScriptedLlm`, and `buildDeps` with `FAKE_PROVIDERS=1` uses `ScriptedLlm` even when `ANTHROPIC_API_KEY` is set.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): D1 skeleton — LLM, voice session, call control and lookup seams with fakes; voice hooks and relay socket`
