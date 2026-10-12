# C1 Task 23: calendar views (branch c1-t23)

## Built
- A-week-day: TimeGrid, WeekView, DayView (+ CSS modules). Wall-clock positioning clamped 06:00-21:00, lanes, busy blocks behind appointments, now line.
- B-agenda-toolbar-window: AgendaView, PeoplePicker, CalendarToolbar, CalendarWindow (+ CSS modules).
- C-time-api-copy-tests: time.ts, api.ts, copy/calendar.ts, test/calendar.test.tsx. Also c1-routes.test.tsx and shell.test.tsx updated (calendar placeholder replaced by the real window).

## Reviews
- Round 1: verify failed, 8 findings. Contact check: F1, F2, F3, F5, F6, F7, F8 amended; F4 approved. All addressed in the tree.
- Round 2: verify passed, 0 findings.

## Minors / open notes
- Empty people selection sends no userIds (server may treat as everyone).
- Brief says 2026-11-01T06:00Z is 01:00 CST outside the window; it is 01:00 CDT inside the day. Not asserted.
- Range label passes the inclusive last day.
- copy key comingSoon remains in copy/calendar.ts (unused by window).

## Verify tail
Web vitest 44 files / 456 tests passed; typecheck, lint, lint:css clean; build:web built in 1.94s (chunk-size warning only).
