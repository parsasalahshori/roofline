
# Task 9: C1 Schedule settings and availability

Built
- P1-repo (packages/db/src/repos/schedules.ts): scheduleSettings, saveScheduleSettings, memberHours, saveMemberHours, busyFor, bookableMembers.
- P2-routes (apps/api/src/routes/calendar.ts): GET/PUT /settings, GET/PUT /my-hours, PUT /hours/:userId, GET /availability.
- P3-tests (apps/api/test/schedule-settings.test.ts, availability.test.ts): CI-only, no local DB.

Review 1: verify passed, 0 findings.

Minors
- saveMemberHours does not check company membership; the route checks via bookableMembers (active members only, so a disabled member gets 404).
- Extra audit rows 'calendar.hours' beyond the brief.
- Non-UUID propertyId returns 400 (unspecified in the brief).
- DB-backed tests were not run locally (no Docker); they run in CI.

Verify: npm run typecheck (tsc -b) and npm run lint (eslint .) both clean.
