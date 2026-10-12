
# E1 Task 5 report: API skeleton (seams, fakes, config, jobs, schedules, mounts)

Branch e1-t5, commit ae3d065 (base 2504960). 

## Built
- P1 config-deps-helpers-docs: 10 new config variables (EagleView and R2 both-or-none in superRefine, PROPOSAL_LINK_BASE_URL falls back to APP_ORIGIN, FOOTPRINTS_BASE_URL default), deps wiring with Unconfigured aerial/exact-report seams, testConfig defaults, config tests, .env.example and README rows.
- P2 seams-fakes: footprints, aerial, exact-reports, object-store seams with fakes, MS footprints / EagleView / R2 shells, NE fixture (6 closed rings), estimator-fakes test.
- P3 jobs-routes-mounts-public: JOB_NAMES/handlers/SCHEDULES appended after C1's (footprints-load, signed-pdf, footprints-ensure, exact-report-poll), estimator and route stubs, five mounts, /api/public with publicRateLimit (60/min per IP), exported isPublicRoute with /public/ prefix rule (lowercased, no decoding, Set kept), readOnlyGuard pass for /public/, updated pgboss/jobs tests, estimator-skeleton test (session route 401, /publicx 401, /%70ublic 401, 61st public request 429).

## Reviews
- Review 1: 1 finding; contact check F1 = amend (amended).
- Review 2: 0 findings.

## Minors
- eslint-disable lines on stub params must be removed when real bodies land.
- testConfig gained four defaults (outside brief, needed for typecheck).
- App-level read-only-member agent test not added (needs DB).

## Verify
- typecheck and lint: passed, no output errors.
- ci-check: PASSED, run 38197904378 (Platform job passed, includes DB suites).
