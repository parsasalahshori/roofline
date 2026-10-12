# Task 18 report: Meta Marketing adapter

## Built
- P1-http: providers/meta/http.ts (appsecret_proof, GET/POST/FormData helpers, error mapping to AD_ERROR_KINDS, no provider text kept), test meta-ads-http.test.ts, error-*.json fixtures.
- P2-link-report: providers/meta/link.ts, report.ts (business access link, insights, campaign status), test meta-ads-link.test.ts, fixtures.
- P3-campaigns-index: providers/meta/campaigns.ts (PAUSED campaigns, nameTag lookup, housing category -> AdPlatformError targeting), index.ts (metaAdsFor), test meta-ads-campaigns.test.ts, fixtures.

## Review rounds
- Review 1: 2 findings. Contact check: F1 approve, F2 amend. Outcome recorded by lead.
- Review 2: 0 findings.

## Minors
- Builders found files pre-implemented; no red-first run observed.
- mapMetaError text check 'rejected' precedes payment, so a payment message containing 'rejected' maps to policy.

## Verify tail
typecheck and lint clean; vitest --project @roofline/shared: 28 files, 657 tests passed. API tests need Docker, so run in CI.
