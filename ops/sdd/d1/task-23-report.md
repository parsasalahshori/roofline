# Task 23 report: Web: Settings, Front Desk and transfer phones

Built (3 packages):
- A-front-desk-tab: FrontDeskTab.tsx/.module.css (switch with blocked reason, texts, voice select with previews, facts counter, limits validation, field-level server errors, empty forwarding slot for Task 24), d1-t23-front-desk-tab.test.tsx.
- B-on-call-list: OnCallList.tsx/.module.css (drag handle plus up/down buttons, 40px targets, transfer phone or empty text), d1-t23-on-call-list.test.tsx.
- C-transfer-phone: TransferPhone.tsx/.module.css (prefill, recording acknowledgement, E.164 validation, PUT {e164, ackRecording:true}), d1-t23-transfer-phone.test.tsx, d1-settings.test.tsx updated.
- Shared: copy/front-desk-settings.ts, settings-api.ts.

Review rounds:
- Review 1: verify failed, 2 findings; contact check approved both (F1, F2); fixed.
- Review 2: verify passed, 0 findings.

Minors: no loading-announcement copy key (skeletons use aria-busy only); Toggle has no aria-describedby so the blocked sentence is visible text only; ack box re-ticks after each successful transfer-phone save; drag handle has tabIndex -1 (buttons cover keyboard).

Verify tail: typecheck, lint, lint:css clean; vitest @roofline/web 50 files, 480 tests passed.
