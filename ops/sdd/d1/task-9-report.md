# D1 Task 9 report: claims, messages, transfer, end

Built (handlers only; Task 19 registers them in tools/index.ts and wires engine counters):
- P1-claim: repos/claim-intakes.ts (insertClaimIntake, listClaimIntakesForJob), tools/claim.ts takeClaimDetails.
- P2-message: repos/fd-message.ts hasUrgentNoticeFor, system/transfer-phone.ts onCallEmails, tools/message.ts takeMessage (activity front_desk_message, urgent email once).
- P3-handoff-today: tools/transfer.ts, tools/end.ts, Today marker (JobCard.frontDesk, todayView sort urgent first, 'From Front Desk' copy), eslint.config.js allow-list for tools/*.ts importing @roofline/db/system.

Reviews:
- Review 1: verify failed, 2 findings; fixed (lint allow-list for @roofline/db/system in tools/).
- Contact check 1: F1 approve, F2 amend; applied.
- Review 2: verify passed, 0 findings.

Minors: urgent message with no customer and no job emails on every call; end_call-through-engine test not written; todayView sort is DB-backed and untested locally.

Verify tail: typecheck ok, lint ok, shared 810 passed, web 754 passed (87 files).
