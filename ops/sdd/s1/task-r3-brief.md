### Task R3 (whole-branch review): ad spend safety

**Base:** `s1-storm`, after I5 merges if possible. These files overlap I5's `storm/ad-campaign.ts`, so build on top of s1-i5 or merge it in. API and db only. Never call Google or Meta for real.

**Fixes (confirmed by the S1 review):**
1. **(important) A lost enable response leaves a campaign live with no 95% guard.**
   - `ad-campaign.ts:267-280`: when `setStatus(..., 'active')` throws after the campaign id is stored, `fail('other')` marks the row failed, and the sync (`listActiveCampaigns`, `repos/ad-campaign-sync.ts:130`) never reads it again. Google may have applied the enable.
   - Fix part 1: in the catch, when `externalCampaignId` is stored, best-effort `setStatus(..., 'paused')` before marking the row failed.
   - Fix part 2: the hourly sync (or the fan-out in `system/ad-sync-fanout.ts`) also covers `failed`/`creating` rows that have an `external_campaign_id`. Read their stats and pause any the platform reports as active.
   - Test: the fake's enable succeeds and then throws.
2. **(important) One temporary error on Check turns off the 95% guard.**
   - `checkAdAccount` (`ad-accounts.ts:187-201`) saves `status: 'error'` on a thrown or temporary error, and `syncOne` (`ad-sync.ts:67-68`) skips every campaign of a non-active account.
   - Fix part 1: on `fromThrow` or a caught throw, keep the previous status and only update `lastErrorPlain`.
   - Fix part 2: the sync still pauses at or past 95% for any account that is not `revoked`.
   - Tests.
3. **(important) Meta ads never deliver.** `providers/meta/campaigns.ts:139,173,76` creates the ad set and the ad as `PAUSED`, but `setStatus` only flips the campaign.
   - Fix: create the ad set and the ad as `ACTIVE`, and keep the campaign `PAUSED` as the one switch. The campaign-level pause still stops everything.
   - Add a fixture assertion.
4. **(minor) A brief platform "paused" ends the guard.**
   - Meta `IN_PROCESS`/`WITH_ISSUES`, and an owner resuming a campaign in the platform's own interface, mean the sync's `paused` row is never read again.
   - Fix: keep syncing rows that Roofline did not pause itself; record who paused it (e.g. `pausedBy` in an existing column or the result), and stop syncing only on our own 95% pause or `ended`.
   - If this needs a column, use Ruling AW: S1's 0018 in place plus `0018_snapshot.json`, with drizzle-kit reporting no changes.
5. **(minor) A non-USD account gets the wrong budget.** `create_ad_campaign` refuses with needs_attention and a plain reason unless `account.currency === 'USD'` (the budget is USD cents).

**Verify:** typecheck, lint, shared tests; ci-check with `CI_JOBS="Platform E2E Hail"`.
**Commit:** `fix(api): ads stay guarded after a lost enable or a failed check; Meta ad sets deliver; USD only`
