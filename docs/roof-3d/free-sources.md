# Free answer keys and free providers (track `free`)

Status: county truth grade committed (bench only, not gated); free-provider comparison done; no product change.
Data lives outside the repo under `<ROOF_BENCH_DIR>/free/` (default `/Users/parsasalahshori-a/RooflineWork/roof-bench/free`).
The full ranking tables and the owner's verdict are in `<ROOF_BENCH_DIR>/free/comparison.md`.

## Problem

- **No paid keys.** The owner will not buy EagleView reports. The 34 sandbox reports on disk are the only roof
  reports we have, and they are spread over 20 states, mostly with light canopy.
- **Lidar truth is not enough on its own.** A method that reads lidar can't be scored on lidar truth from the same
  flight. We need a second key that is independent of both Google and lidar.
- **Are we better than the free tools?** Free instant roof estimators mostly use Google Solar `buildingInsights`
  numbers or ML building footprints. We had never measured ourselves against those.

## Approach

1. **County truth grade (`county`).** County and state GIS offices digitize building footprints from aerial photos
   (many of them leaf-off). We pull them over public ArcGIS REST, pick the footprint under the house point, and refuse
   machine-learning rows and footprints that are clearly a different building.
   - Pick rule (`county_truth.py`): take the footprint containing the house point, or the nearest one within
     `PICK_RADIUS_M = 6 m` (a geocode lands on the roof, so a footprint further than a few metres away belongs to
     another building). Add footprints within `TOUCH_M = 0.3 m` of it, because planimetrics often split an attached
     garage or porch into its own polygon.
   - Refusal: footprint plan area divided by Google's `buildingInsights` ground area must fall within `AREA_RATIO =
     [0.5, 2.0]`. The bounds are wide on purpose. A canopy-hidden wing makes Google's area small, and that is exactly
     the case the grade exists for. Machine-learning rows (Microsoft rows in NY and NJ) are never truth.
   - Provenance: each truth file records its source, method, dates and `lidarDerived`. A lidar-reading method must
     never be scored on a lidar-derived footprint.
   - Harness (`apps/api/src/bench/roof3d/county.ts`): the grade is merged into the manifest like lidar
     (`withCounty`, cohort `truth-county`, fingerprint `countyHash`). It is scored raw and after EagleView's
     best-translation rule (within 3 m). It gets its own report table and is not gated.
2. **Free-provider comparison** (`compare.py`, `summarize.py`). This scores our reconstruction (`roof-3d-free-dump.ts`,
   seed 7, server defaults) against Microsoft footprints, OSM (Overpass, plus OSM as carried in Overture), Overture,
   the Arkansas GeoStor composite (Microsoft + FEMA), county footprints and Google `buildingInsights`.
   - Keys: EagleView, lidar and county.
   - Pairing: each source is compared with ours on the same houses.
   - Breakdowns: DEV and HELD-OUT separately, and by tree cover.
   - Alignment: every outline source gets the same best-translation alignment, so a frame offset costs nobody.
   - Independence rules: a source is never scored on itself. Footprints traced from lidar are never scored on lidar
     truth: 9 Overture footprints carry the `USGS Lidar` source (Houston, Portland, Seattle, Atlanta, DC), plus any
     OSM feature tagged with a lidar source.
3. **Footprint as an extent hint** (`hint_experiment.py`, DEV only). Align the footprint to our outline (our outline is
   the reference; no truth involved). Then, if the footprint is the same building (IoU >= 0.6) and more than 10%
   larger, use union(ours, footprint).

## Sources found (Arkansas first, then states that cover EagleView houses)

| source | endpoint | method / imagery | accuracy statement | terms | covers benchmark houses |
|---|---|---|---|---|---|
| PAgis (Pulaski Co., AR) | `pagis.org/arcgis/rest/services/MAPS/OperationalLayers_Basic/MapServer/9` | photogrammetric planimetrics. 2004 base (`VER_DATE 20040401` on most houses), edited 2012-2024. PAgis flies leaf-off. | none published on the layer. Against lidar: aligned IoU 0.90 median, about 7% smaller in plan (walls or a tight roof line, not the drip edge). | public map service. No license text on the layer: credit PAgis and ask before redistributing. | 9 (Little Rock, North Little Rock) |
| AR GIS Office GeoStor `BLDG_FOOTPRINTS_COMPOSITE` | `gis.arkansas.gov/arcgis/rest/services/FEATURESERVICES/Structure/FeatureServer/54` | Microsoft ML plus FEMA/ORNL USA Structures (ML). Per-feature capture dates, some leaf-off (Dec 2019 to Jan 2020). | none | public (credits Microsoft, FEMA, ORNL, USGS, AGIO) | 19 (all AR). ML, so a provider and never truth. |
| NYS ITS building footprints | `gisservices.its.ny.gov/arcgis/rest/services/BuildingFootprints/FeatureServer/2` | county planimetrics where available, else Microsoft (per-feature `SOURCE`) | per county | public | Elma: only Microsoft rows near the point, so refused |
| IndianaMap Building Footprints 2016-2020 | `gisdata.in.gov/server/rest/services/Hosted/Building_Footprints/FeatureServer/0` | **lidar-derived** (`lidaryear`) | none | public | 1 EagleView house (Pendleton). `lidarDerived: true`. |
| Oregon Metro RLIS (via City of Portland open data) | `portlandmaps.com/od/rest/services/COP_OpenData_Property/MapServer/48` | photogrammetric (per-feature `SOURCE`, e.g. "2008 Aerial Photos", 3Di 1999). Lidar-sourced rows refused. | none on the layer | public open data | 1 EagleView house (Beaverton, heavy canopy). The other Beaverton house had no footprint at the point. |
| OCGIS Building Footprints (Orange Co., CA) | `ocgis.com/arcpub/rest/services/Map_Layers/Building_Footprints/FeatureServer/0` | method unstated. It carries lidar heights, so it is treated as **lidar-derived**. | none | public | 3 (Irvine x2, EagleView Laguna Hills) |
| NJ DEP Structures | `mapsdep.nj.gov/arcgis/rest/services/Features/Structures/MapServer/8` | mostly lidar-derived (per-feature `project`), some Microsoft | none | public | none at the 2 NJ houses (no footprints there) |

Searched without finding an open service:

- Sebastian, Garland, Washington, Benton and Faulkner counties (AR). These are covered only by the GeoStor ML composite.
- Gwinnett (GA), Wake (NC), Sacramento, Kansas City and Hampton.
- Miami-Dade publishes 2005 large buildings only.
- Mecklenburg's footprints come from 1992-95 flights and need a signed waiver, so they were not used.

Other free sources used as providers:

| source | license |
|---|---|
| Microsoft Global ML Building Footprints | ODbL |
| OpenStreetMap | ODbL |
| Overture 2026-09-23.0 | ODbL / CDLA by source |

Google calls: **0**. `buildingInsights` came from the cached `bi.json` of every house.

## Validation of the county grade (the independent keys it overlaps)

| key | houses | aligned IoU (median) | plan error, county vs key (median) | boundary distance (median) |
|---|---|---|---|---|
| lidar (USGS 3DEP). Only photogrammetric sources count: 6 PAgis + 1 RLIS. | 7 | 0.869 | -7.6% | 0.38 m |
| EagleView: IndianaMap and OCGIS (lidar-derived), RLIS (photogrammetric) | 3 | 0.836 | +0.2% (abs 12.1%) | 0.69 m |

- **EagleView coverage is thin.** Three EagleView houses are covered, and only one of them by a photogrammetric source
  (RLIS, Beaverton: -12% in plan against EagleView, aligned IoU 0.84).
- **The grade is a coarse key.** Against EagleView, the county footprints (0.836) are a worse outline than our own
  (0.932 on the same 3 houses). Use the county grade for **extent**: is a wing missing, and is the area 15-20% low? It
  is not a key for boundary precision.
- **Known bias.** The PAgis grade is about 7% small in plan. The report header says so: a shortfall measured against
  it understates the real one.
- **Refusals.** Accepted: 14 houses (9 PAgis, 3 OCGIS, 1 RLIS, 1 IndianaMap). Refused: 3 got `no-footprint`
  (NY/NJ/CT, Microsoft-only rows) and 3 got `no-footprint-at-point`. No footprint was refused for size.
- **Sensitivity (+/-20%).**
  - `AREA_RATIO [0.4, 2.4]` accepts the same 14 houses.
  - `[0.6, 1.6]` drops 2 (nlr-park-hill 1.86, lr-305-ridgeway 1.60), which are the heavy-canopy houses the grade is for.
  - `PICK_RADIUS_M` 4.8 or 7.2 m picks the same footprints, because every pick contained the point.

## Alternatives rejected

- **Scoring ML footprints as truth.** Microsoft, GeoStor and Overture are what a free tool would use. Treating them as
  the answer key would be grading our competitors with their own answers.
- **Lidar-derived county footprints (Indiana, NJ) as a key for lidar methods.** That is circular. They stay in the
  grade, marked `lidarDerived`.
- **Selecting the county footprint by overlap with our outline.** That would tie the key to the estimate. The pick
  uses only the house point and the publisher's polygons.
- **A new request-time footprint provider.** See the verdict below. The product already loads Microsoft footprints
  into `building_footprints` (`estimator/footprints-load.ts`, `footprintsNear`), so a hint from them needs no new
  provider.

## Risks

- PAgis footprints are mostly from 2004. Additions built after 2004 are missing unless PAgis edited them in later. The
  area check catches only gross mismatches.
- The county grade covers 14 houses, 9 of them in one county (Pulaski, AR), and 4 of the 14 are lidar-derived.
  Conclusions about photogrammetric county footprints rest mostly on one county.
- OSM mappers in Pulaski County may trace PAgis orthophotos: PAgis approved its imagery for OSM (OSM wiki
  "Arkansas/PAgis"). OSM and the PAgis footprints are then two tracings of the same photos, not two independent
  surveys. The OSM rows on the Pulaski county key should be read with that in mind (`osm-ov`: 5 houses).
- Free sources change over time (Overture releases, OSM edits). The fetched files are frozen under `free/` with the
  release recorded.

## Rollback

The grade is bench-only. Delete `free/county/index.json` and the harness reads no county truth: `readCountyIndex`
returns null and reports omit the table. No product code changed and `ROOF_3D_ALGORITHM_VERSION` is unchanged.

## Reproduce

```
V=/Users/parsasalahshori-a/RooflineWork/venv/bin/python; cd scripts/roof-bench-free
$V fetch_ms.py; $V fetch_overture.py; $V fetch_osm.py; $V split_overture.py
for s in pagis geostor-composite ny-its indiana nj-dep rlis ocgis; do $V fetch_arcgis.py $s; done
(cd ../../apps/api && npx tsx src/scripts/roof-3d-free-dump.ts)
$V county_truth.py; $V validate_county.py; $V compare.py; $V summarize.py
$V hint_experiment.py overture 0.10 0.6 dev
$V -m unittest discover -s tests
npm run test:bench -w @roofline/api        # county.test.ts
npm run roof3d:bench -w @roofline/api -- --split dev --cohort truth-county
```
