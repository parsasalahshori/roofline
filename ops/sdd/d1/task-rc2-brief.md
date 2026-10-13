### Task RC-2: after-call, message and handoff fixes on top of Task CV

**Base:** `d1-cv` 77d57beb, which is CV merged with d1-front-desk df798d1. It merges into d1-front-desk right after CV. Findings: `ops/sdd/d1/pre-review-findings.md` (numbers) and the E1 lead's final-review notes F2 and F3 (quoted below).

**Files:**
- `apps/api/src/front-desk/tools/message.ts`
- `after-call.ts`
- `engine.ts` (start() and the handoff event only)
- `engine-types.ts`
- `apps/api/src/front-desk/relay-session-loop.ts` (the HandoffData type and its fill only; Task RA edits this file too, so keep the change minimal)
- `apps/api/src/hooks/twilio-voice-transfer.ts`
- `apps/api/src/jobs/scheduler/fd-health.ts`
- `packages/db/src/repos/calls.ts` and `conversations.ts`
- a NEW `packages/db/src/system/idle-sms.ts` if needed
- their tests

**Not yours:**
- RC-1 (S1 lead, d1-rc1): texts.ts, turns.ts, state.ts, engine turn logic, tools/caller.ts, tools/transfer.ts, providers/anthropic, the new repos/conversation-identity.ts.
- RA (d1-ra): relay-server.ts, recording*, routes/calls.ts, web.
- E1's d1-rev-e/f: tools/jobs.ts, conversation-inbox.ts, hooks/twilio.ts.

1. **Note 28:** the urgent take_message email to on-call staff goes out at most once per conversation. Dedupe it with the messages partial unique index, using a key like `fd-urgent-<conversationId>` (d1-rev-d added the index on dedupe_key LIKE 'fd-%'), or with an existing activity check. Test: two urgent take_message calls in one conversation send one email.
2. **Note 41:** SMS conversations idle for 24 h get ended and summarised.
   - An fd-health pass lists company ids with idle SMS conversations. app_system has no grant on conversations, so list companies from a table it can read, or iterate over the companies with Front Desk on (company_settings via the system pool, if granted; check 0020 and 0002).
   - Then, per company on the tenant pool inside withTenant, it finds conversations with channel 'sms', status 'open' and last activity older than 24 h, and enqueues `fd-after-call` with `{companyId, conversationId}`.
   - runAfterCall accepts `{conversationId}` without callSid for SMS. It summarises, sets status 'ended', and writes a 'text_conversation' activity when there is a customer. No usage, no text-back.
   - Tests for both the pass and the SMS after-call.
3. **F2 (E1 final review): the phone match at call start never runs.** Nothing calls identifyCaller, so every voice caller stays 'unknown' with customerId null. In `engine.start` for voice (after CV's link/reuse), run the existing phone match:
   - Find identifyCaller and its repo helper (fd-caller.ts).
   - One customer matches: set state identity 'matched' and customerId, and write conversations.customer_id and identity.
   - Ambiguous or none: stay 'unknown'.
   - Tools still require 'verified' for anything sensitive. Do not loosen that.
   - Tests: a known caller's conversation gets customer_id and 'matched'; an unverified matched caller's take_message writes the front_desk_message activity on that customer (Ruling EA: no job next-step change).
4. **F3 (E1 final review): transfer urgency never reaches the dial decision.**
   - Add `urgent: boolean` to the engine's handoff event and to relay-session-loop's HandoffData. It is true when transfer_to_person's own plan was urgent or the router decision was urgent.
   - Use it in `/after-relay` (twilio-voice-transfer.ts:~112) instead of `urgent: false`.
   - Test: after hours, an urgent take_message followed by a person-ask rings on-call staff, not message mode.
5. **CV gap: needs_attention for voice.** The inbox derives needs_attention from conversations.unread_count, which voice never sets. When after-call ends a voice conversation whose outcome is booked, message, claim or transferred-unanswered, set unread_count to at least 1 (same column semantics as SMS). Test: a booked voice call shows needs_attention in the inbox list query (repos/conversation-inbox listing).

**Rules:**
- No new migration.
- The system pool only lists ids; work runs per company on the tenant pool. A Drizzle update also writes updated_at.
- No live providers (Rulings DA/DB). Logs carry ids only. The repo is public.
- Test locally first: Docker is up (`docker info`); run `npx vitest run --project @roofline/api apps/api/test/front-desk` and the touched db tests, then ci-check with CI_JOBS="Platform E2E".
- Commit: `fix(api): after-call for SMS, caller match at call start, urgent handoffs, voice needs-attention`.
