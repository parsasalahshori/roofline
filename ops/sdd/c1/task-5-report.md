
# C1 Task 5 report: API skeleton (calendar seam, config, queues, mounts)

Branch c1-t5, commits 6e59f6d (skeleton) and 59afe96 (pgboss schedule test fix).

## Built
- B1-config-deps-helpers: Google secret and Microsoft id/secret config keys with superRefine pairing, deps.calendars, AppDeps type, index exports, test helpers, env example, README.
- B2-calendar-fake: deterministic in-memory FakeCalendarApi plus tests.
- B3-stubs-mounts-jobs: route stubs and mounts, calendar push/pull stubs, queues, handlers, calendar-pull schedule (every 5 min), appointments/quotes repo additions.

## Reviews
- Review 1: verify failed, 2 findings (unused _config in adapter stubs, fake shell body): fixed.
- Contact check 1: F1 and F2 approved.
- Review 2: verify passed, 0 findings.

## CI
- Run 38193937556 (6e59f6d): 1 failure, apps/api/test/pgboss.test.ts schedule list lacked calendar-pull. Fixed in 59afe96 (appended to both assertions).
- Run 38195221714 (59afe96), attempts 1 and 2: all three jobs fail within 2 seconds with no logs (HTTP 404 on logs, no steps run). This looks like a GitHub Actions infrastructure or account problem, not a code failure. Not resolved.

## Verify
Local `npm run typecheck` and `npm run lint` passed (clean output).
