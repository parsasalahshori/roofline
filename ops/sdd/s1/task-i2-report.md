# Task I2 report: Wave 4 web integration fixes

## Built
- A-map-palette: layers.ts uses hailFillExpression() (local hailLevelColor deleted, no ['get','level'] match left); stormLayer.ts id list moved inside setStormVisible to break the layers/stormLayer import cycle; applyStormData falls back to empty collections; MapView uses storm copy staleBanner; copy/map.ts hailSizeLevels = 0.75/1.25/1.75/2.5/3 in, hailStale removed; tests updated to thresholdIn.
- B-storm-window: StormWindow calls useMapArea() and useStormLayer(bounds, 6, true); banner only when layer.data?.stale === true; comingSoon.storm removed; helpers.tsx stubs GET /api/map/area and exports STORM_LAYER_KEY; stale-banner and empty-state tests added. F2 two-click test unchanged and green.
- C-swath-map: StormSwathMap uses hailFillExpression() and HAIL_FILL_OPACITY; legend heading and items from mapCopy.hailLegend / hailSizeLevels; two tests added in storm-detail.test.tsx.

## Reviews
- Review 1: verify passed, 0 findings.

## Minors
- prettier --check flags StormSwathMap.tsx and storm-detail.test.tsx (not enforced by the repo gate).
- Package C new tests were written with the implementation (no red step).

## Verify tail
typecheck, lint, lint:css clean; vitest @roofline/web: 56 files, 522 tests passed.
