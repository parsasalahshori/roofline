### Task I3: Ad-account integration fixes (from the contact-218 group check)

**Base:** `s1-storm` with T16 (ad accounts), T17 (Google Ads adapter) and T18 (Meta adapter) merged. API only. Never call Google or Meta for real: injected fetch with fixtures, as T17/T18 do.

**Files:** `apps/api/src/providers/google-ads/{link,index}.ts`, `apps/api/src/providers/ads-google.ts`, `apps/api/src/providers/fakes/ads-google.ts`, `apps/api/src/providers/meta/link.ts`, `apps/api/src/storm/ad-accounts.ts`, and their tests and fixtures (`apps/api/test/google-ads-link-report.test.ts`, `apps/api/test/fixtures/google-ads/*`, `apps/api/test/meta-ads*.test.ts`, `apps/api/test/fixtures/meta/*`, `apps/api/test/ad-accounts.test.ts`).

**Fixes:**
1. **(important) Revoking a Google account ends our manager link.** Today `revokeAdAccount` calls `deps.adsGoogle.unlink?.()`, and the real adapter has no `unlink`. A removed account therefore keeps Roofline's manager access.
   - Add `unlink(customerId)` to `createLink` in `google-ads/link.ts`:
     - search `customer_client_link.manager_link_id, customer_client_link.status` where `customer_client_link.client_customer = 'customers/<id>'`;
     - for an ACTIVE link, send POST `customers/<manager>/customerClientLinks:mutate` with `{ operation: { update: { resourceName: 'customers/<manager>/customerClientLinks/<client>~<managerLinkId>', status: 'INACTIVE' }, updateMask: 'status' } }`;
     - for a PENDING link, send the same with status `CANCELED`;
     - if no link exists, do nothing.
   - Wire it in `googleAdsFor` and make `unlink` required in `AdsGoogle`. The fake records it, and an unlinked fake account goes back to `none`.
   - Drop the `?.` in `revokeAdAccount`. Revoke still marks the row `revoked` when unlink throws (the owner asked to remove it). Report the failure through `reportJobError` or an audit line; no provider text.
   - Tests: an active link is set INACTIVE, a pending link is CANCELED, no link means no call, and revoking through the route calls unlink on the fake.
2. **(important) Meta access errors versus outages.** `meta/link.ts` `verifyAccess` turns every `AdPlatformError` from the account GET into `not_shared`, and every one from the assigned_users POST into `not_assigned`. That includes rate limits, network failures and our own expired system-user token.
   - Only permission or unknown-object Graph errors map to `not_shared`/`not_assigned`: code 100 with subcode 33, code 10, codes 200–299. Rethrow everything else, so T16's `evaluateAdAccount` sees a throw (`fromThrow: true`) and the hourly recheck handles it as transient.
   - Tests: a rate-limit error (code 4 or 17) is thrown, not returned as `not_shared`; an expired token (code 190) is thrown as `access`.
3. **(minor) Re-invite after a refusal.** `checkAdAccount` re-invites when `linkStatus` is `'none'` or `'refused'` (T17's `invite()` already creates a fresh link in both states). Test it with the fake's link set to refused.
4. **(minor) Style.** Reformat `google-ads/index.ts` and `http.ts` to the repo's single quotes (no behaviour change).

**Verify:** typecheck, lint, `npx vitest run --project @roofline/shared`; ci-check with `CI_JOBS="Platform E2E Hail"` (the api tests run on CI).
**Commit:** `fix(api): revoking a Google account ends the manager link; Meta outages are not "not shared"; re-invite after a refusal`
