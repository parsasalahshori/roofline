# Google data retention

Status: built on branch `google/cleanup` (from `real-lookups` 1337c97c), 2026-10-16. Not legal advice: the readings
below are an engineer's, and the open questions at the end are for counsel.

## 1. What Google's terms say

Read from the live pages on 2026-10-16. Quotes are kept short; read the page for the full clause. These terms are the
non-EEA versions (our billing address is in the US).

| Source | Clause | Short quote | What it means for us |
|---|---|---|---|
| [Maps Service Specific Terms](https://cloud.google.com/maps-platform/terms/maps-service-terms) (last modified 2026-10-15), Solar API **B.20.2 Caching** | Building Insights and Data Layers ("Solar Data") | "for up to 30 consecutive calendar days" | buildingInsights answers and Data Layers (DSM, mask, RGB GeoTIFFs) may be cached for at most 30 days, then deleted. |
| same, **B.20.2** (second sentence) | fixed media | "The deletion obligation does not apply to Solar Data incorporated into fixed media" | Solar Data built into a design, feasibility study, or commercial proposal the customer asked for (a "Downstream Transaction", B.20.1) may outlive 30 days. |
| same, **B.20.1 Permitted Use** | use | "Customer may use the Solar API only (a) to determine the feasibility" | Allowed uses: energy-system feasibility, design or installation, or a Downstream Transaction such as a requested proposal. A roofing quote is a proposal at the user's request; counsel should confirm it fits. |
| same, **A.3 Google ID Caching** | IDs | "Customer may cache the Google ID values" | Google IDs such as `place_id` and Street View `pano` ID may be kept indefinitely. Nothing else is covered. |
| same, sections B.1 to B.21 | (none) | n/a | No Map Tiles section and no Street View section. Tiles and Street View images fall under the ToS no-caching rule with no exception. |
| [Maps Platform Terms of Service](https://cloud.google.com/maps-platform/terms) (last modified 2026-08-26), **3.2.3(b) No Caching** | caching | "will not cache Google Maps Content except as expressly permitted" | Nothing may be cached unless the Service Specific Terms allow it. |
| same, **3.2.3(a) No Scraping** | export | "export, extract, or otherwise scrape Google Maps Content" | No storing or rehosting outside the Services. The examples include bulk downloads of tiles and Street View images. |
| same, **3.2.3(c) No Creating Content From Google Maps Content** | derived content | "Customer will not create content based on Google Maps Content." | Examples given: tracing outlines from imagery, 3D models from 45° imagery, indexing objects from Street View, training ML on it. See section 4. |
| [Solar API policies](https://developers.google.com/maps/documentation/solar/policies) (updated 2026-10-15) | exceptions | "You can therefore store place ID values indefinitely." | Place IDs are the only exception named. The 30-day rule is B.20.2. |
| [Solar Data Layers guide](https://developers.google.com/maps/documentation/solar/data-layers) (updated 2026-10-15) | URLs | "Response URLs are only active for one hour after the initial request." | The GeoTIFF URLs can't serve as a cache. The files are downloaded within the hour and kept in memory only (section 2). |
| [Street View Static API policies](https://developers.google.com/maps/documentation/streetview/policies) (updated 2026-10-15) | caching | "Content pre-fetching, indexing, storing, or caching is generally prohibited" | Street View images must not be stored. Pano IDs are the exception: "you can store panorama ID values indefinitely." |
| [Map Tiles API policies](https://developers.google.com/maps/documentation/tile/policies) (updated 2026-10-15) | caching | "you must not pre-fetch, index, store, or cache any Content" | Tiles are fetched by the browser and never stored by us. The only caching allowed is HTTP caching: "your client must respect the max-age value". |
| same | use | "You may not use Map Tiles API for any non-visualization use cases" | Tiles may not be used for image analysis, object detection or geodata extraction. We only display them. |
| same | print | "Street View imagery may not be used for print purposes" | Street View photos must stay out of printed output. The window order sheet prints only on-site uploads. |
| [Geocoding API policies](https://developers.google.com/maps/documentation/geocoding/policies) | (not used) | n/a | Addresses are looked up with Geocodio, not Google (`providers/geocoder.ts`). |

**Street View in this app.** There is no 30-day allowance for Street View images. The app already kept them only 30
days (`photos_delete_by`), and this branch enforces that limit with the daily job. Keeping them at all is a risk; see
section 4.

## 2. Inventory: where Google content is kept

"Raw" means Google's own content, or a re-encoding or crop of it. "Derived" means numbers we worked out from it.

| # | Where | What | Raw or derived | Written by | Expiry before this branch | Now |
|---|---|---|---|---|---|---|
| 1 | `measurements.solar` (jsonb) | Google Solar buildingInsights as parsed: building centre, box, imagery date and quality, each roof segment's pitch, azimuth, areas, centre, box. Plus `fetchedAt` and `at` | **Raw** (a structured copy of the response) | `estimator/solar.ts` `solarAt` / `solarForHome` → `createMeasurement` | Reused for 30 days (`SOLAR_CACHE_DAYS`), then ignored but **never deleted** | Cleared (`solar = null`) at `google_delete_by` |
| 2 | `measurements.roof_3d.photo` + object `roof-photos/<uuid>.png` | The true-ortho photo: a crop of Data Layers' RGB GeoTIFF, re-encoded as PNG, with its corners | **Raw** (imagery) | `estimator/roof-3d.ts` `storeRoofPhoto` | GET refused after 30 days (`solarDataCurrent`). The object was **never deleted** | Object deleted. `photo` removed and `photoDeletedAt` set. GET answers 410 |
| 3 | `measurements.roof_3d.roof` / `shadowRoof` | Our 3D reconstruction from DSM and mask: outline, faces, pitches, lines, quality scores, lidar provenance | Derived | `estimator/roof-3d.ts` | Reused for 30 days (`ROOF_3D_CACHE_DAYS`), then kept | **Kept** |
| 4 | `measurements.pitch_planes` | Roof planes: pitch rounded to whole x/12, azimuth, a centre point, plan area (from Solar segments) | Derived, but close to Google's segments (section 4) | `estimator/measure.ts` | none | **Kept** |
| 5 | `measurements` numbers (`outline`, `pitch_x12`, `surface_sq_ft`, `edge_ft`, `ridge_ft`, `valley_ft`, `facets`, `footprint_sq_ft`) | The measurement | Derived | `createMeasurement` / `updateMeasurement` | none | **Kept** |
| 6 | `window_measurements.photos[]` + objects `window-photos/<uuid>.jpg` | Street View Static images of the front. Entries hold heading, FOV, `capturedOn` (pano month), `fetchedAt`, `deleteBy`, line-up and person fit, plus the `key` | **Raw** (bytes). Entry numbers are derived | `estimator/measure-windows.ts` `takePhoto` | `photos_delete_by` set to +30 days. GET refused after it and deleted lazily on GET. **No sweep** | Swept daily: objects deleted, `key = null`, `deletedAt` set, `photos_delete_by = null`. GET answers 410 |
| 7 | `window_measurements.windows / estimated / geometry / stories / adjustments` | Window boxes and sizes, wall estimate, eave height (from Google's DSM via `heightLayersFor`) | Derived | `measure-windows.ts`, PATCH | none | **Kept** (risk: section 4) |
| 8 | `window_measurements.uploads` + their objects | The company's own phone photos | Not Google | `routes/window-measurements.ts` | none | Untouched |
| 9 | In-process memory: `layersCache` (decoded DSM, mask and RGB; at most 8 for 15 min), `roofCache` (30 min), Solar `asked` (30 min) | Raw layers and responses | **Raw**, memory only | `estimator/roof-3d.ts`, `estimator/solar.ts` | Minutes. Never written to disk | Unchanged (well inside 30 days). The GeoTIFFs are never written to disk or the object store |
| 10 | Demo object store `.demo-files/<project>/` (`DirObjectStore`, files named by sha256) | Same keys as rows 2 and 6 when the demo measures for real | **Raw** | `providers/fakes/dir-object-store.ts` | none | The demo worker runs the same job. New files get a `.key` sidecar so orphans can be listed (gap: files written before this branch are reached only through their rows) |
| 11 | Browser `localStorage` `roofline.googleTileSession` | The Map Tiles session token | Not content | `lift/googleTiles.ts` | Token expiry | Unchanged. Tiles are only HTTP-cached by the browser, as the tile policy allows |
| 12 | Owner's research data: `~/RooflineWork/roof-bench/testset*` (manifest `data.deleteBy`), `~/RooflineWork/saved-testdata`, Claude scratchpads (`sv/*.jpg`) | `dsm.tif`, `mask.tif`, `rgb.tif`, `bi.json`, `meta.json`, Street View JPEGs. Derived overlay PNGs and SVGs | **Raw**. Derived images may hold Google pixels | Bench tooling, by hand | Manifest date only, enforced by hand (`npm run solar:retention -w @roofline/api`) | `scripts/google-retention-bench.ts`: dry run by default, `--apply` deletes |

Not Google, checked: geocoding (Geocodio), building outlines (Microsoft, ODbL), lidar (USGS), the claim-packet map
(MapTiler). Proposals and signed PDFs do not embed the roof photo or Street View images.

## 3. Rules

- **R1. Raw content goes within 30 days of download.**
  - Applies to: Solar answers, the roof photo, Street View photos, and orphaned objects under `roof-photos/` and `window-photos/`.
  - Setting: `GOOGLE_CONTENT_RETENTION_DAYS`, from 1 to 30. Unset means 30. Anything else stops the API and worker at start, so a typo can never mean "longer".
- **R2. Dates are stored once, at the most allowed.**
  - Every delete-by date is the download time + 30 days: `measurements.google_delete_by`, `window_measurements.photos_delete_by`, and each photo's `deleteBy`.
  - With a shorter setting, the job treats rows as due that many days early (`retentionCutoff`), so stored dates never need rewriting.
  - Due means `delete_by <= now + (30 - days)`.
- **R3. A measurement's date is the earlier of two downloads.** One is its Solar answer's `fetchedAt` (when it names a building). The other is its roof photo's snapshot `fetchedAt`.
  - A reused snapshot keeps its first download time. A re-measure on day 20 of a day-1 download is still due on day 31.
- **R4. Our derived numbers are kept.** Covered: outline, 3D faces and lines, pitch and pitch planes, totals, window boxes and sizes, wall heights.
  - Reading: these are measurements we computed for the user's quote, not a copy of Google's content.
  - Solar B.20.1 permits Solar use for a design or a proposal the user requested, and B.20.2 exempts Solar Data in "fixed media" for such a transaction.
  - Risk is in section 4.
- **R5. Cleared caches force a fresh fetch.** With `solar` cleared and the roof snapshot past its reuse days, a re-measure asks Google again, then stores a new photo and a new date.
- **R6. The UI copes.** The views carry `roofPhotoExpired` (owner and office only) and `photos[].expired`. The photo routes answer **410 Gone** with "Photo expired (Google's 30-day limit). Re-measure to see it again."
  - The roof view: shows that text as a notice. A failing roof-photo image source no longer marks the whole map as failed.
  - The windows photo area: shows the same text, for a photo the view marks expired or one whose load fails with 410 (checked with a `HEAD`).
- **R7. Logs carry counts only.** Never keys, addresses or content. Each run is a `google_retention_runs` row.

## 4. Derived values: reading and risk

- **Solar (roof 3D, pitch, pitch planes): low to moderate risk.**
  - B.20.1 names designing an energy system and a Downstream Transaction, meaning a commercial proposal the user requested. B.20.2's fixed-media carve-out lets Solar Data survive inside it.
  - Our stored numbers feed the quote the homeowner asked for.
  - Two weaknesses:
    - We are a roofing estimator, not an energy-system designer. Whether "commercial proposal" covers a roofing quote is the key question for counsel.
    - `pitch_planes` is close to a copy of Google's segments (rounded pitch, azimuth, centre, area).
  - If counsel reads it strictly, the fallback is to clear `pitch_planes` along with `solar`. The stored totals would stay, but the measurement view would then give every facet the single stored pitch instead of each plane's own. That change needs a product decision.
- **ToS 3.2.3(c), creating content from Google Maps Content: moderate risk.**
  - The 3D reconstruction is a model built from Google's height map, close to the clause's "3D building models" example. It is also the purpose the Solar API is sold for (design from Data Layers), so the Solar terms arguably govern.
  - Window measurements are marked on Street View photos, close to the "indexing objects from Street View" example. There is no Solar-style carve-out for Street View. This is the **highest risk** item: the photo bytes go at 30 days, but the window boxes and sizes stay.
- **Street View print: checked, no action needed.** Street View imagery must not be printed. The window order sheet (`window-order-sheet.ts`, `order/OrderLine.tsx`) shows only the company's own on-site uploads.

## 5. The job

`google-retention` in `SCHEDULES` (`apps/api/src/jobs/worker.ts`):

- **When it runs:** daily at 04:23 UTC, and once at each worker start (`runAtStart`; the `short` queue keeps one waiting run).
- **Per company** (`withTenant` as `system`), in batches of 200:
  1. Backfill missing dates (rows from before the column): `google_delete_by` and `photos_delete_by`. The source is the download time in the jsonb, else `created_at`, plus 30 days. The migration cannot do this: the tables force RLS and the owner is not a superuser.
  2. Measurements due: delete the photo object, then clear `solar` and `roof_3d.photo` (set `photoDeletedAt`), and set `google_delete_by = null`.
  3. Window measurements due: delete every Street View object, then null each key, set `deletedAt`, and set `photos_delete_by = null`.
  4. Collect the keys rows still name.
- **Orphans:** objects under `roof-photos/` and `window-photos/` that no row names are deleted after a 1-hour grace period. If any company failed, only those past the retention days are deleted.
- **Idempotent:** a failed delete leaves its row for the next run. A second run finds nothing to do.
- **Record:** one `google_retention_runs` row (counts, retention days, finish time) and one log line of counts.

Schema: `0038_google_retention_schema.sql` (`google_retention_runs`, `measurements.google_delete_by` + index) and
`0039_google_retention_grants.sql` (app_system S/I/U on the runs table; app_tenant nothing).
`window_measurements.photos_delete_by` and its index already existed (0030).

## 6. Local research data

`npx tsx scripts/google-retention-bench.ts`:

- **Default:** a dry run. `--apply` deletes, and only with the owner's OK.
- **What it deletes:** Google files past their date: Solar files in house folders, and scratchpad Street View JPEGs. Other files in a house folder stay.
- **Derived images:** listed for review, and deleted only with `--include-derived-images`.
- **Options:** `--now`, `--days`, `--root`, `--no-scratchpads`, `--list`.
- The older `apps/api/src/scripts/solar-data-retention.ts` stays. The new script adds `meta.json`, scratchpads, Street View, and the `--days` setting.

## 7. Open questions for counsel

1. Does a roofing quote (with measurements) count as a "commercial proposal" Downstream Transaction under Solar B.20.1, so the derived roof numbers and B.20.2 fixed media apply?
2. May we keep window boxes and sizes marked on Street View images after the images are deleted, given ToS 3.2.3(c)?
3. Should `pitch_planes` be treated as Solar Data and cleared at 30 days?
