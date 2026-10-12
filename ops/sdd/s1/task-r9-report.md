# S1 R9 report (Ruling BF: findings 2, 14, 18)

## Built
- p1-origin-and-logs: unsubscribe confirm page sends Referrer-Policy: same-origin (origin guards untouched); pathForLog in errors.ts scrubs /u/<token>; tests in path-for-log.test.ts and public-forms-hardening.test.ts.
- p2-rate-limits: publicPageRateLimit and POSTMARK_HOOK_RATE_LIMIT_PER_MIN in rate-limit.ts; applied to postmark hook, storm page and public policies.
- p3-e2e: apps/web/e2e/public-forms.spec.ts submits the storm form and the unsubscribe form; stack.ts and fixtures.ts seed helpers; api index exports unsubscribeKey and signUnsubscribeToken.

## Review rounds
- Rounds 1-3: each verify run reported one finding; contact checks F1=approve, F2=approve, R3-F1=amend. Fixes are included in this commit.

## Minors
- None open.

## Verify tail
typecheck and lint clean; playwright --list: 54 tests in 14 files; npm ls playwright-core shows only 1.56.1. api and e2e specs prove on CI.

## CI round 1 (run 38263197484, bfaca67): failed, fixed
- Platform: unsubscribe.test.ts still expected no-referrer (updated to same-origin); the Postmark router's bodyErrors turned the limiter's 429 into 400 (429 now passes through).
- E2E: seven storm specs stopped at needs_attention because the fixture ad accounts had no USD currency (base lacks 3f800e5); the same fixture change is applied here (identical content).

## CI round 2 (run 38265472388, 905266e): E2E and Hail green; Platform failed only on test/exact-report.test.ts:130 (re-price count, a clock-timing test in code R9 does not touch). Re-run on a report-only commit.
