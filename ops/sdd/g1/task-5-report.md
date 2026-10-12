
# Task 5 report: send_personal_texts handler (branch g1-t5, head 80fa3fc)

## Built
- B1-db-repo: `packages/db/src/repos/follow-up-log.ts` (followUpLogFor, recordFollowUp, lastInboundAt, lastStormTextAt), one added line in the db barrel, `packages/db/test/follow-up-log.test.ts`.
- B2-handler: `apps/api/src/agents/personal-texts.ts` (copy of send-batch's structure: lease first in the loop, per-customer tx under lockRecipient, step message rows as idempotency record, gate via gate-request, claims guard and followUpAllowed before the gate verdict is used, follow_up_log row in the same tx for queued/scheduled rows) and its registration in `tasks/handlers.ts`.
- B3-api-test: `apps/api/test/personal-texts.test.ts` (9 tests).
- [S1] Ruling SA per-customer render is not built: bodies are already personal, no template rendering (bodyRendered: true).
- Minor (B1): recordFollowUp is select-then-insert on messageId; no unique index on follow_up_log.message_id. The unique messages_step_customer_uniq guards concurrent runs. A (company_id, message_id) unique index would need a migration.

## Review rounds
- Review 1: 1 finding, amended. Review 2: 1 finding, amended. Review 3: 0 findings. (Details are in the lead's review log.)

## CI rounds (fixes by the finalizer, tests only)
- Run 38210967451 failed: personal-texts tests used newTask, which refuses the agent-only step type (fixed: createTask with allowInternalStepTypes, as task-events.test.ts does); follow-up-log fixtures reused address key 'main1' within a company (fixed: unique key per customer).
- Run 38212143329 failed: two tests (quiet hours, retry) used review bodies without the company name and opt-out line, so the gate's marketing content rule blocked them (fixed: body names Acme Roofing and says Reply STOP to opt out).
- Run 38213370913: Platform and E2E passed.

## Verify tail
typecheck, lint clean; `vitest run --project @roofline/shared`: 27 files, 995 tests passed. CI run 38213370913 PASSED.
