
# Task I3 report: ad-account integration fixes

## Built
- google-unlink (apps/api/src/providers/google-ads/link.ts, index.ts, http.ts, ads-google.ts, deps.ts, fixtures, google-ads-link-report.test.ts): `unlink(customerId)` searches the client link; ACTIVE -> INACTIVE, PENDING -> CANCELED via customerClientLinks:mutate with updateMask status; no link is a no-op; missing id throws AdPlatformError('other'). `AdsGoogle.unlink` is now required (UnconfiguredAdsGoogle has it). index.ts and http.ts converted to single quotes (quote-only diff in http.ts).
- meta-outage (meta/link.ts, meta/http.ts, meta-ads-link.test.ts, meta-ads-http.test.ts): `isAccessProblem` (code 100 + subcode 33, code 10, codes 200-299); only those map to not_shared / not_assigned, everything else is rethrown. Graph code and subcode are carried on the error.
- storm-ad-accounts (storm/ad-accounts.ts, ad-accounts.test.ts, ads-routes.test.ts): revokeAdAccount calls `unlink(...)` (failure reported with the row id only, row still revoked); checkAdAccount re-invites on 'none' or 'refused'. Tests added for both and for the failing-unlink report.

## Reviews
- Review 1: verify failed, 1 finding. Fixed by the builders (the missing unlink on UnconfiguredAdsGoogle in deps.ts, also the typecheck blocker noted by builder 3).
- Contact check 1: F1 approve.
- Review 2: verify passed, 0 findings.

## Minors
- Biome is not installed; style conversion done with the TypeScript scanner.
- Database-backed tests run only on CI.

## Verify
typecheck and lint clean; `vitest --project @roofline/shared`: 28 files, 659 tests passed.
