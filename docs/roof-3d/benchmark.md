# The roof 3D benchmark

One command measures any change to the roof reconstruction on the same houses with the same scorer, and fails when a
change makes things worse. Design note: [bench.md](bench.md).

```
npm run roof3d:bench -w @roofline/api -- [--split dev|heldout|all] [--cohort NAME] [--house a,b]
                                         [--compare BASELINE.json] [--json OUT.json] [--reveal]
```

It reads files only (no network, no database, no API key) and takes about two minutes for the whole set: every house
is reconstructed the way the server does it (`roofOnLayers`, then the Google check) at seeds 7, 8 and 9, and once
more at seed 7 to prove the result is byte-identical.

Where things are (`ROOF_BENCH_DIR`, default `/Users/parsasalahshori-a/RooflineWork/roof-bench`; outside the
repository, because Google's files must never be committed or published):

| file | what |
| --- | --- |
| `manifest.json` | every house: folder, point, region, truth grade, cohort tags, frozen split, download and delete-by dates |
| `gates.json` | the regression gates (the contract) |
| `baseline.json` | the frozen baseline `--compare` judges against |
| `testset/`, `testset-ev/`, `testset-trees/` | one folder per house: `dsm.tif mask.tif rgb.tif bi.json info.json meta.json`, plus `eagleview.json`, `visual.json` or `osm.json` when it has them |
| `fetch-ledger.json` | what has been bought from Google, ever (the budget guard) |
| `lidar/` | lidar truth (USGS 3DEP, public domain): `index.json` (each house's grade and why), `<slug>/truth.json` and `truth.png` (the truth in use), `<slug>/units/<work unit>/` (each project's crop and truth), `tiles/` (downloaded LAZ tiles), `ledger.json`, `coverage.json`. Built by `scripts/roof-bench-lidar/` (see "Lidar truth") |
| `baseline-v2.json`, `gates-v3.json` | the baseline at c606b7a4 with lidar metrics, and the gates with the lidar block |
| `baseline-v3.json`, `baseline-v3-dense.json` | the baseline with hidden edges on (version 4), midpoint and dense eave-support scorers |
| `trees-candidates/` | the free-source pre-screen: one file per neighbourhood of house-sized OpenStreetMap outlines with their NAIP crown scores |

A house is looked up in the bench folder first, then in `/Users/parsasalahshori-a/RooflineWork/saved-testdata` (the
folder the first 54 houses came from). To run on that folder alone:
`ROOF_BENCH_DIR=/Users/parsasalahshori-a/RooflineWork/saved-testdata npm run roof3d:bench-manifest -w @roofline/api -- --ev-targets targets.txt`.

Exit codes: `0` ok, `1` a gate failed, `2` bad usage, `3` a data problem (missing files, a manifest that breaks its
frozen split, Google data past its 30 days, a baseline made from another manifest).

## Working with it

- While developing: `npm run roof3d:bench -w @roofline/api -- --compare /Users/parsasalahshori-a/RooflineWork/roof-bench/baseline.json`
  (dev split, about 90 seconds). `--cohort canopy-heavy` or `--house tr-seattle-220924176` narrows it. Write the
  failing case first: a house or a synthetic roof (`packages/shared/test/fixtures/synthetic-roofs.ts`) that shows the
  problem, confirmed to fail on the base commit.
- Before merging, the integrator and verifiers run `--split all --reveal --compare` and judge the held-out aggregates
  too. Nobody tunes on held-out houses: if a change helps dev and hurts held-out, it is overfit.
- A change that moves a cohort threshold or adds houses needs a new manifest and a new baseline; say so in the commit.
- Hidden-edge methods are chosen per run with `ROOF3D_HIDDEN_EDGE`: unset is the server's default
  (`photo+planes` since `ROOF_3D_ALGORITHM_VERSION` 4, [outline-release-notes.md](outline-release-notes.md)); `off` is
  the reconstruction before it; `planes`, `photo`, `photo+planes`, `planes+photo` run that method
  ([planes.md](planes.md), [photo.md](photo.md)); `ROOF3D_HIDDEN_EDGE_PARAMS` takes JSON parameter overrides. The lidar
  step runs with `--lidar-edges` and is judged on EagleView only (`src/scripts/roof-3d-lidar-eval.ts --method`, which
  scores any of the methods the same way), never on lidar truth.
- `ROOF3D_BENCH_SUPPORT=dense` scores the hidden-edge sets in 0.2 m pieces. The product's `eaveSupport` clamps every
  sample past an edge's midpoint to the midpoint, so the default (`midpoint`) scorer never measures the second half of
  an edge and over-counts its midpoint. Dense runs carry `+dense` in their lidar fingerprint and compare only against a
  dense baseline (`baseline-v3-dense.json`).
- The benchmark's own tests: `npm run test:bench -w @roofline/api` (or `npx vitest run --project roof-bench` from the
  root). No database, no network, about 8 seconds.

