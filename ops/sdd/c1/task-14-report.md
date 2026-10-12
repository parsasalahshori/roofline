# C1 Task 14: Calendar pull schedule (branch c1-t14)

## Built
- B1-pull: apps/api/src/calendar/pull.ts (pullConnection; provider calls outside transactions, one tenant transaction per page, cursor saved last; CalendarAuthError marks the connection, other errors never mark).
- B2-db-scheduler-route: packages/db/src/repos/calendar-busy.ts, packages/db/src/system/calendar-sync.ts, apps/api/src/jobs/scheduler/calendar-pull.ts, apps/api/src/routes/calendar-connect.ts (POST /sync pulls inline, 202 within 30 s without pulling).
- B3-tests: apps/api/test/calendar-pull.test.ts (11 tests).

## Reviews
- Review 1: 1 finding, approved and fixed.
- Review 2: 1 finding, amended.
- Review 3: 0 findings.
- CI round 1 (run 38202638486, commit 2cc7bda): 2 test failures (outside events landed on a fake account other than the connection's). Fixed in the tests by calling fake.refresh('refresh-abc') before addOutsideEvent. The E2E (Playwright) job also failed in that run; log not retrievable (403) and this task changes no web code, so treated as unrelated to this task.

## Minors
- moved/canceled count only when the repo call returns non-null; link deleted on cancel regardless; fullResync always calls replaceBusyBlocks.

## Verify tail
- typecheck + lint: passed (local).
- ci-check run 38203587206 at 85b5373: PASSED (Platform job passed).
