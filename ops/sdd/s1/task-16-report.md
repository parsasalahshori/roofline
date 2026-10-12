# Task 16 report: Ad accounts, linking Google and Meta

## Built
- P1 (db, shared): repos/ad-accounts.ts (7 functions, no DELETE), system/ad-sync-fanout.ts (companiesWithPendingAdAccounts), migration 0018 amended in place (SELECT (company_id, status) on ad_accounts to app_system plus app_system_all policy), rls.test.ts updated, ad-sync-fanout.test.ts, SetupFacts.ads and connect_ads item (shared + db repo + tests).
- P2 (api): storm/ad-accounts.ts service (connect Google/Meta, check, revoke, list; failures mapped to AD_ERROR_KINDS and our own messages), routes/ads.ts (GET open to members, writes company_admin), tests ad-accounts and ads-routes.
- P3 (api): storm/ad-recheck.ts (recheckPendingAdAccounts, provider calls outside transactions, per-account error isolation), storm/ad-sync.ts calls it (T19 adds campaign sync beside it), scheduler ad-spend-sync fans out 'ad-sync-company' per company, tests.

## Reviews
- Review 1: 2 findings (F1, F2), both amended after contact check. Includes optional AdsGoogle.unlink seam (providers/ads-google.ts, fake).
- Review 2: 2 findings (R2-1, R2-2), both amended.
- Review 3: 0 findings.

## Minors / deviations
- SetupFacts in this base lacks calendarsConnected and pricesAndTiersSaved (C1/E1 not merged); not added.
- drizzle-kit "no changes" and all DB-backed tests are unverified locally (no Docker); CI is the check.

## Verify (local)
typecheck clean, lint clean, vitest @roofline/shared: 28 files, 659 tests passed.

## Carries

- T17: implement AdsGoogle.unlink(customerId) in the real Google adapter (end the CustomerClientLink of our manager account). revokeAdAccount (apps/api/src/storm/ad-accounts.ts) calls deps.adsGoogle.unlink?.(); while it is missing, revoking a Google account leaves the manager link in place. Once T17 lands, make the member required.
