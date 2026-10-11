# F3 Task 11 report: early delivery reports, status routed by messaging service

Built (branch f3-t11, head e689d8c):
- P1-db: delivery.ts (lockDeliverySid per-SID advisory xact lock, saveEarlyDeliveryReport, applyEarlyDeliveryReports); markTextSent applies early reports in the same tx; recordDeliveryOutcome returns applied/ignored/unknown_sid.
- P2-hooks: companyIdForMessagingService in system/routing.ts; hooks/twilio.ts /status routes by From (includeInactive) then MessagingServiceSid, runs lock -> record -> save-early under one withTenant; once/STATUS_EVENTS and claim/release imports removed; no webhook_events for /status.
- P3-tests: delivery-reports.test.ts (6 tests); twilio-hooks.test.ts updated.

Review 1: verify passed, 0 findings.
CI round 1 (run 38180549570): failed, one test: released-number /status expected 404, now 200 (report applied). Fixed in e689d8c by rewriting that test to expect 200 and 'delivered'.
CI round 2 (run 38181151654): Platform passed.

Minors / deviations:
- 'a duplicate callback is ignored' renamed 'a repeated callback changes nothing once the text has moved on' (no once claim any more); needs controller confirmation.
- claimWebhookEvent/releaseWebhookEvent left exported (still used by packages/db/test/routing.test.ts).

Verify tail: npm run typecheck (tsc -b) and npm run lint (eslint .) both clean locally; CI Platform green.
