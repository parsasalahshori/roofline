# D1 Task 14: Text channel report

## Built
- A-db-and-hook: packages/db/src/repos/fd-texts.ts (+ test), apps/api/src/hooks/twilio.ts (D1 call only, Ruling AV comment for S1/G1; `consumed` hard-coded false until they exist).
- B-texts-job: apps/api/src/front-desk/texts.ts (exported idempotent `queueFrontDeskText(tx, message, opts?)` with `consumed` flag; `runFrontDeskText` for the fd-text job; all replies via the gate as informational), jobs/handlers.ts, test/front-desk/texts.test.ts.
- C-send-gate: optional `inReplyToInboundAt` (10 minute window) in packages/send-gate/src/decide.ts, test, apps/api/src/messaging/gate-request.ts.

## Reviews
- Review 1: 3 findings. Contact check: F1 rejected, F2 amended, F3 amended.
- Review 2: 0 findings.

## CI
- Round 1 (run 38226341352): Platform failed; texts.test.ts wrote company_settings through the system pool (no grant). Fixed by writing inside withTenant.
- Round 2 (run 38227332794): repos-fd-texts.test.ts deleted from company_settings (no DELETE grant). Removed that step.
- Round 3 (run 38228592022, dec2ff2): Platform and E2E passed.

## TODOs left
- TODO(Task 8): 'C'/'confirm' goes through the engine as a normal text.
- TODO(Task 7): conversations with null customerId are not answered yet.
- S1 onStormReply and G1 claims hook not on this base; 'S1 YES never double-answered' untested.

## Verify tail
typecheck and lint clean; @roofline/shared 802 passed; @roofline/send-gate 502 passed.
