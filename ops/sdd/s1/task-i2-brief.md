### Task I2: Wave 4 web integration fixes (from the contact-215 group check)

**Base:** branch `s1-i2` = s1-storm + T24 + T27 + T23 merged (conflicts in copy/storm.ts and test/s1-routes.test.tsx already resolved by the S1 lead). Web only. T8's API on this base: `GET /api/map/storm-layer?bbox=w,s,e,n&zoom=&days=` → `{ swaths: FeatureCollection, spots: FeatureCollection, newestRunAt: string|null, stale: boolean }`. Each swath feature's properties are `{ stormId, thresholdIn, maxIn, convectiveDay, status, placeName, label }` (see `packages/db/src/repos/storm-layer.ts`). `bbox` is required, and the API answers 400 without it.

**Fixes:**
1. **(critical) Hail colours by level.** `shell/map/layers.ts` `hailLevelColor()` matches `['get','level']`, a property the API never sends, so every swath is drawn in hail-1. Make `shell/map/stormLayer.ts` the single source:
   - `HAIL_LEVEL_SIZES_IN = [0.75, 1.25, 1.75, 2.5, 3]` (legend: 0.75, 1.25, 1.75, 2.5, and 3 "or more");
   - `hailFillExpression()` matches `['get','thresholdIn']`: 0.75 and 1 → hail-1; 1.25 and 1.5 → hail-2; 1.75 and 2 → hail-3; 2.5 → hail-4; 3 → hail-5; fallback hail-1;
   - `layers.ts` uses it;
   - fix the property comment in `features/storm/layerTypes.ts`;
   - update `hail-legend.test.tsx` and `storm-layer-apply.test.ts` fixtures to use `thresholdIn`;
   - add a test that a 2.5 in contour gets the hail-4 colour.
2. **(critical) Storm window stale banner.** `features/storm/api.ts` `useStormLayer()` calls the API without a bbox, gets a 400, and the banner never shows. It also clashes by name with T24's `layerApi.ts` hook.
   - Delete T23's `useStormLayer` and `StormLayerView`.
   - `StormWindow` reads the company bounds from `useMapArea()` (`api/hooks.ts`) and calls T24's `useStormLayer(area.data?.bounds ?? null, 6, true)`, then uses its `.stale`. Check the real shape of `useMapArea()` data and adapt.
   - Change the `SHELL_ROUTES` stub in `apps/web/test/helpers.tsx` to the URL the hook builds, with a stub that also answers the area call if needed.
   - Move T23's inline query keys `['storms']` and `['storm', id]` into `api/keys.ts` (`keys.storms`, `keys.storm(id)`), next to T24's `stormLayer` and T27's `stormSettings`/`adAccounts`.
3. **(important) One hail palette and one legend.** `features/storm/StormSwathMap.tsx` imports `hailFillExpression`/`HAIL_LEVEL_COLORS`/`HAIL_LEVEL_SIZES_IN` from `shell/map/stormLayer.ts`, not its own `FALLBACKS`, `getComputedStyle` and `LEVELS`. Use one legend heading and one size list. `copy/map.ts` `hailStale` becomes `'Hail data is a little behind'`, the same text as `storm.staleBanner`; better, point both places at one key. Make the legend headings come from one key too.
4. **(minor)**
   - `StormWindow`: drop the `(item.status as string) !== 'dismissed'` cast filter (the list API leaves out dismissed storms), and base the empty state on the list it renders.
   - Remove the unused `comingSoon.storm` copy if nothing uses it.
   - `MapView`/`layerApi.ts`: guard against a malformed 200 body (`swaths?.features ?? []`) so `applyStormData` never throws.
   - Grep `apps/web/src` for `detailComingSoon`, `settingsComingSoon`, `copy/ads.ts`, and the `'level'` match: none may remain.

**Verify:** typecheck, lint, lint:css, `npx vitest run --project @roofline/web` (slot-wrapped); ci-check with `CI_JOBS="Platform E2E Hail"`.
**Commit:** `fix(web): hail colours by contour level, one hail palette, Storm window stale banner from the real layer call`
