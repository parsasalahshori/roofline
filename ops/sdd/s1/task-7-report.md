# Task 7 report: API skeleton (seams, fakes, config, jobs, schedules, mounts)

## Built
- P1-config-deps-app: config.ts, deps.ts, app.ts, index.ts, test/helpers.ts, config/storm-config/skeleton-helper tests, README.md, .env.example. Routes mounted in brief order; STORM_MAIL_FROM derives from MAIL_FROM domain, then POLICY_PAGES_DOMAIN, then PUBLIC_BASE_URL host.
- P2-seams-fakes-geocoder: ads (Google, Meta), broadcast mailer, ad-image seams with fakes; Geocoder gained reverseMany (Geocodio, Fake, Unconfigured); storm-fakes.test.ts.
- P3-jobs-schedules-handlers: four storm job queues and schedules, handlers, worker registration, three step stubs (send_email_batch, build_routes, create_ad_campaign) beside the E1 handlers; jobs/pgboss/storm-skeleton tests.

## Reviews
- Review 1: verify failed, 1 finding (lint no-unused-vars at storm-fakes.test.ts:17, P2 file). Outcome: fixed.
- Contact check 1: F1 = amend (amended).
- Review 2: verify passed, 0 findings.

## Minors
- Mount tests only prove the four /api mounts return 401 without a session; /u, /storm/:code and /api/public/storm-requests have not-401 tests only.
- jobs.test.ts queueHandlers() helper gained no-op entries for the four storm jobs.
- /u is mounted outside /api, so auth/middleware.ts is unchanged.
- No database-backed test was run locally (no Docker); they run on CI.

## Verify tail
typecheck clean, lint clean, @roofline/shared: 28 files, 645 tests passed.
