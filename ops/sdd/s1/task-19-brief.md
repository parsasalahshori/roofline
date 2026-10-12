### Task 19: `create_ad_campaign` handler, creative card, spend sync

**Base:** `s1-storm` after Tasks 16, 17 and 18 are merged. **[E1]** `ObjectStore` (R2) and `storeFile` (E1 T13) for the ad image; `stored_files`. Real (F3): spend approval guard in `tasks/service.ts`.

Read first: `ops/sdd/s1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-storm-scout-design.md`. Names marked **[C1]** / **[E1]** come from the C1/E1 plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`), not from built code: check each against `c1-crm`/`e1-estimator` before starting and report any difference.

**Split:** Builder 1 `repos/storm-geo.ts` (`coverCircles(tx, companyStormId, minRadiusM, maxCircles)`: threshold area in EPSG:5070, `ST_HexagonGrid(spacing)` keeping hexes that intersect, radius doubling until ≤ max; returns lat/lng circles) + `storm/creative.ts` and `providers/resvg-card.ts` (SVG template with the company name and S1 colours → PNG; stored in R2 as `ad_image`); Builder 2 `storm/ad-campaign.ts` (handler: re-check approval and account active; claim `ad_campaigns` row `creating`; `findCampaign` by name tag first; create paused; Meta targeting error → one housing retry with `housing_fallback = true`; enable; status `active`); Builder 3 `storm/ad-sync.ts` + `system/ad-sync-fanout.ts` + `jobs/scheduler/ad-spend-sync.ts` (hourly stats; ≥ 95% of `max_spend_cents` → pause, retried every run until the platform says paused; past end date → `ended`; landing requests counted from `storm_requests`).

**Files:** Fill the listed files; Modify `apps/api/src/tasks/handlers.ts` (swap the stub); Test `apps/api/test/{ad-campaign,ad-sync,storm-geo}.test.ts`.
- **Result** shown in the step: `{ campaignId, circles, dailyBudgetCents, days, housingFallback }`; errors as `{ kind }` → plain text in copy (`ads.ts`): policy "Google didn't approve the ad. Edit the words and try again.", payment "The ad account has a payment problem. Fix it in Google Ads.", access "Roofline can't reach this ad account anymore. Reconnect it in Settings → Connections."

**Tests:**
- circles ≤ 50 and covering the fixture area (union of circles contains ≥ 99% of the area); Google 1 km and Meta 1 mile minimums; budget × days ≤ max; retry after an uncertain create finds the campaign instead of creating a second; housing fallback; 95% pause and its retry; the handler refuses when the account is revoked; a spend step approved by office without delegation never reaches the handler (F1 guard — asserted).

**Carries and rulings:**
- Swap only this task's stub in `tasks/handlers.ts`; budget × days ≤ the approved max (Review Focus 1).

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): create storm ad campaigns on approval and pause them at the approved maximum`
