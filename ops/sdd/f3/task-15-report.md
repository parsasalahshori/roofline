# F3 Task 15: sign-up with company details

Commit aaa7d14 on f3-t15. CI: run 38183854104 PASSED (includes database suites).

## Built
- p1-location-lib: apps/api/src/company/location.ts (locateAddress -> located / not_found / unavailable; default radius 40); packages/db/src/repos/company-location.ts (setCompanyLocation, setServiceAreaRadius, companyLocationFacts).
- p2-signup-auth: companyPhone/companyAddress on password, email and Google sign-up; geocode before account creation (not_found -> 400 on companyAddress); public GET /auth/config; SIGNUP_COMPANY in test helpers; auth tests updated.
- p3-company-endpoints-tests: POST /company/locate, PUT /company/service-area, located/serviceAreaMiles in the company profile; signup-company, company-location, auth-config tests.

## Review rounds
- Round 1: verify passed, 0 findings.

## Minors
- setCompanyLocation SET object is Record<string, unknown>, so column names are not compile-checked.
- GET /api/auth/config sits under the app-wide per-IP apiRateLimit.

## Verify tail
typecheck (tsc -b) clean; eslint . clean; ci-check PASSED (run 38183854104).
