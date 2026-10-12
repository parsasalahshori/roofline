# C1 Task 25 report: Settings Prices, Schedule, Your calendar, setup row

Built (branch c1-t25, commit 9507aac):
- prices: PricesTab (owner edits, others read-only, example banner, field errors, save baseline), prices copy, settings-prices tests.
- schedule: ScheduleTab and WorkHoursEditor (company hours and numbers for owners, "Your hours" with company-hours toggle), schedule copy, settings-schedule tests.
- calendar: CalendarConnection (three states, inline disconnect confirm, ?calendar param handled once), ConnectionsTab, SetupRow connect_calendar step links to Connections for every member, connections/setup copy, calendar-connection and setup tests.
- lead: c1-routes, f3-routes and settings tests patched for removed comingSoon keys and new stubs.

Review rounds:
- Review 1: verify failed, 2 findings; contact check: F1 amend, F2 amend (both amended).
- Review 2: verify passed, 0 findings.

Minors: disconnectFailed copy key added beyond the brief; crm-api.ts hooks file added under settings.

Verify tail: web vitest 53 files, 522 tests passed; typecheck, lint, lint:css clean; build:web built in 1.59s (chunk size warning only).

CI: run 38208207835 on c1-t25@9507aac: Platform job success, v1 success; E2E (Playwright) failed (not judged by ci-check default; not investigated).
