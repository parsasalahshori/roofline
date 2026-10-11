### Task 11: Web: map home

**Files:**
- Create: `apps/web/src/shell/map/{MapView.tsx,MapView.module.css,mapStyle.ts,pins.ts,PinCard.tsx,PinCard.module.css}`, `apps/web/src/copy/map.ts`
- Modify: `apps/web/src/api/hooks.ts` (`useMapArea`, `useMapPins`), `apps/web/src/copy/legal.ts` (attribution)
- Test: `apps/web/test/map-style.test.ts`, `apps/web/test/pins.test.ts`, `apps/web/test/map-view.test.tsx` (mocks `maplibre-gl`)

**Interfaces:**
- **`mapStyle(env: { maptilerKey?: string; tiles?: string }, mode: 'streets' | 'satellite'): StyleSpecification | string`**
  - With a key: `https://api.maptiler.com/maps/streets-v2/style.json?key=…` or `…/maps/hybrid/style.json?key=…`.
  - With `tiles === 'osm'`: an inline raster style (`https://tile.openstreetmap.org/{z}/{x}/{y}.png`, `tileSize: 256`, `maxzoom: 19`, the attribution from `copy/legal.ts`).
  - Otherwise: a blank style with one `background` layer in `tokens.bg` and no sources.
  - `satelliteAvailable(env): boolean` is true only with a key.
- **`toFeatureCollections(result: PinsResult): { customers: FeatureCollection; jobs: FeatureCollection; clusters: FeatureCollection }`.** The properties carry `kind`, ids, `name`, `addressLine`, `stage`, `stageLabel` and `count`.
- **`CLIENT_CLUSTER_ABOVE = 200`.** When the points shown exceed 200, the GeoJSON sources use `cluster: true` (`clusterRadius: 40`).
- **`MapView({ onOpen(target: { kind: 'customer' | 'job'; id: string }): void })`**, mounted once by the Shell:
  - **Layers:** `service-area` (line, `tokens.text` at 0.5 opacity), `customers` (circle, `tokens['pin-customer']`), `jobs` (circle coloured by `stage` through a `match` on the `stage-*` tokens), `clusters` (a circle sized by count, plus a count symbol layer **only when the style defines `glyphs`**: the blank and OSM styles have none, and a text layer without glyphs errors), and an empty `storm-swath` GeoJSON source with fill layer slot `storm-swath-fill` (Storm Scout fills it). Re-add all of them after every `style.load`, because the satellite toggle swaps styles.
  - **Starting view:** `fitBounds(area.bounds, { padding: 40, maxZoom: 14 })`. With `bounds` null: center `[-96.5, 39.5]`, zoom 3.5.
  - **Pins:** fetch on load and on `moveend`, debounced 300 ms. The bbox is `map.getBounds()`, clamped to valid ranges and rounded to 4 decimals. The query key comes from the rounded bbox.
  - **Clicks:** clicking a customer or job pin shows `PinCard` (name, address, stage label for jobs, and an **Open** `Button` → `onOpen`). Clicking a cluster zooms in (`getClusterExpansionZoom` for client clusters; +2 zoom on a server cluster).
  - **Satellite:** a toggle `Button` shown only when `satelliteAvailable`.
  - **Failure banner:** on the map `error` event for a style, source or tile failure, show a `role="status"` banner: "The map is having trouble loading. Your work is safe." Show it once and do not throw.
  - **Screen-reader summary:** a visually hidden live paragraph, `copy.map.summary(customers, jobs)` → "Map showing 70 customers and 25 open jobs." In clusters mode it is `copy.map.summaryClusters(total)`.
  - **Region:** the map container is `role="region"` with `aria-label={copy.map.label}`. MapLibre's own controls are kept: zoom (`NavigationControl`) and attribution.
- **Env:** `import.meta.env.VITE_MAPTILER_KEY` and `VITE_MAP_TILES` are read only in `mapStyle`'s caller.

- [ ] **Step 1: Write the failing tests**
  - `map-style.test.ts`: key + satellite → hybrid URL; `osm` → raster with attribution; nothing → a style with zero sources; `satelliteAvailable({})` is false.
  - `pins.test.ts`: points → features at `[lng, lat]` with `stage`; clusters → features with `count`.
  - `map-view.test.tsx` (with `vi.mock('maplibre-gl')`: a fake Map class recording `addSource`, `addLayer`, `fitBounds` and `on`, and able to emit events):
    - `it('fits the service area')` and `it('starts at the US view without bounds')`.
    - `it('turns on client clustering above 200 points')`: 201 points → the `customers` source is added with `cluster: true`.
    - `it('shows the banner on a tile error and keeps working')`.
    - `it('summarizes what is on the map')`: with `/api/map/pins` stubbed to 70/25 → text "Map showing 70 customers and 25 open jobs."
    - `it('opens the pin card and Open calls onOpen')`: emit `click` on the `jobs` layer with a feature → the card shows the name and "Proposal"; Open calls `onOpen({kind:'job', id})`.
- [ ] **Step 2: Run them and see them fail**.
- [ ] **Step 3: Implement**. `maplibre-gl/dist/maplibre-gl.css` is imported once in `MapView.tsx`.
- [ ] **Step 4: Run the tests, the lints and the build**. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(web): map home with pins, clustering, satellite and a failure banner`

---

