# Task 17 report: Google Ads adapter

## Built
- P1-http-index: providers/google-ads/http.ts (token cache, paging, error mapping to AD_ERROR_KINDS), index.ts (googleAdsFor wiring), test google-ads-http.test.ts, fixtures.
- P2-link-report: link.ts (manager link, invite idempotence, accountInfo), report.ts (spend report), test google-ads-link-report.test.ts, fixtures.
- P3-campaigns: campaigns.ts (PAUSED proximity campaigns, findCampaign by nameTag, setStatus), test google-ads-campaigns.test.ts, fixtures.

## Review rounds
- Review 1: verify failed, 2 findings. Contact check: F1 approved, F2 amended. Fixed in the tree.
- Review 2: verify passed, 0 findings.

## Minors
- Packages were already present in the worktree; the red test-first step was not reproduced.
- Campaign status UNKNOWN maps to paused.
- Api and root vitest configs start a database, so the new tests rely on CI locally unrunnable.

## Verify
typecheck and lint clean; vitest --project @roofline/shared: 28 files, 657 tests passed.
