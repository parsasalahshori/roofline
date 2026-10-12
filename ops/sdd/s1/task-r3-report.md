# S1 Task R3 report: ad spend safety

Branch `s1-r3`, built on `s1-i5` (c3c6fe0). API and db only; the fakes are the only ad platforms the tests touch.

## What changed, per item

1. **Lost enable.**
   - `storm/ad-campaign.ts`: the handler tracks whether the external id is stored (`storedId`, also set from a row a
     retry adopts). In the catch it calls `setStatus(paused)` best effort (failure goes to `reportJobError`, never
     shown), for platform errors and for any other throw (which is then rethrown). `fail()` and the final `active`
     write also set `paused_by = null`.
   - `storm/ad-sync.ts` + `repos/ad-campaign-sync.ts`: the hourly list now also holds rows with status `failed`, or
     `creating` and quiet for over an hour (`CREATING_SWEEP_AFTER_MS`), that have an external id and are not
     `paused_by = 'roofline'`. For these the sync reads stats; if the platform says active it pauses and re-reads;
     once the platform reports it off (paused/ended/removed) it sets `paused_by = 'roofline'` and leaves the status
     alone. It never re-enables.
   - `system/ad-sync-fanout.ts`: `companiesNeedingAdSync` and `companiesWithLiveCampaigns` use the same row rule
     (taking an optional `now`); the scheduler passes `deps.clock.now()`.
   - Fakes: `loseResponseOnNextSetStatus(kind)` on `FakeAdsGoogle` and `FakeAdsMeta` (the enable applies, then throws).
2. **Failed Check.** `checkAdAccount` keeps the previous status, name and currency and updates only `lastErrorPlain`
   when the evaluation is `fromThrow` or the Google branch caught a throw (that catch now sets `fromThrow`).
   `updateAdAccount` accepts a patch without `status`. `syncOne` proceeds for any account that exists and is not
   `revoked`. Definite answers (refused, disabled, not configured) still set `error`.
3. **Meta.** The ad set and the ad are created `ACTIVE`; the campaign stays `PAUSED` and is the one switch.
   Fixture test asserts the three request bodies.
4. **Who paused it.** New nullable `ad_campaigns.paused_by` (`roofline` | `platform`).
   - 95% pause: `paused` + `roofline`. Platform pause below the line: `paused` + `platform`. A paused row the
     platform reports active again goes back to `active`, `paused_by` null. Still pauses at 95% and ends after the
     end date.
   - The list: `active`, plus `paused` rows whose `paused_by` is distinct from `roofline` (null counts as not ours),
     plus the sweep rows. `recordCampaignSync` now guards on `expectStatus` (the status the list read).
   - Sync stops only on our own 95% pause, `ended`, or a swept row confirmed off.
5. **USD only.** `create_ad_campaign` returns `needs_attention` with `NOT_USD` ("This ad account doesn't bill in US
   dollars. Roofline can only run ads on a US dollar account.") unless `account.currency === 'USD'`, before the claim
   and any platform call. The text names no platform, so it is outside the web copy rules. Fixtures
   (`ad-campaign.test.ts`, `ad-sync.test.ts`) now insert accounts with currency `USD`.

## Migration, grants, schema

- `0018_storm_grants_rls.sql` amended in place (Ruling AW): section 6b adds `ALTER TABLE ad_campaigns ADD COLUMN
  paused_by text` and `ad_campaigns_paused_by_check`. The app_system grant on `ad_campaigns` is now
  `SELECT (id, company_id, status, external_campaign_id, platform, paused_by, updated_at)`: `paused_by` and
  `updated_at` are new, because the fan-out reads them. Ids, status and timing only, never content.
- `meta/0018_snapshot.json`: the column and the check constraint added (10 lines). Drizzle schema
  (`schema/tenant.ts`, `AD_PAUSED_BY` in `packages/shared/src/storm.ts`, re-exported in `schema/enums.ts`).
- `drizzle-kit generate` in `packages/db`: "No schema changes, nothing to migrate", no files created.
- `packages/db/test/rls.test.ts` grant list updated (paused_by, updated_at).

## Tests

- `apps/api/test/ad-campaign.test.ts`: lost enable (google and meta: fake applies the enable then throws; row
  `failed`, fake shows `paused`, calls are `active` then `paused`), non-AdPlatformError throw with a failing pause
  (logged, rethrown, row stays `creating`), no pause when no id is stored, USD refusal (null and EUR).
- `apps/api/test/ad-sync.test.ts`: sweep of a failed row the fake reports active (paused, status kept, then not
  read again), failed row already paused, retry after a failed pause, creating row fresh vs two hours old, no id,
  failed-Check account still pauses at 95% (error, pending), paused(platform) read again and reactivated, null
  paused_by, paused(platform) at 95%, paused(platform) after the end date, roofline-paused and ended rows not read,
  the status guard on the write, fan-out for every row kind.
- `apps/api/test/ad-accounts.test.ts`: a throwing Check keeps an active Google account active and a pending Meta
  account pending; a definite answer still changes the status.
- `apps/api/test/meta-ads-campaigns.test.ts`: campaign PAUSED, ad set and ad ACTIVE.
- Local: typecheck and lint clean; the shared suite passes. The api and db suites need Docker, which this box lacks,
  so they ran on CI only.

## CI

First run (38246228940) failed on three tests that asserted the old behaviour: the Meta body fixtures
(`fixtures/meta/body-ad.json`, `body-adset.json`, `body-adset-housing.json` now say ACTIVE) and
`ads-routes.test.ts` (a thrown Check now keeps the status). Fixed in 2e38104.

Green run: **38248652411** on 2e38104 (Platform, E2E, Hail and v1 all success). The ci-check script itself timed out
while waiting, so the run was watched through the Actions API.
