## Global Constraints (D1 Front Desk)

Adapted from the C1, E1 and S1 global constraints (`ops/sdd/{c1,e1,s1}/global-constraints.md`, which carry F1–F3's rules) and the plan's Global Constraints (`docs/superpowers/plans/2026-10-12-roofline-front-desk.md`). Spec: `docs/superpowers/specs/2026-10-12-roofline-front-desk-design.md`. Branch `d1-front-desk` (parallel track from `c1-crm` dfa9132; merges `c1-crm` as it advances); task branches `d1-t<N>`. D1 rulings use the prefix **D** (DA, DB, …).

**C1, E1 and S1 are not built yet.** Names marked **[C1]** / **[E1]** / **[S1]** in a brief come from those plans and briefs. The lead checks each against the merged branch before starting and records any difference; a renamed export is followed, not re-created.

**Everything in the C1/E1/S1 global constraints applies**, with these D1 changes:
- **Migrations (Ruling AP, overrides every 0018/0019 below):** D1 owns `0019_front_desk_schema.sql` and `0020_front_desk_grants_rls.sql` (Task 1). D1's base (`c1-crm`) ends at `0014`; E1 takes 0015/0016 and S1 0017/0018 on their own tracks. Generate on D1's base, then rename the file, its snapshot and the journal `tag` to 0019/0020 (journal `idx` stays sequential); the controller fixes journal order when tracks merge.
- **Lockfile:** only Task 1 (`@anthropic-ai/sdk`, `ws`, `@types/ws`).
- **Claude (Ruling DA):** the only client is the Anthropic TypeScript SDK `@anthropic-ai/sdk`, inside `apps/api/src/providers/anthropic/`, behind the `Llm` seam. Model ids exactly `claude-haiku-5-5` (routing, summaries) and `claude-opus-5-5` (answers). **Tests use `ScriptedLlm` only**; the adapter's own unit test uses a scripted fake `fetch` with recorded fixtures. **No live Anthropic call ever happens in tests or CI**: no key in `testConfig()` or CI, `FAKE_PROVIDERS=1` forces `ScriptedLlm` (Ruling DB), and `eval:front-desk` / `smoke:front-desk` are manual and refuse without their confirm flags.
- **Live sockets:** the ConversationRelay WebSocket attaches to the HTTP server returned by `app.listen` in `apps/api/src/server.ts`.

**From the plan (verbatim):**
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
