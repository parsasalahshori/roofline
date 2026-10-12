# Task 19 report: create_ad_campaign handler, creative card, spend sync

## What was built
- A-geo-creative (packages/db storm-geo.ts; apps/api creative.ts, resvg-card.ts): hexagon-cover circles from the storm contour at the company hail threshold, swath centre, resolveAdImage (photo bytes or sha256-deduplicated resvg card, object put outside any transaction), pure cardSvg.
- B-handler (apps/api ad-campaign.ts, handlers.ts, copy/storm.ts + connections.ts, repos/ad-campaigns.ts): create_ad_campaign handler with approval re-check (spend class, approver can approve_spend), ad account active check, name-tag search before create, budget daily x days <= approved max with end date, one Meta housing retry, landing page lookup/insert. Step result is numbers only (Ruling AY).
- C-sync (apps/api ad-sync.ts, scheduler/ad-spend-sync.ts; packages/db ad-campaign-sync.ts, ad-sync-fanout.ts): spend sync beside the recheck, 95% pause retried every run until the platform says paused, end-date pause, fan-out via companiesNeedingAdSync.
- No migration, grant or package.json change; drizzle-kit generate unaffected.

## Review rounds
- Review 1: 2 findings; contact check: F1 amend, F2 amend (both amended).
- Review 2: 0 findings.

## Minors
- adErrorCopy lives in copy/connections.ts (vendor names rejected in storm.ts) and is re-exported from storm.ts; API keeps a duplicate AD_ERROR_COPY.
- ST_HexagonGrid size assumed to be the hexagon side; check storm-geo coverage test (c) on CI first if it fails.
- Local api/db tests cannot run (no Docker); CI covers them.

## Verify output tail
typecheck: ok; lint: ok; vitest --project @roofline/web: 83 files, 790 tests passed.
