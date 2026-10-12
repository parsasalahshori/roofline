
# C1 Task 24: appointment sheet with suggested times

Commit a08850f on c1-t24. CI run 38209074892: PASSED.

Built: Package A (AppointmentForm + css, appointments-form test), Package B (SuggestedTimes, ConflictWarnings, AppointmentWindow, appointments-suggest test), Package C (api.ts hooks, AppointmentDetail, copy/appointments.ts with new key close, copy/connections.ts, appointments test; c1-routes test updated).

Review 1: verify failed, 3 findings. F1 amended, F2 amended, F3 approved (fixed in the tree before this commit).
Review 2: verify passed, 0 findings.

Minors: address link uses maps.apple.com (vendor-word rule); SuggestedTimes shows a trailing '· ' for an unknown member name; useTeam also fires for reps (reply ignored); end-before-start install dates disable Save silently (no copy key); the connection stub body in the suggest test should match CalendarConnectionView.

Verify tail: web vitest 53 files / 531 tests passed; typecheck, lint, lint:css clean; build:web ok (chunk-size warning only).
