# D1 Task 7 report: Tools caller, jobs, forecast, hail

Built:
- P1-caller: packages/db/src/repos/fd-caller.ts (phone match, name+street verification, Ruling DZ stubs hailHitsForProperties / proposalStatusForJob), tools/caller.ts, tools-caller.test.ts.
- P2-jobs-hail: tools/jobs.ts (lookupMyJobs), tools/hail.ts (hailAtMyHome, says plainly when no hail record exists; no damage claims), tools-jobs.test.ts.
- P3-forecast-weather-views: WeatherSource.daily (Null, NWS, fake), tools/forecast.ts, TurnView.callId (shared, inbox repo, web ConversationView), tests.

Review round 1: 1 finding, fixed (weather.test.ts inline WeatherSource literals gained `daily: async () => null`).
Contact check: approved. Review round 2: 0 findings.

Minors: stage-word wording in jobs.ts is the builder's own mapping; the stubs are wrapped in eslint-disable for no-unused-vars.

Verify: typecheck and lint clean; @roofline/shared 810 tests passed; web d1-t22/d1-t26 13 passed. DB-backed suites run on CI (commit b3837b3, run 38267058627).
