### Task 9: NWS hourly forecast

**Base:** `g1-agents` after Task 3 is merged. **[D1]** `WeatherSource.daily` (D1 T7). Real: `apps/api/test/fixtures/nws-hourly.json` and `nws-points.json` already exist (F2).

Read first: `ops/sdd/g1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-more-agents-design.md`. Names marked **[C1]** / **[E1]** / **[S1]** / **[D1]** / **[A1]** come from the plans and briefs of those milestones (`ops/sdd/<milestone>/`), not from built code: check each against the merged branch before starting and report any difference.

`WeatherSource.hourly(lat, lng, hours)` → `{ at, precipPct, gustMph }[]` from NWS gridpoint forecast hourly; null on failure; fake fixtures; tests.

**Carries and rulings:**
- Reuse the existing NWS fixtures; add an hourly-forecast fixture only if the existing one lacks gusts.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): hourly forecast for the weather watch`
