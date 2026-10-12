### Task 5: Anthropic adapter

**Base:** `d1-front-desk` after Task 4 is merged. From T4: `Llm`, `RouteInput`, `RouteDecision`, `AnswerInput`, `LlmEvent`, `TurnUsage`, `LlmUnavailableError`, stub `providers/anthropic/index.ts` (`anthropicFor(config): Llm | null`). From T3: `toolJsonSchemas()`, `TEXT_CHANNEL_TOOLS`. `@anthropic-ai/sdk` added by T1. Reference: the claude-api skill notes in the plan's Global Constraints (adaptive thinking cannot be disabled on Opus 5.5; no forced `tool_choice`; `fallbacks: 'default'` with beta `server-side-fallback-2026-07-01`; Haiku has no server-side fallback).

Read first: `ops/sdd/d1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-front-desk-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** come from those plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`, `ops/sdd/s1/`), not from built code: check each against `c1-crm`/`e1-estimator`/`s1-storm` before starting and report any difference.

**Split:** Builder 1 `client.ts` + `errors.ts` (one `Anthropic` client from config, `maxRetries: 1`, timeout 20 s for answers / 5 s for routes; error mapping to `LlmUnavailableError` by SDK class); Builder 2 `route.ts` + `summarize.ts` (Haiku, `output_config: { effort: 'low', format: { type: 'json_schema', schema } }`, zod-validated, `max_tokens` 300 / 800); Builder 3 `answer.ts` (Opus stream) + tests with recorded SSE fixtures through an injected `fetch`.

**Files:** Fill `apps/api/src/providers/anthropic/{client,route,answer,summarize,errors,index}.ts`; Create `apps/api/test/fixtures/anthropic/*.sse` and `*.json` (shapes from the SDK docs; Task 27 replaces them with scrubbed real captures); Test `apps/api/test/anthropic-adapter.test.ts`.

**Interfaces:**
- `answer`: `client.beta.messages.stream({ model, max_tokens: 1024, betas: ['server-side-fallback-2026-07-01', ...(fast ? ['fast-mode-2026-02-01'] : [])], fallbacks: 'default', ...(fast ? { speed: 'fast' } : {}), output_config: { effort: 'low' }, system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral', ttl: '1h' } }, { type: 'text', text: companyBlock, cache_control: { type: 'ephemeral', ttl: '1h' } }], tools: toolJsonSchemas() filtered by channel with `strict: true, eager_input_streaming: true`, tool_choice: { type: 'auto' }, messages }, { signal })`; yields `text` deltas as they arrive, a `tool_use` event per completed tool block (input from the final message, `JSON.parse`d and zod-checked by the engine), and `done` with usage (`cache_read_input_tokens` → `cachedTokens`) and the full assistant content (echoed back unchanged in history, thinking blocks included).
- Fast mode on 429: drop `speed` and retry once at standard speed (note: cache miss).
- `route`: the router prompt is its own frozen text (cached); output schema `{ intent: string (≤ 40), urgent: boolean, mood: enum, route: enum, fastReply: string | null (≤ 200) }`.
- Refusal: `stop_reason === 'refusal'` → `done` with `stopReason: 'refusal'` (the engine hands off). `fallback` content blocks are ignored for display.

**Tests:**
- request bodies match fixtures (model ids, effort, betas, fallbacks, tool order, cache breakpoints, no `thinking` field, no `tool_choice` any/tool); text deltas stream in order; tool input assembled; refusal surfaced; 429 with fast mode retries without it; usage mapping; keys never logged.

**Carries and rulings:**
- **LLM rules (Ruling DA):** the only Claude client is `@anthropic-ai/sdk` (`new Anthropic({ apiKey, fetch?, maxRetries })`) inside `apps/api/src/providers/anthropic/`; model ids exactly `claude-haiku-5-5` (router, summaries) and `claude-opus-5-5` (answers), from config defaults. Tests use `ScriptedLlm`; the adapter's own test injects a scripted fake `fetch` serving recorded fixtures. **No test or CI step ever reaches api.anthropic.com**: `testConfig()` leaves `ANTHROPIC_API_KEY` unset so `anthropicFor()` returns null, and CI sets no key.
- Thinking blocks are kept in history unchanged (append-only, plan Ruling 4); never send `thinking: { type: 'disabled' }` or `budget_tokens`.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): Claude adapter — Haiku 5.5 routing and summaries, Opus 5.5 streaming answers with strict tools`
