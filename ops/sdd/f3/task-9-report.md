
# F3 Task 9 report: API skeleton

Commits: 80083cc (skeleton), b70976f (pgboss test fix). Branch f3-t9.

## Built
- B1-config-deps-entry: config keys (Stripe, plans file, Geocodio, Twilio, policy domain, FAKE_PROVIDERS) with superRefine rules; buildDeps wiring of geocoder/billing/registrar/sms/jobs; server.ts ensureJobQueues; worker entry passes PgBossJobs; index.ts exports; test helpers; config tests; .env.example and README.
- B2-providers-fakes: geocoder/billing/registrar/sms seams, fakes, real adapter shells (geocodio, stripe, twilio sms/accounts/brands), fakes.test.ts.
- B3-jobs-routes-mounts: job queue/handlers/worker, five scheduler stubs, app.ts mounts, billing/account/imports/hooks/public stubs, eslint boundary updates, jobs and boundaries tests (queue tests appended to the existing DB-backed jobs.test.ts).

## Review rounds
- Review 1: verify passed, 0 findings.
- CI round 1: apps/api/test/pgboss.test.ts schedule expectation was stale (3 schedules vs 8 now). Fixed: list and SCHEDULES order updated.

## Minors
- Worker entry does not call ensureJobQueues itself; startWorker does (per brief).
- InlineJobs drops a send only when same singletonKey is waiting.
- Queue tests share jobs.test.ts top-level DB beforeEach.

## Verify
typecheck and lint clean. ci-check run 38182758466 PASSED (first run 38182038441 failed on pgboss.test.ts only).
