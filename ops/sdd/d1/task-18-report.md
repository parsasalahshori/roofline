# Task 18 report: Conversations, settings and stats API

## Built
- p1-conversations: routes/conversations.ts, repos/conversation-inbox.ts, conversations-routes.test.ts. Inbox list with filters and cursor, detail, reply through the send gate (informational, team_until now+2h), handling, read. Rep scoping uses isOnCallMember via the system pool.
- p2-settings-transfer: routes/front-desk.ts, repos/front-desk-settings.ts, system/transfer-phone.ts, account/transfer-phone.ts, routes/transfer-phone.ts, settings-routes.test.ts, forwarding.test.ts (it.todo turned into a test). Enable rule (forwarding_verified_at or owner override), ensureVoiceUrl on first enable, voices, transfer phone with ackRecording.
- p3-stats: routes/front-desk-stats.ts, repos/front-desk-stats.ts, stats-routes.test.ts. Weekly stats, forwarding-test caller excluded, owner/office only.

## Review rounds
- Review 1: 1 finding; contact check amended (F1=amend).
- Review 2: 0 findings.

## Minors
- Unknown-texter reply returns 409; followUps always []; blocked-customer assertion may need adjusting after CI; stats tests update companies via the system pool (verify in CI).

## Verify
typecheck, lint clean; vitest @roofline/shared 21 files, 805 tests passed. DB suites run on CI.
