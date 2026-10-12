### Task 17: Google Ads adapter

**Base:** `s1-storm` after Task 7 is merged. From T7: `AdsGoogle`, `AdCreate`, `AdStats`, `AdPlatformError`, stub `providers/google-ads/index.ts`. Fixture pattern: **[C1]** C1 T10's injected-`fetch` fixture tests.

Read first: `ops/sdd/s1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-storm-scout-design.md`. Names marked **[C1]** / **[E1]** come from the C1/E1 plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`), not from built code: check each against `c1-crm`/`e1-estimator` before starting and report any difference.

**Split:** Builder 1 `google-ads/http.ts` (OAuth refresh-token exchange cached until expiry, headers `developer-token`, `login-customer-id` = manager, `googleAds:search` and `:mutate` over REST, error mapping to `AdErrorKind`); Builder 2 `google-ads/link.ts` + `report.ts` (CustomerClientLink create/read, `customer` info, metrics by campaign id); Builder 3 `google-ads/campaigns.ts` (one `googleAds:mutate` with temp resource names: budget (`explicitly_shared false`, amount micros = daily cents × 10,000), campaign (SEARCH, Maximize Clicks with no CPC cap per Ruling 8, PAUSED, start/end dates, name tag), ad group, keywords (phrase match), responsive search ad (≥ 3 headlines, 2 descriptions from the step), proximity criteria (≤ 50, radius in km, `units KILOMETERS`), negative keywords `jobs`, `salary`, `diy`).

**Files:** Fill `apps/api/src/providers/google-ads/{http,link,campaigns,report,index}.ts`; Create `apps/api/test/fixtures/google-ads/*.json` (recorded shapes from the public docs; Task 29 replaces them with real captures); Test `apps/api/test/google-ads.test.ts`.

**Tests:**
- request bodies match fixtures (snapshot of the mutate operations); micros math; error mapping (`AUTHORIZATION_ERROR`→access, `POLICY_*`→policy, `BILLING_*`→payment, `CRITERION_ERROR`→targeting); token refresh once per hour; nothing logs the developer token or refresh token.

**Carries and rulings:**
- Never log the developer token or refresh token.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): Google Ads adapter — manager links and proximity search campaigns`
