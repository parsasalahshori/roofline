### Task 4: Claude drafting for agent texts and claim-reply extraction

**Base:** `g1-t4` = `g1-stack` (G1 T3, T5, T6, T17s) merged with `origin/d1-t5` cd7af96 (D1 Task 5: the Claude adapter in `apps/api/src/providers/anthropic/` — `client.ts` (`buildClients` → `{ client, routerModel, answerModel }` from `FRONT_DESK_ROUTER_MODEL`/`FRONT_DESK_ANSWER_MODEL`), `route.ts`, `answer.ts` (Opus with `betas: ['server-side-fallback-2026-07-01']`, `fallbacks: 'default'`), `summarize.ts` (Haiku structured output with `output_config: { effort: 'low', format: { type: 'json_schema', schema } }`, cached system blocks, zod check, refusal/max_tokens → `LlmUnavailableError`), `errors.ts` (`toLlmError`), `prompts.ts`), Ruling AZ. The merge put "Not built yet." stubs for `draftTexts`/`extractClaimReply` in `anthropic/index.ts`; this task replaces them. The merge is held until d1-front-desk contains D1 T4 and T5.

Read first: `ops/sdd/g1/global-constraints.md`, `ops/sdd/g1/progress.md` (Rulings DA, GX-B; the Task 3 carries: the code's signatures win over the plan), spec §2 Decision 2, §3.3, §8; `providers/llm.ts` (`DRAFT_KINDS`, `JobFacts`, `DraftTextsResult` with `refused`, `ClaimReplyFacts`, `MAX_DRAFT_JOBS`, `LlmRefusedError`), every file in `providers/anthropic/` and `apps/api/test/anthropic-*.test.ts` (their fake-fetch pattern and fixtures in `test/fixtures/anthropic/`), `packages/shared/src/claims-guard.ts`.

**Split:**
- Builder 1: `providers/anthropic/draft-texts.ts` and the per-kind instructions in `providers/anthropic/draft-prompts.ts`.
- Builder 2: `providers/anthropic/extract-claim.ts`; wire both into `anthropic/index.ts` (replace the two stubs); config if a model setting is needed (below).
- Builder 3: `apps/api/test/anthropic-draft.test.ts`, `apps/api/test/anthropic-extract.test.ts` and their fixtures under `test/fixtures/anthropic/`.

**Models (Ruling DA, spec §2):** drafting `claude-opus-5-5`, extraction `claude-haiku-5-5`. Add `AGENT_DRAFT_MODEL` (default `claude-opus-5-5`) and `AGENT_EXTRACT_MODEL` (default `claude-haiku-5-5`) to `config.ts` like D1's `FRONT_DESK_*_MODEL` keys (and to `buildClients`' result as `draftModel`/`extractModel`), so the owner can change them without code.

**`draftTexts({ instruction, facts })`** (`draft-texts.ts`):
- `facts.length > MAX_DRAFT_JOBS` → `RangeError` (before any request); `facts.length === 0` → `{ texts: [], refused: false, usage: zero }` without a request.
- One `messages.create` (non-streaming) on the draft model with `output_config: { effort: 'low', format: { type: 'json_schema', schema: DRAFT_SCHEMA } }`, the same server-side fallback beta and `fallbacks: 'default'` as `answer.ts`, and a `max_tokens` sized for up to 25 texts (e.g. 4000).
- `system`: a shared drafting prompt (plain, polite, ≤ 300 characters, first name, the company name, only the facts given, no prices, no coverage or deductible talk, never offering to contact the insurer, no links unless a fact gives one, end with "Reply STOP to opt out" only for `review_request`) cached with `cache_control: { type: 'ephemeral', ttl: '1h' }`, then the per-kind instruction (one per `DraftKind`, in `draft-prompts.ts`, e.g. `claims_ask_filed`: "Ask whether they have filed their insurance claim yet and, if so, to reply with the claim number and the insurer.") also cached. The user message is the JSON of `facts`.
- `DRAFT_SCHEMA`: `{ texts: [{ jobId: string, body: string }] }` (strict, additionalProperties false).
- After parsing (zod): drop any text whose `jobId` is not in `facts`, duplicates after the first, bodies over 300 characters, and bodies that fail `claimsGuard` (any hit). Kept texts are returned in `facts` order; dropped ones are simply missing (the caller writes them from a template, per the `DraftTextsResult` doc). `refused: true` with `texts: []` when `stop_reason === 'refusal'`; a `max_tokens` stop or unparseable JSON → `LlmUnavailableError`; transport errors via `toLlmError`.
- `usage` from the response like `summarize.ts` does.

**`extractClaimReply({ text, now, timeZone })`** (`extract-claim.ts`):
- One `messages.create` on the extract model with structured output: schema `{ claimNumber: string|null, insurer: string|null, adjusterAt: string|null /* ISO 8601 with offset */, decision: 'approved'|'partly_approved'|'denied'|null }`; the system prompt (cached) says to extract only what the homeowner actually stated, to resolve relative dates ("next Tuesday at 10") against the `now` and `timeZone` given in the user message, and to return null for anything not stated.
- Validate: `claimNumber` ≤ 40 characters; `insurer` ≤ 80; `adjusterAt` must parse and lie within −1 day … +120 days of `now` (else dropped); unknown decision dropped. Return only the fields that survive (omit nulls) as `ClaimReplyFacts`. A refusal → `LlmRefusedError`; `max_tokens`/unparseable → `LlmUnavailableError`.
- Never log the homeowner's text or the model's raw output (global rule: no message bodies in logs).

**Tests** (fake fetch + recorded fixtures, no live call; `anthropicFor(testConfig())` is null in CI — Ruling DB):
- draft: the request body has the draft model, `output_config.effort: 'low'`, the json_schema, `fallbacks: 'default'`, two cached system blocks, the user message with every jobId; 26 facts → RangeError with no request; a response with one guard-failing body, one unknown jobId and one 400-character body returns only the good text; a refusal → `{ texts: [], refused: true }`; a 529/connection error → `LlmUnavailableError`.
- extract: request body (extract model, schema, `now`/`timeZone` in the user message); a reply "It's State Farm, claim 0451-22, adjuster Tuesday 10am" fixture → `{ insurer, claimNumber, adjusterAt }`; an `adjusterAt` a year out is dropped; refusal → `LlmRefusedError`; unparseable → `LlmUnavailableError`.
- index: `anthropicFor(config with a key)` exposes both methods (no network call made).
- Manual only: `eval:agent-texts` is Task 18 (do not build it here).

**Verify:** `npm run typecheck && npm run lint` (slot); CI with `CI_JOBS="Platform E2E"`.
- Commit: `feat(api): Claude drafting for agent texts and claim-reply extraction (G1 Task 4)`
