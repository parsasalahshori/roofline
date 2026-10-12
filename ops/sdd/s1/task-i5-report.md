# S1 Task I5 report (follow-ups to Task 19)

Branch `s1-i5` from `origin/s1-storm` af5b5b3.

## What changed

- **(a) Landing page outlives its campaign.** New `extendStormPageUntil(tx, ctx, pageId, until)` in `packages/db/src/repos/storm-pages.ts`
  (`set active_until = greatest(active_until, until)`, tenant-scoped, returns the new value or null). `create_ad_campaign` calls it right
  after `ensureStormPage` with the campaign end date + 1 day (00:00 UTC, the same exclusive-end rule as the page). It only extends.
- **(b) No campaign without landing pages.** When `companyOriginFor` returns null (POLICY_PAGES_DOMAIN unset) the handler returns
  needs-attention with `NO_LANDING_PAGES` ("Storm landing pages are not set up yet.") before `ensureStormPage`, the claim row and any
  platform call. The `PUBLIC_BASE_URL` fallback is gone.
- **(c) Real card in the smoke.** `apps/api/src/scripts/smoke/storm.ts` renders the Meta card with `resvgCardFor(config).card(...)`;
  the 1x1 PNG constant is removed. `docs/superpowers/s1-manual-smoke.md` updated. The smoke guards test did not reference the constant.
  The smoke script was not run.
- **(d) Ad error copy.** A single source is not possible: the sentences name Google, the copy rules allow vendor names only in the web copy
  files (auth, billing, connections, legal, setup), and the API cannot import apps/web. `AD_ERROR_COPY` stays in the API with a comment
  saying why and that it must stay in sync with `adErrorCopy` in `apps/web/src/copy/connections.ts`.

## Grants

None. `app_tenant` already has SELECT, INSERT, UPDATE on `storm_pages` (0018 section 5). 0018 is not amended; `drizzle-kit generate`
in packages/db reports no changes.

## Tests (db/api suites run in CI only, no Docker here)

- `packages/db/test/storm-pages.test.ts`: `extendStormPageUntil` extends, never shortens, is tenant-scoped.
- `apps/api/test/ad-campaign.test.ts`: a 30-day campaign (end 2026-11-10, past convective day + 30 = 11-10) leaves `active_until` = 2026-11-11, a later 3-day campaign does
  not shorten it; with POLICY_PAGES_DOMAIN unset the step is needs-attention with that reason, neither fake recorded a call, no campaign row.
  The landing URL helper no longer falls back to PUBLIC_BASE_URL.
- Local: typecheck, lint, `vitest --project @roofline/web` (888) pass.
