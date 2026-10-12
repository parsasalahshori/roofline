
# Task 18: Web Settings (templates, financing, estimates)

Commit 3bdbcda on e1-t18 (base fcaced6).

## Built
- P1-tiers: TiersSection (Good/Better/Best editor, owner edits, office read-only, TierTemplateSchema client validation, server error mapping), TiersSection.module.css, copy/tiersEditor.ts.
- P2-financing-estimate: FinancingSection (APR bps + term pair), EstimateSection (pitch, overhang, valid days, change clause, aerial toggle only when configured), FinanceEstimate.module.css, copy/financeEstimate.ts.
- P3-setup-row-tests: SetupRow prices_and_tiers case, copy/setup.ts setPrices, settings-estimator.test.tsx (11 tests), e1-routes.test.tsx updated.
- Lead: estimator-api.ts hooks (T8 not built; shapes assumed), copy/tiers.ts, c1-routes.test.tsx tweak.

## Reviews
- Review 1: verify failed, 2 findings; fixed.
- Contact check 1: F1 approve, F2 amend.
- Review 2: verify passed, 0 findings.

## Assumptions / minors
- Server validation field names (good.x, templates.N.x) are guessed; mismatches show as a banner.
- GET/PUT response shape {templates} assumed for T8.

## Verify tail
web vitest: 46 files, 454 tests passed; typecheck, lint, lint:css clean; build:web built in 965ms.