## Reading a report

The text report has one block per split (dev, then held-out as aggregates) and one table per question. Every number
is the **mean over seeds 7, 8, 9**; when the seeds disagree it is followed by `[min-max]`. A cohort is a row.

1. *Against the answer key*: `n` houses, `key` of them with an answer key that is the same single building,
   median outline IoU, mean boundary distance (m), Hausdorff 95 (m), median `|area error| %`, how many are within
   5 %, main pitch exact and within 1/12, median per-face pitch error, median share of roof area within 1/12.
2. *Line totals against EagleView*: ridge, hip, valley, eave, rake, percent over/under EagleView's total.
3. *Shape and sanity (every house, key or not)*: median face count, slivers, thin faces, steep junk, faces steeper
   than 18/12 of any kind, median outline vertices, median rectilinearity, houses meeting every checker target,
   no-roof and failed houses, houses the estimator would not show (`unusable`), review-flag rate, precision, recall.
4. *Review reasons*: how many houses carry each reason (`trees`, `roof-hidden`, ...), by cohort.
5. *Against lidar truth*: lidar houses that are the same building (IoU >= 0.5) of those with lidar truth, IoU, boundary
   distance, HD95 and aligned IoU against the lidar outline, plan and sloped area error, main pitch within 1/12, and
   the hidden-edge sets (see "Lidar truth").
6. *Proxy cross-checks*: independent sources that should roughly agree (see "Truth grades").
7. *Runtime and determinism*: p50 and p95 milliseconds per house, houses whose rerun was not byte-identical,
   houses whose seeds gave materially different results.

Then the dev houses one per line (`*` after a name: its result differs between seeds). Held-out houses are never
listed unless `--reveal`.

With `--compare`, a final block lists each gate that failed: cohort, rule, baseline, current, limit.

## What each metric means

