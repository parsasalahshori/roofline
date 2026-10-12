# D1 Task 26 report: Front Desk web (timelines, Today, appointments, dock badge)

## Built
- A: FrontDeskCard (Ruling DG) in Timeline for 'call'/'text_conversation' activities; 'Booked by Front Desk' row in AppointmentDetail.
- B: lib/phone.ts formatPhone (ConversationRow, OnCallList), 'Unknown caller', useWeekStats 30 s refetch, real useFrontDeskUnread (Ruling DH, 30 s poll); SHELL_ROUTES gets the needs_attention route.
- C: ConversationView formatted phone and per-turn removed-text choice, RecordingPlayer clears expired URL on error, narrowed invalidations (invalidateInbox), copy/front-desk.ts removed, Settings tab nowrap.

## Reviews
- Review 1: 1 finding, approved and fixed (verify failed before fix).
- Review 2: 1 finding, amended.
- Review 3: 0 findings.

## Findings for other tasks
1. TimelineItem has no `data` field: the Front Desk card shows only once the API exposes it.
2. AppointmentView lacks confirmedAt/confirmedVia (Task 8); no confirmed mark rendered.
3. TodayView.followUps has no Front Desk marker; Today unchanged.
4. TurnView lacks callId; per-turn call choice limited to single-call turns.

## Verify
typecheck, lint, lint:css clean; web vitest 86 files / 751 tests passed.
