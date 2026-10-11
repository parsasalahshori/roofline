# Task 11 report: Web map home

Status: DONE
Worktree: `/Users/parsasalahshori-a/RooflineWork/wt/t11`, branch `f2-t11` (base `2759c9e`)
Commit: `3790d81 feat(web): map home with pins, clustering, satellite and a failure banner` (21 files, includes package-lock.json). The co-author trailer is `Claude Sonnet 5.5`, which follows the harness attribution rule for this session. Earlier milestone commits in this repo end with `Claude Opus 5.5`; the task text asked for that line, so the controller may want to amend it at merge if the repo convention matters.

## What was built, by package

**P1 data and card** (`mapStyle.ts`, `pins.ts`, `PinCard.tsx`, `PinCard.module.css`, `copy/map.ts`, tests `map-style`, `pins`, `pin-card`, `map-hooks`)
- `mapStyle(env, mode)`:
  - A MapTiler key (trimmed; blank counts as none) gives the `streets-v2` or `hybrid` style URL, with the key passed through `encodeURIComponent`.
  - Without a key, `tiles === 'osm'` gives the inline raster style with `legal.mapAttribution` (already in `copy/legal.ts` from an earlier task, so `legal.ts` needed no change).
  - Otherwise a blank style with one `background` layer in `tokens.bg`, no sources and no glyphs.
  - `satelliteAvailable(env)` is true only with a key. `import.meta.env` is not read here.
- `pins.ts`: `toFeatureCollections` (customers, jobs, clusters, properties as specified), `CLIENT_CLUSTER_ABOVE = 200`, `needsClientClustering`, `normalizeBbox` (clamp, round to 4 decimals, negative zero becomes 0), `emptyFeatureCollection`.
- `PinCard`: a `Card` section labelled by its title, optional stage line (only when the stage label is not null), `Open` and `Close` through `Button`, all text from `mapCopy` and `common`.
- `copy/map.ts`: label, satellite, open, error, `summary(customers, jobs)` and `summaryClusters(total)`.

**P2 layers and clicks** (`layers.ts`, `interactions.ts`, tests `map-layers`, `map-interactions`)
- `installMapLayers`: sources first, then layers. Order is `service-area`, `customers`, `jobs`, `clusters` (circle) and the count labels only when `map.getStyle()?.glyphs` is set, then the empty `storm-swath` source with `storm-swath-fill`.
- `removeMapLayers` removes layers before sources. `updateMapData` calls `setData` when the clustering mode is unchanged, and otherwise rebuilds only the pin group.
- `bindMapInteractions` binds pin clicks (card), client-cluster clicks (`getClusterExpansionZoom` then `easeTo`) and server-cluster clicks (+2 zoom), and returns an unbind function that calls `map.off` with the same handlers.
- Test fakes follow MapLibre's rules (duplicate add throws, a layer without its source throws, a source in use cannot be removed), so the add and remove order is really checked.

**P3 map view** (`MapView.tsx`, `MapView.module.css`, test `map-view`)
- `MapView({ onOpen })` is the whole map home, same name and props as Task 12's placeholder, so it replaces that at merge. It imports `maplibre-gl/dist/maplibre-gl.css` once.
- Start view: `fitBounds(area.bounds, { padding: 40, maxZoom: 14 })`, or centre `[-96.5, 39.5]` at zoom 3.5 with no bounds.
- Pins load on the first view and on `moveend`, debounced 300 ms, from the rounded bbox.
- Satellite toggle only with a key; the swap uses `setStyle(style, { diff: false })` and everything is reinstalled on `style.load`.
- Failure banner: one `role="status"` banner, shown once on any map `error`, never thrown. The region is `role="region"` with the label, and the live summary is a visually hidden paragraph.
- Env is read only at use time, in `readMapEnv()`.

**Lead (shared files)**
- `apps/web/package.json` and `package-lock.json`: `maplibre-gl@^5.24.0` and `@types/geojson`.
- `apps/web/src/vite-env.d.ts`: typed `VITE_MAPTILER_KEY` and `VITE_MAP_TILES`.
- `apps/web/src/api/hooks.ts`: `useMapArea` (`staleTime` 5 minutes) and `useMapPins(bbox | null)` (disabled with no box, `keepPreviousData`, `staleTime` 15 s). `keys.mapArea`, `keys.pins` and the `MapArea` and `PinsResult` types already existed from Task 10.

## Review rounds

The finding texts were not passed to this run, only the counts and the contact verdicts. The outcome column follows the verdicts. "Amended" means the fix was applied in the amended form the contact check approved.

| Round | Verify | Findings | Contact check | Outcome |
|---|---|---|---|---|
| Review 1 | failed | 6 (F1 to F6) | F1 amend, F2 approve, F3 approve, F4 amend, F5 amend, F6 approve | All 6 applied: F2, F3, F6 as written; F1, F4, F5 amended |
| Review 2 | passed | 1 (R2-1) | R2-1 amend | Applied, amended |
| Review 3 | passed | 1 (R3-1) | R3-1 amend | Applied, amended |

- Fixed or amended: 8 of 8. Rejected: none.
- This final pass changed no source or test code. It ran the full verification, set the `com.apple.fileprovider.ignore#P` attribute on `apps/web/node_modules`, and committed the working tree.

## Minors (carried, not fixed here)

- Task 12's shell tests: `Providers` always mounts an empty `role="status"` toast region, so a query for `status` finds more than one element. The map banner test finds the banner by its text instead.
- The map-view test named for the swap ("...again after it is swapped") covers only the first `style.load`; the swap itself is asserted in the satellite test.
- Guards beyond the brief: a pin click with null properties or a non-Point geometry is ignored, a client-cluster click with a non-numeric `cluster_id` is ignored, and a failed zoom (including an error thrown by `easeTo`) is swallowed on purpose.
- The blank and OSM styles have no `glyphs`, so cluster counts are not drawn there. Only the MapTiler styles show count labels.
- `apps/web/node_modules` (holding `@vitejs`) exists in every worktree; it is not from this task's install.
- `build:web` does not yet include the map: nothing imports `MapView` until Task 12's shell mounts it, so the bundle size is unchanged (365.81 kB). Re-check the size once the shell lands, since maplibre-gl is large.
- Tests use a fake map. Nothing here has been run against real WebGL or a live MapTiler key.

## Verify output tail

Command, from the worktree root: `npx vitest run --project @roofline/web && npm run lint && npm run lint:css && npm run typecheck && npm run build:web`. All steps clean, no changes needed to pass.

```
 Test Files  13 passed (13)
      Tests  158 passed (158)
   Duration  10.28s

> eslint .                     (clean)
> stylelint ...                (clean)
> tsc -b                       (clean)
> vite build
✓ 128 modules transformed.
dist/index.html                   0.39 kB │ gzip:   0.26 kB
dist/assets/index-CofAlnV-.css    6.77 kB │ gzip:   2.02 kB
dist/assets/index-D4aMjAsU.js   365.81 kB │ gzip: 114.39 kB
✓ built in 766ms
```
