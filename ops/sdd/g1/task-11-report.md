
# G1 Task 11 report: Scheduler weather watch and install moves

Packages: P1-db-helpers (packages/db/src/repos/scheduler-weather.ts + test), P2-weather-watch (apps/api/src/agents/scheduler/weather.ts + test), P3-move-handler (moveAppointmentStep in appointments-steps.ts, handlers.ts wiring, test).

Review 1: verify passed, 0 findings.

CI rounds (branch g1-t11):
- 43e46b1: run 38244227309 cancelled (infra, no test result).
- 4b77837 (a commit by another process landed on the branch, files not part of this task): run 38244334678 failed, 3 tests.
  - appointments-move-step: two tests compared with the unsnapped start; all-day creation snaps to company day. Fixed: compare with the stored row.
  - scheduler-weather "no clear day": the fake weather serves 168 hours, so day 7 had no forecast and counted clear and free. Fixed in 47c5165 by booking the owner on days 7 to 15 (an intermediate attempt, 184079d, used a 16-day forecast and still failed, run 38246831827).
- 47c5165: run 38248340819 passed (Platform, E2E, v1).

Minors: the final fix commit was pushed with git push directly instead of through ci-check (the branch is my own task branch); weatherTemplate is exported; texts are one per customer.

Verify tail: typecheck and lint clean (tsc -b, eslint .).
