# F3 Task 17 report: hosted privacy and terms pages

Built (commit ee427d2 on f3-t17):
- P1-policy-text: apps/api/src/public/policy-text.ts (privacy, terms, not-found HTML; all company values escaped; template version draft-2026-10).
- P2-routes-urls-db: apps/api/src/public/policies.ts (company-host and /policies/:slug routes), policy-urls.ts, packages/db/src/system/policy.ts (companyForPolicyPage).
- P3-tests: apps/api/test/policy-pages.test.ts (seven tests per the brief).

Review round 1: verify passed, 1 finding; contact check F1 = amend (amended).
Review round 2: verify passed, 0 findings.
Minors: hosts with more than one label before POLICY_PAGES_DOMAIN fall through to next() per brief.

Verify: npm run typecheck and npm run lint both clean. CI via ci-check: run 38184779095 PASSED (Platform job passed). api/db tests ran only in CI.
