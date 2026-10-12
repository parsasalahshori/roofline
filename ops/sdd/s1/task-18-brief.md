### Task 18: Meta Marketing adapter

**Base:** `s1-storm` after Task 7 is merged. From T7: `AdsMeta`, `MetaCreate`, stub `providers/meta/index.ts`.

Read first: `ops/sdd/s1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-storm-scout-design.md`. Names marked **[C1]** / **[E1]** come from the C1/E1 plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`), not from built code: check each against `c1-crm`/`e1-estimator` before starting and report any difference.

**Split:** Builder 1 `meta/http.ts` (Graph calls with the system-user token and `appsecret_proof`, error mapping incl. the special-ad-category error → `targeting`); Builder 2 `meta/link.ts` + `report.ts` (`GET /act_<id>?fields=name,currency,account_status`; assign the system user to the shared ad account `POST /act_<id>/assigned_users` with `tasks=['ADVERTISE','ANALYZE']`; insights `spend,impressions,clicks`); Builder 3 `meta/campaigns.ts` (`adimages` upload → hash; campaign `OUTCOME_TRAFFIC`, `special_ad_categories: housing ? ['HOUSING'] : []`, PAUSED; ad set with `lifetime_budget` = daily × days cents, `end_time`, `targeting.geo_locations.custom_locations` circles in miles (≥ 1; housing → one 15-mile circle at the centroid), `age_min 25`, `publisher_platforms ['facebook','instagram']`; creative `link_data` with image hash, message, headline, landing URL, CTA `LEARN_MORE`; ad PAUSED).

**Files:** Fill `apps/api/src/providers/meta/{http,link,campaigns,report,index}.ts`; fixtures `apps/api/test/fixtures/meta/*.json`; Test `apps/api/test/meta-ads.test.ts`.

**Tests:**
- bodies match fixtures; housing variant; miles conversion and minimums; error mapping; `appsecret_proof` = HMAC-SHA256(token, app secret); secrets never logged.

**Carries and rulings:**
- `appsecret_proof` = HMAC-SHA256(token, app secret).

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): Meta Marketing adapter — shared ad accounts and radius traffic campaigns`
