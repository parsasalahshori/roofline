### Task 6: Conversation engine and prompt

**Base:** `d1-front-desk` after Tasks 2 and 4 are merged. From T2: `guardSentence`, `SentenceBuffer`, `shouldTransfer`, `turnLimit`. From T4: `Llm`, `ScriptedLlm`, `EngineEvent` types. Real: `withTenant`, `addActivity`, `audit`.

Read first: `ops/sdd/d1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-front-desk-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** come from those plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`, `ops/sdd/s1/`), not from built code: check each against `c1-crm`/`e1-estimator`/`s1-storm` before starting and report any difference.

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

**Tests:**
- fast route speaks Haiku's reply and cancels Opus (`signal.aborted`); opus route streams sentences through guards; guard replacement recorded in `guard_hits`; tool loop with filler; unknown id refused; refusal → handoff; two model errors → handoff; turn limits; cached prefix identical across two turns and two calls of a company, different between companies; history is append-only.

**Carries and rulings:**
- **LLM rules (Ruling DA):** the only Claude client is `@anthropic-ai/sdk` (`new Anthropic({ apiKey, fetch?, maxRetries })`) inside `apps/api/src/providers/anthropic/`; model ids exactly `claude-haiku-5-5` (router, summaries) and `claude-opus-5-5` (answers), from config defaults. Tests use `ScriptedLlm`; the adapter's own test injects a scripted fake `fetch` serving recorded fixtures. **No test or CI step ever reaches api.anthropic.com**: `testConfig()` leaves `ANTHROPIC_API_KEY` unset so `anthropicFor()` returns null, and CI sets no key.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): the Front Desk conversation engine — routing, streaming answers, tools and guards`