Outlines are compared as polygons in metres (UTM of the house's zone). Polygon intersection and union come from
`polygon-clipping` (MIT, dev dependency); if it cannot finish on a degenerate input the overlap is measured on a
0.1 m grid instead, so a score is never missing. A property test checks the two agree within 0.01.

| metric | definition |
| --- | --- |
| outline IoU | area(ours ∩ key) / area(ours ∪ key), our roof outline against the key's outline (EagleView's union of faces, or a hand-drawn outline) |
| mean boundary distance | each boundary is sampled every 0.2 m; the mean distance from each sample to the other boundary, averaged over both directions (average symmetric surface distance), metres |
| Hausdorff 95 | the larger of the two directed 95th percentiles of those distances, metres. A 6 m bite out of one side moves this and barely moves the mean |
| area error | (our total sloped area − EagleView's total sloped area) / EagleView's, percent, signed; medians use the absolute value |
| main pitch | the pitch (whole x/12, half to even like the earlier scorer) carrying the most sloped area; ours ignores flat faces. Error is the absolute difference |
| per-face pitch | each EagleView face of 100 sq ft or more is matched to the face of ours that overlaps it most (needs 30 % of it covered); the error is the area-weighted mean, and "within 1/12" is the share of matched area. Unmatched area is reported per house |
| line totals | our total length of each of ridge, hip, valley, eave, rake against EagleView's, summed over the houses that have a comparable key |
| faces | face count |
| sliver | a face under 25 sq ft of plan area (the checker's junk) |
| thin face | a face of 25 sq ft or more whose width (2 × area / perimeter) is under 0.9 m (3 ft): the sliver along an eave that the owner saw at 305 Ridgeway Dr. Informational, and gated in the simple and canopy cohorts only |
| steep junk | faces steeper than 18/12 when Google has no segment that steep (the checker's steep faces). `>18/12` counts them whether or not Google has one |
| outline vertices | corners of the outline |
| rectilinearity | share of outline length within 5° of the two axes of the best-fitting rectangular frame (the angle, mod 90°, found by scanning every half degree). 1 for any rectilinear outline, about 0.2 for a circle |
| review flag | the estimator marked the roof for review (any quality reason). Precision: flagged and bad / flagged. Recall: flagged and bad / bad. **Bad** = total area off by more than 10 % or main pitch off by more than 1/12 against an EagleView key |
| checker | the existing acceptance targets (`estimator/roof-3d-compare.ts`): every main face within 1/12 and 15° of Google's segment under it, no junk, no steep, the outline over Google's mask. "Passing" = every target met |
| unusable | the estimator's own `unusable()` verdict: such a roof is not shown and the home is measured from its outline |
| determinism | the first seed run twice gives byte-identical JSON |
| seeds differ | a seed's result differs materially from seed 7's: another face count, sliver or steep count, checker or review verdict, area off by over 1 %, or outline overlap off by over 0.005. Plane-fit noise in the last decimals is not material |
| runtime | per house, the median of its four runs; the cohort's p50 and p95 over houses. Gates compare p95 divided by a calibration time (a fixed arithmetic loop timed on the same machine in the same run) so a slower or busier machine does not fake a slowdown |

A house counts toward the truth medians only when it is **comparable**: its outline overlaps the key's by at least
0.5 and (EagleView) the report measured one structure. A report for another building, or two, is shown but never
averaged.

## Cohorts

`--cohort NAME`. Counts are in the manifest (`npm run roof3d:bench -w @roofline/api -- --counts`).

| cohort | rule |
| --- | --- |
| `all` | every house |
| `canopy-heavy`, `canopy-light`, `canopy-none`, `canopy-any` | see below |
| `simple`, `complex` | simple: at most 6 EagleView faces; without EagleView, at most 5 Google roof segments of 2 m² of ground or more (calibration: on the 34 EagleView houses "Google ≤ 4, 5 or 6" agrees with "EagleView ≤ 6" on 31, the best of any limit; the middle one is used) |
| `lowslope` | a face of 80 sq ft or more at 3/12 or less (EagleView faces, or Google segments when there is no report) |
| `steep` | the area-dominant pitch is 10/12 or more |
| `state-XX` | the state in the address |
| `truth-eagleview`, `truth-visual`, `truth-proxy`, `has-truth` | the truth grade |
| `truth-lidar` | the house has accepted lidar truth (`lidar/index.json`; an EagleView house can have it too) |
| `set-testset`, `set-testset-ev`, `set-testset-trees` | where the house came from |
| `split-dev`, `split-heldout` | the split |

**Canopy.** Measured once, on Google's own layers and mask (so it never moves when the reconstruction does), and
frozen in the manifest. A pixel is *tree-like* when it is green in the photo (2G − R − B ≥ 20, the estimator's
vegetation test) and rough in the height map (|4z − the four neighbours| ≥ 0.12 m, the estimator's tree test: a
roof plane is smooth, foliage is not, a green roof is smooth). Foliage is a texture, so only a few percent of a
crown's pixels pass both; a pixel is *crown* when at least 10 % of the pixels within 0.7 m of it are tree-like. That
also drops single noisy pixels. Then, on Google's mask part under the house:

- `rimShare`: the share of mask-edge pixels with a crown pixel within 1 m. Trees where the outline has to be found.
- `roofShare`: the share of mask pixels that are crown. Foliage Google's mask took for roof.
- `biteShare`: crown pixels inside the mask part's convex hull but outside the mask, over the hull. A crown that
  hides roof leaves a notch in the mask.

Heavy: `rimShare` ≥ 0.30 or `roofShare` ≥ 0.03 or `biteShare` ≥ 0.10. Light: ≥ 0.10, 0.01, 0.03. None: below.
Why these numbers: 0.30 of the outline is roughly one full side of a rectangular house plus its corners; 0.10 is a
corner or a stretch of eave. The 305 Ridgeway Dr house (two edges under overhanging branches) is 0.31. The sensitivity
of the class counts to each constant is in "Sensitivity" below.

## Truth grades

- **eagleview**: a real EagleView report is the answer key: faces with pitch and area, the outline (their union), the
  total sloped area, line lengths. Full metrics.
- **visual**: an outline drawn by hand on a leaf-off orthophoto (`visual.json`: `{outline: [[lng,lat]...], toleranceM,
  source}`), outline metrics only. The harness supports it; **no house has one yet** (see "What is not done").
- **lidar**: an outline, plane pitches and areas from USGS 3DEP lidar, built outside the product and accepted per house
  by its own checks (see "Lidar truth"). A second answer key: it is merged in from `lidar/index.json` when the bench
  loads, so it sits beside a house's EagleView key, and `manifest.json` (and its hash) does not change. The manifest
  schema accepts `lidar` as a house's main grade too, for a future manifest.
- **proxy**: no truth exists and none is invented. Only proxies, always labelled as such:
  `maskIoU` (our outline against Google's roof mask part under the house, on the mask's own grid), `boxIoU` (our
  outline's bounding box against Google's building box), `googleAreaPct` (our plan area against Google's whole-roof
  ground area, percent), `segmentFaceRatio` (our faces over Google's roof segments), `osmIoU` (our outline against an
  OpenStreetMap building outline, tree houses only). They are weak: none is the roof's true outline, and Google's
  mask itself is what can be wrong under trees. Use them to notice change, not to claim accuracy. The Microsoft
  footprint is loaded in the product's database, not in this folder, so it is not used.

## Split

HELD-OUT when `sha1(slug)`, read as one big-endian integer, mod 10 is below 3; otherwise DEV. A pure function of the
name, frozen in the manifest (the manifest is refused when a house's split breaks it), so adding houses never moves
one. Default runs show dev only. `--split heldout` prints aggregates only, and only for cohorts of at least 5 houses
(a smaller aggregate is one or two houses' numbers). Per-house held-out output needs `--reveal` and belongs to the
integrator and verifiers: do not tune on it. `--house` of a held-out house is refused without `--reveal` too.

## Gates

`gates.json`, enforced by `--compare`, per cohort, on the mean over seeds:

| gate | limit |
| --- | --- |
| median outline IoU | may not fall by more than 0.005 |
| median mean boundary distance | may not rise by more than 0.05 m |
| median \|area error\| | may not rise by more than 0.5 points |
| houses passing every checker target | may not fall |
| slivers (under 25 sq ft), steep junk | may not rise |
| failed or no-roof houses | may not rise |
| determinism | every house byte-identical on a rerun (absolute) |
| runtime p95 | at most 1.5 × the baseline's, after the calibration |
| thin faces (added by the bench) | may not rise, in `simple`, `canopy-heavy` and `canopy-light` only |
| lidar (gates-v3) | median IoU and boundary distance against lidar truth, median sloped area error, and the hidden-edge shares within 0.5 m and mean distances (see "Lidar truth"); skipped under 3 lidar houses or 50 edge samples |

Two rules the owner's list did not have, both from an A/A test (the same code at other seeds against the baseline):

- **Seed noise.** The same code at seeds 10, 11, 12 instead of 7, 8, 9 failed 17 of the strict gates (all of them
  checker-pass and thin-face counts, in cohorts where one house is a point), and at seeds 20, 21, 22 three more. A
  change that merely reshuffles the random stream would fail them the same way. So each number may move by the
  larger of its limit and **the baseline's own range over seeds 7, 8, 9** (`"seedNoise": "baseline-range"`); a number
  with no seed spread (zero slivers at every seed, an IoU the seed does not touch) keeps its limit exactly.
  `"seedNoise": "none"` restores the strict limits.
- **Small cohorts.** A cohort under 10 houses (in the baseline or the run) is reported but not gated, except for
  determinism and failures (`"minCohortHouses": 10`).

With both, the same code at seeds 10-12, 20-22 and 30-32 passes every gate (dev 174 pass, held-out 109, none fail).
The price is power: a real regression smaller than the baseline's seed range goes unnoticed. Over all dev houses
that is about 2 houses of checker passes (the area error keeps its 0.5-point limit: its seed range is only 0.2); in
the canopy-heavy cohort 1 house of checker passes and 5 thin faces. A failure is printed with both seed ranges, and
says when they overlap.

Truth gates are skipped (and the report says how many) in a cohort with fewer than 3 comparable houses. A baseline
made from a different manifest, or at other seeds, is refused. Freeze a new baseline whenever the house set or a
cohort threshold changes on purpose: `npm run roof3d:bench -w @roofline/api -- --split all --base <sha> --json
/Users/parsasalahshori-a/RooflineWork/roof-bench/baseline.json`. `--base` records which commit's reconstruction the
run claims to measure and which reconstruction files differ from it.

## Lidar truth

Design note, validation against EagleView, sensitivity and the baseline numbers: [truth.md](truth.md).

Where the canopy hides the eave, Google's height map cannot say where the roof ends, and neither EagleView (8 of the 21
canopy-heavy houses) nor anything else could, so last round's finding (54 % of the canopy-exposed outline unverified,
3.1 times the disagreement there) could not be turned into a number to improve. Leaf-off airborne lidar sees the roof
between bare branches. The tools in `scripts/roof-bench-lidar/` (Python 3 with `laspy[lazrs]`, numpy, scipy, shapely,
pyproj, scikit-image, tifffile; the venv is `/Users/parsasalahshori-a/RooflineWork/venv`) build it, in order:

```
python -I scripts/roof-bench-lidar/coverage.py         # 3DEP index + TNM + EPT: which projects cover each house
python -I scripts/roof-bench-lidar/fetch.py            # EPT nodes or LAZ tiles, cropped to 70 m (lidar/ledger.json)
python -I scripts/roof-bench-lidar/lidar_truth.py      # an outline and planes per house and project
python -I scripts/roof-bench-lidar/choose.py           # one project per house, by the truth's own checks
python -I scripts/roof-bench-lidar/validate.py [dev]   # against EagleView, grades -> lidar/index.json
python -I scripts/roof-bench-lidar/validation_table.py # the validation table in truth.md
python -I scripts/roof-bench-lidar/sensitivity.py DIR  # the +-20 % table in truth.md (dev houses)
```

They read Google's height map and building box for two things only (a rigid frame shift onto Google's frame, and a
check that the house did not change between the captures) and never import the product's reconstruction. 40 of the
84 houses have accepted lidar truth (dev 26, held-out 14; canopy-heavy 11, tree houses 16).

Against it the bench scores, per house, in Google's frame:

| metric | definition |
| --- | --- |
| lidar IoU, boundary, HD95 | as for EagleView, against the lidar outline (registered once to Google's frame, so no per-reconstruction shift) |
| lidar aligned IoU | after the best translation within 3 m, as EagleView's aligned metric (for comparison; should be close to the raw) |
| plan, sloped area error | (ours - lidar) / lidar, percent: our outline's plan area, our faces' sloped area against the lidar planes' |
| main pitch | the area-dominant whole x/12 of the lidar planes. Weaker than the outline on complex roofs (truth.md) |
| hidden edges | our outline sampled every 0.2 m; the samples whose eave support (`eave-support.ts`, Google's height map) is `none`; each one's distance to the lidar outline. Pooled per cohort: samples, mean metres, share within 0.5 m |
| visible edges | the other samples of our outline, the same way |
| truth-hidden edges | the lidar outline's samples whose eave support on Google's height map is `none`, each one's distance to our outline: the stretches the canopy hides, fixed by the truth, so a change cannot move samples out of the set |

The run prints the lidar truth's fingerprint; `--compare` refuses a baseline scored against different lidar truth
(like a different manifest). Without `lidar/index.json` nothing changes: no house has lidar truth and the lidar gates
skip.

## Adding a house

1. Free sources first if the house is for the tree cohort: `roof3d:bench-candidates` ranks leafy neighbourhoods'
   houses from OpenStreetMap outlines and USGS NAIP imagery (both free).
2. Buying Google's layers: `roof3d:bench-fetch` (without `--go` it only prints the plan). It is capped by
   `fetch-ledger.json`: at most 40 Data Layers requests and 90 buildingInsights requests, **ever** (raise them
   with `--max-layers` / `--max-insights` only when the owner has said to). It requires HIGH imagery, the building
   to be the house, 900 to 6,000 sq ft and a pitched main roof, then buys one Data Layers request at 0.1 m.
   Keys come from `.env.keys` and are never printed.
3. Or by hand: a folder `testset-trees/<slug>/` with `dsm.tif`, `mask.tif`, `rgb.tif`, `bi.json`, `meta.json` and an
   `info.json` (`{slug, address, lat, lng, state, metro, downloadedAt: "YYYY-MM-DD"}`). An EagleView answer key is
   `eagleview.json` (see `bench/roof3d/truth.ts` for the schema; `ev_truth.py` in `saved-testdata` builds it).
4. `npm run roof3d:bench-manifest -w @roofline/api` adds new folders to the manifest (existing houses are never
   touched), computes their tags and split. `--explore` prints canopy numbers and writes nothing.
5. Freeze a new baseline.

**Google's 30-day rule.** The Solar API terms allow keeping its data for 30 days. Every house records
`downloadedAt` and `deleteBy`; the benchmark refuses to run (exit 3) on a house past `deleteBy` and prints the
earliest date at the top of every run. Delete the folder, or pass `--allow-expired` for a single run. The
first 54 houses were copied together and their real download dates were not recorded: their `deleteBy` is the
earliest plausible date (2026-10-11 plus 30 days). Nothing in this folder may be published, committed or sent
anywhere; reports hold derived numbers only.

## The baseline

`baseline-v3.json` (outline round) is frozen with the hidden-edge default on (`ROOF_3D_ALGORITHM_VERSION` 4, commit
`13268915`, lidar truth `8dec0f5758c3`); use it with `gates-v3.json`. `baseline-v3-dense.json` is the same
reconstruction scored with `ROOF3D_BENCH_SUPPORT=dense`. Its numbers and every change against v2 are in
[outline-release-notes.md](outline-release-notes.md).

`baseline-v2.json` (lidar-truth round) is frozen at the reconstruction of `c606b7a4` with lidar truth `8dec0f5758c3`; its
lidar and hidden-edge numbers are in [truth.md](truth.md). Compare with `--compare
/Users/parsasalahshori-a/RooflineWork/roof-bench/baseline-v2.json --gates
/Users/parsasalahshori-a/RooflineWork/roof-bench/gates-v3.json`. The older baseline below is kept for its history.

Frozen at the reconstruction of `5cabb413` (the harness commit differs from it only by the optional `seed` on
`roofOnLayers`; `baseline.json` records both). 84 houses: 54 dev, 30 held-out. Cohort counts (dev / held-out / total):

| cohort | dev | held-out | total | cohort | dev | held-out | total |
| --- | --- | --- | --- | --- | --- | --- | --- |
| all | 54 | 30 | 84 | simple | 13 | 9 | 22 |
| canopy-heavy | 10 | 11 | 21 | complex | 41 | 21 | 62 |
| canopy-light | 31 | 6 | 37 | lowslope | 22 | 10 | 32 |
| canopy-none | 13 | 13 | 26 | steep (10/12 or more) | 15 | 3 | 18 |
| canopy-any | 41 | 17 | 58 | truth-eagleview | 18 | 16 | 34 |
| set-testset (20) | 16 | 4 | 20 | truth-proxy | 36 | 14 | 50 |
| set-testset-ev (34) | 18 | 16 | 34 | set-testset-trees | 20 | 10 | 30 |

By state (dev + held-out): AR 19, TX 8, NC 7, CA 6, GA 6, MO 5, WA 5, SD 4, FL 3, OR 3, NJ 2, TN 2, and one each of
AL, AZ, CO, CT, DC, IA, ID, IN, MI, NE, NY, UT, VA, WI.

Dev split, mean over seeds 7, 8, 9 (a range in brackets where the seeds disagree). "key" = houses with an EagleView
report that are the same single building:

| cohort | n | key | IoU | boundary m | HD95 m | \|area\| % | area ≤ 5 % | main pitch = / ±1 | face pitch | checker pass | thin faces |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| all | 54 | 18 | 0.782 | 0.91 | 1.92 | 4.0 [3.9-4.1] | 11 | 12 / 15 | 0.62 | 34 of 54 | 62 |
| canopy-heavy | 10 | 2 | 0.721 | 1.11 | 2.24 | 1.0 | 2 | 2 / 2 | 0.23 | 6 of 10 | 10 |
| canopy-light | 31 | 12 | 0.782 | 0.99 | 2.46 | 4.0 | 8 | 7 / 9 | 0.64 | 19 of 31 | 33 |
| canopy-none | 13 | 4 | 0.820 | 0.76 | 1.64 | 6.7 | 1 | 3 / 4 | 0.91 | 9 of 13 | 19 |
| complex | 41 | 17 | 0.784 | 0.88 | 1.72 | 3.9 | 11 | 12 / 14 | 0.68 | 22 of 41 | 58 |
| simple | 13 | 1 | 0.740 | 0.98 | 4.00 | 13.8 | 0 | 0 / 1 | 0.49 | 12 of 13 | 4 |
| lowslope | 22 | 8 | 0.797 | 0.80 | 1.62 | 2.9 | 7 | 6 / 7 | 0.65 | 11 of 22 | 30 |
| steep | 15 | 10 | 0.797 | 0.88 | 1.70 | 3.5 | 9 | 6 / 8 | 0.90 | 5 of 15 | 35 |
| set-testset-trees | 20 | 0 | - | - | - | - | - | - | - | 13 of 20 | 12 |

Held-out aggregates (30 houses; 16 have an EagleView report, 14 of them for the same single building): outline IoU
0.797, boundary 0.82 m, HD95 1.85 m, median \|area error\| 3.1 %, main pitch exact 9 of 14, 20 of 30 pass the checker.
Cohorts under 5 houses are withheld.

Line totals against EagleView over the 18 dev key houses: ridge -23.9 %, hip -0.1 %, valley +24.6 %, eave -23.1 %,
rake -2.7 %. (Over all 34 EagleView houses the earlier round quoted ridge -20 %, hip -7 %, valley +16 %, eave -25 %,
rake +1 %; the dev split holds 18 of them, so its totals differ.)

What the baseline says about the problem the benchmark was built for:

- **No sliver faces and no steep junk in any house** (the checker's 25 sq ft and 18/12 rules hold), so those gates
  start at zero. The owner's complaint is the faces over 25 sq ft that are under a metre wide: 62 across the dev
  houses. They are not concentrated under trees by this measure: 1.0 a house in the 10 canopy-heavy houses, 1.1 in
  the 31 light, 1.5 in the 13 none (complex roofs have real narrow faces), so the thin-face gate is applied only to
  simple roofs and the two canopy cohorts, and a thin face on a simple, tree-covered roof is the number to watch.
- **The review flag is nearly always on**: 69 % of dev houses are flagged, and of the 18 key houses 17 are flagged
  and 28 % of the flags are right. Recall is 1.00: it flags everything that is wrong, and most that is not.
- **Seeds matter more than expected.** 28 of the 54 dev houses give a materially different reconstruction at another
  seed (13 of 18 key houses). Over all dev houses that moves the median area error between 3.9 and 4.1 %, main pitch
  exact between 11 and 13 of 18, median face pitch error between 0.57 and 0.69 (small cohorts move more: the 4
  canopy-none key houses run 6.0 to 7.2 % area error). Outlines do not move with the seed in the dev split (no range
  on IoU or boundary distance); in the held-out split one cohort's IoU does, where a terrace cut depends on the planes.
  Re-running a house at the same seed is byte-identical (0 of 54 differ). A gate of 0.5 points of area error is
  therefore about two and a half times the seed noise of the whole set, and the gate means are over three seeds.
- Runtime: p50 197 ms, p95 628 ms a house (dev), calibration loop 21 ms on this machine.

## Cross-check against the earlier scorer

On the 34 EagleView houses at seed 7, the TypeScript scorer against `ev_score.py` run on the old checker's output:
face counts equal on all 34; main pitch (ours and EagleView's) equal on all 34; IoU within 0.005 (Python prints two
decimals); area error within 0.05 points (one decimal); per-face pitch error within 0.005; shares within 0.5 of a
percent (rounded to a whole percent); line totals within 0.5 ft (Python rounds each house to whole feet). The Python
summary on the same data (area median 4.0 %, main pitch exact 20 of 32 and within 1/12 on 29, ridge -20 %, hip -7 %,
valley +16 %, eave -25 %, rake +1 %) matches the figures the previous round quoted. Separately, at the pristine
`5cabb413` the old checker and the benchmark give the same faces, sloped area (within 0.1 sq ft), review reasons,
outline vertices, sliver, steep and pass verdicts on all 54 houses (35 pass).

## Sensitivity of the harness's own constants

`npm run roof3d:bench-sensitivity -w @roofline/api` moves each constant by -20 % and +20 % and shows what it
feeds. Dev split (54 houses), seed 7. Class counts are canopy heavy / light / none; "moved" is the number of houses
that change class against the values in use (heavy 10, light 31, none 13).

| constant (value in use) | -20 % | +20 % | houses moved |
| --- | --- | --- | --- |
| green: 2G - R - B at least (20) | 14 / 30 / 10 | 8 / 27 / 19 | 7 and 8 |
| rough: second difference (0.12 m) | 13 / 30 / 11 | 10 / 28 / 16 | 5 and 3 |
| crown: tree-like share of the window (0.10) | 13 / 30 / 11 | 9 / 28 / 17 | 5 and 5 |
| crown window half-width (0.7 m) | 13 / 30 / 11 | 10 / 28 / 16 | 5 and 3 |
| rim reach (1.0 m) | 8 / 28 / 18 | 12 / 29 / 13 | 7 and 2 |
| heavy: rim share (0.30) | 16 / 25 / 13 | 9 / 32 / 13 | 6 and 1 |
| light: rim share (0.10) | 10 / 32 / 12 | 10 / 29 / 15 | 1 and 2 |
| heavy: roof share (0.03), bite share (0.10) | no change | no change | 0 |

Reading it: the canopy cohorts are not sharp. A 20 % move of any constant sends 1 to 8 of the 54 houses to another
class (the heavy cohort moves between 8 and 16 houses); the green test and the rim reach matter most. The roof-share
and bite-share limits do not change a dev class (on these 54 houses every house over them is already heavy by its rim
share); they are there for the case the owner's second screenshot shows, a canopy hiding most of the roof, and only
the tree houses reach them (biteShare 0.11 to 0.13 on three of the new houses). Use the cohorts for direction.

Scoring constants (dev, seed 7; the values in use and the medians they feed):

| constant (value in use) | -20 % | +20 % | feeds |
| --- | --- | --- | --- |
| thin face width, 0.9 m | 18 thin faces | 117 thin faces (65 in use) | the thin-face count and gate: very sensitive, because many real faces are 0.8 to 1.1 m wide; the gate compares a change with the baseline under the same constant |
| rectilinearity tolerance, 5° | median 0.785 | median 0.792 (0.792 in use) | the rectilinearity median |
| boundary sampling step, 0.2 m | boundary 0.909, HD95 1.923 | 0.907, 1.921 (0.907, 1.921 in use) | the boundary distances: the step does not matter |
| face match, minimum 100 sq ft | face pitch error 0.721, within 1/12 84.8 % | 0.573, 87.6 % (0.618, 85.4 % in use) | the per-face pitch figures move by about 0.1 |
| face match, minimum overlap 0.3 | 0.632, 84.6 % | 0.621, 88.0 % | the per-face pitch figures: small |

Outline IoU does not depend on any harness constant (it is a polygon overlap), and the area, main pitch and line
totals do not either: those are the numbers to hold a change to.


## What is not done, and what to trust less

- **No visual truth.** The leaf-off Pulaski County 2024 orthophoto works as a source (its public ArcGIS REST export
  returns high-resolution, leaf-off imagery, and `visual.json` is scored by the harness), but I could not draw
  outlines I would trust: of the crops I looked at (305 Ridgeway Dr and 909 E H Ave) the roofs are partly in tree
  shadow, the photo is not true ortho (up to about 0.8 m of lean), and my corner placement from a rendered grid in the
  dark parts is not good to the 0.6 m tolerance the grade promises. A wrong truth is worse than none. A person drawing
  the outline of eight of the Little Rock and North Little Rock houses would settle it.
- **Tree houses have little truth.** Lidar truth now covers 16 of the 30 tree houses and 11 of the 21 canopy-heavy
  houses (truth.md); the rest are still judged by proxies (mask, box, Google area, segment ratio, OSM outline) and by
  counts. Only 2 canopy-heavy dev houses and 6 held-out ones have an EagleView key.
- **The NAIP pre-screen over-predicts canopy.** Of the 30 houses bought with it, 10 came out canopy-none by Google's
  own photo and 7 canopy-heavy (13 light); of the 54 older houses 14 are heavy. NAIP is summer imagery on another
  date and registration than Google's, and its own crown rule is only an NDVI-and-darkness guess.
- **No Microsoft footprint** (it lives in the product database), and only the 30 tree houses have an OSM outline.
- **No hard per-house time limit.** The reconstruction is synchronous; a runaway house would stall the run. The p95
  runtime gate and the per-house runtime catch slowness after the fact.
- **Gates on small cohorts are skipped, not passed.** Under 3 comparable houses the truth gates say so.
- **The first 54 houses' download dates are unknown** (see "Adding a house").
- The dev split holds 54 houses of which only 18 have an answer key; medians over 18 houses move by a house or two
  with any change. Read direction, not decimals.
