# Design note: lidar truth for outlines under trees (track `truth`)

## Problem

Last round's failure taxonomy found that trees are an edge problem: where Google's height map shows the eave drop,
our outline is close to EagleView's (aligned IoU about 0.93), but 54 % of the canopy-exposed outline has no height
support (eave support `none`), and there EagleView disagrees by more than 0.5 m 3.1 times as often. Nobody could
measure a fix, because truth under trees did not exist: of the 21 canopy-heavy houses only 8 have an EagleView
report, the 30 tree houses have none, and the hand-drawn `visual` grade was never filled (an orthophoto does not show
an eave under a crown either). A method that hallucinated a straight eave under every tree and one that left the
jagged mask edge would have scored the same.

## Approach

Independent truth from USGS 3DEP airborne lidar (public domain). Much of it is flown leaf-off; pulses reach the roof
between bare branches, and a last return on a roof plane under a branch is exactly what Google's leaf-on
photogrammetry cannot see. Everything is built outside the product: the tools are Python in
`scripts/roof-bench-lidar/` (venv `/Users/parsasalahshori-a/RooflineWork/venv`, Python 3.14, `laspy[lazrs]` 2.7,
numpy, scipy, shapely, pyproj, scikit-image, tifffile), the data under `<ROOF_BENCH_DIR>/lidar/`, and none of it
imports or ports `roof-reconstruct`.

1. **Coverage** (`coverage.py`). For each house: the 3DEP Elevation Index work units over the point (layer 8: project,
   flight dates, quality level), the TNM Access LPC tiles that hold it, and the Entwine EPT resources (hobu
   `resources.geojson`) that contain it. 81 of 84 houses have QL2-or-better lidar (the two Raleigh tree houses and
   one Raleigh EagleView house have only a 2001 QL-less collect).
2. **Fetch** (`fetch.py`). Every usable work unit (QL0-QL2, published point cloud) of every house: EPT octree nodes
   that meet a 70 m square round the house when the project is in EPT (a few MB), otherwise the LAZ tile, downloaded
   once into `lidar/tiles/` with parallel byte ranges (the server gives each connection about 0.3 MB/s) and cropped.
   Crops are `lidar/<slug>/units/<work unit>/points.npz` in the house's WGS84 UTM zone with a `fetch.json` (project,
   QL, flight dates from the points' own GPS times, CRS, units). Ledger: `lidar/ledger.json`, 3.84 GB in all (119 crops,
   39 tiles). No Google request.
3. **Truth** (`lidar_truth.py`), per work unit:
   - ground: class 2 points on a 1 m grid (holes interpolated), height above ground per point;
   - candidates: 1.5 m or more above the ground, not ground, water or noise;
   - vegetation out by geometry: a point is planar when its neighbours within max(0.8 m, 2.5 x spacing) fit a plane to
     0.10 m rms (lidar noise plus flight-line offsets; a crown is 0.3 m and rougher); only last or only returns seed
     or carry a plane (a pulse that returned earlier went through a branch, or split on the eave's edge);
   - region growing of planes (normals within 12 degrees, 0.20 m of the plane, refit as it grows); planes under
     1 m2, steeper than 65 degrees or rougher than 0.12 m dropped; ridge, hip and eave points (whose neighbourhood
     straddles two planes) attached to the plane they lie on within 0.25 m, three rounds;
   - the house: the plane nearest the house point inside Google's building box (the box only picks the building),
     plus planes joined by a shared edge (8 points within max(1.2 m, 2 x spacing) in plan, spread over 1 m, at most
     3.5 m apart in height); only faces of 4 m2 or more carry the join further, so a chain of small patches between
     two houses (a shed, a vent, a branch fragment) never makes them one;
   - outline: the house's points on a 0.25 m grid, closed with a disk of max(0.75 m, 1.5 x spacing), holes filled,
     necks narrower than 2 m cut, grown by half the point spacing (the true eave lies on average half a spacing beyond
     the outermost roof return), traced and simplified by 0.10 m;
   - per plane: pitch and azimuth from the fitted normal, plan and sloped area (each outline cell to its nearest
     plane point);
   - frame: the lidar roofs (every planar roof point in the crop) are fitted to Google's height map by the translation
     within +-3 m that minimises the robust spread (MAD) of the height residuals; the outline is shifted by it once.
     The shape is never touched by Google's data. NAD83(2011) against WGS84 alone is about 1 m: the median shift is
     1.17 m, the median residual MAD 0.06 m.
   Expected edge error: half the roof point spacing plus half a 0.25 m cell (the median accepted house: 0.27 m).
   Deterministic: a rerun is byte-identical.
4. **Choice** (`choose.py`): among a house's work units, the one passing the truth's own checks (A1-A5 below), then the
   densest roof sampling, then the newest. EagleView never enters the choice.
5. **Acceptance** (`validate.py`, `lidar/index.json`), grade `lidar` when:
   - A1 the frame registration found a fit: residual MAD <= 0.20 m, not at the search limit, and well conditioned (the
     fit worsens by 1 cm or more half a metre off it along either axis; one long gable alone does not pin the frame
     along its ridge, as the synthetic test shows);
   - A2 the truth's expected edge error <= 0.30 m (60 % of the 0.5 m the hidden-edge metric judges at: 8 roof returns
     per m2; QL2's nominal 2 per m2 gives 0.48 m, as coarse as the error it would judge);
   - A3 edges observed: along at least 85 % of the outline, lidar has a return 0.3-1.5 m outside it at least 1 m below
     the roof's edge (it saw past the eave; under leaf-on canopy it does not, so leaf-on lidar is rejected under trees
     by measurement, not by calendar);
   - A4 no change between the lidar flight and Google's capture: Google's heights at the ground over at most 10 % of
     the lidar roof, lidar ground under at most 10 % of Google's roof-high cells in its building box, median roof
     height difference at most 0.5 m;
   - A5 sanity: at least 40 m2, footprint between 0.4 and 2.5 times Google's building box;
   - A6 where an EagleView report of one structure exists: aligned outline IoU >= 0.85.
6. **Bench** (`apps/api/src/bench/roof3d/lidar.ts`): the index's grades are merged into the manifest when the bench
   loads (manifest.json and its hash do not change, cohort `truth-lidar`), and every reconstruction of a graded house
   is scored against the lidar outline in Google's frame: IoU, boundary distance, HD95, plan and sloped area, main
   pitch, the aligned IoU (best translation within 3 m, as for EagleView) for comparison, and the hidden-edge sets:
   - **hidden**: our outline's samples (0.2 m) whose eave support (`eave-support.ts`, the product's own evidence, on
     Google's height map, crown map not needed for the class) is `none`, measured to the lidar outline;
   - **visible**: the rest of our samples, the same way (the contrast);
   - **truth-hidden**: the lidar outline's samples whose eave support on Google's height map is `none`, measured to our
     outline. This set does not move with the reconstruction (a change that makes a hidden stretch look supported
     moves samples between hidden and visible; it cannot move them out of truth-hidden).
   Each is pooled per cohort (sample count, mean distance, share within 0.5 m). Gates: `gates-v3.json` (below).

## Validation of the truth itself (against EagleView)

Every EagleView house with a lidar outline (31 of 34; the 34th has no usable lidar), by what the checks say. Aligned
IoU, mean boundary distance after that alignment and sloped area are lidar against EagleView; main pitch is whole x/12.
EagleView is a different date and a human-checked product, so perfect agreement is not expected; the medians of two
good independent outlines of a house are about 0.92 IoU.

| set | EV houses | aligned IoU (median) | boundary m (median) | abs sloped area err % (median) | signed % | main pitch exact / within 1 / n | IoU >= 0.85 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| dev: every EV house with a lidar outline | 18 | 0.840 | 0.60 | 16.9 | -10.4 | 15/15/18 | 8/18 |
| dev: passing the truth's own checks (A1-A5) | 6 | 0.923 | 0.37 | 5.7 | -4.1 | 5/5/6 | 6/6 |
| held-out: every EV house with a lidar outline | 13 | 0.863 | 0.66 | 21.0 | -21.0 | 9/11/13 | 7/13 |
| held-out: passing the truth's own checks (A1-A5) | 7 | 0.930 | 0.21 | 3.1 | -0.1 | 6/7/7 | 7/7 |
| all: every EV house with a lidar outline | 31 | 0.843 | 0.62 | 18.2 | -13.9 | 24/26/31 | 15/31 |
| all: passing A1-A5 (= accepted: no house fails A6 alone) | 13 | 0.927 | 0.28 | 5.1 | -0.5 | 11/12/13 | 13/13 |
| all: A1-A5, canopy-heavy | 5 | 0.956 | 0.14 | 0.5 | -0.2 | 4/5/5 | 5/5 |
| all: A1-A5, canopy-light | 5 | 0.919 | 0.48 | 8.0 | -5.1 | 4/4/5 | 5/5 |
| all: A1-A5, canopy-none | 3 | 0.888 | 0.47 | 6.2 | +2.2 | 3/3/3 | 3/3 |

What it says:

- **The checks are what makes lidar usable.** Unfiltered, half the EagleView houses disagree (sparse QL2 data from
  2014-2020, changed houses). The houses the checks accept without looking at EagleView (A1-A5) agree with EagleView
  on 13 of 13 (held-out 7 of 7), and best under heavy canopy (median 0.956 IoU, 0.14 m), which is what the grade is
  for.
- **How it got there, honestly.** Before the frame-conditioning part of A1 existed, one A1-A5 house disagreed:
  ev-52191985 (Beaverton OR, dev), flown August 2024, whose lidar roof includes a covered patio the EagleView outline
  does not (A4 cannot see it: Google, 2023, sees the patio cover as elevated too). The conditioning rule was added
  because of a synthetic test (a lone gable cannot pin the frame along its ridge), not for this house, and it happens
  to reject it (its fit improves by 3 mm, under the 1 cm floor). The patio is still a real-world change no check can
  see: expect about 1 in 14 accepted houses without EagleView to be a different roof from the one EagleView would
  draw. Read single-house numbers with that in mind.
- **Area is weaker than the outline.** ev-47747994 (Boca Raton, held-out) passes everything with 0.863 IoU and a
  -25.6 % sloped area; ev-47738131 (Norwalk CT, a large complex roof) has 0.919 IoU, -13.9 % area and a main pitch of
  10/12 against EagleView's 12/12. Lidar plane areas on many-faceted roofs are the least trustworthy part of the
  truth; the bench reports lidar area and pitch but gates only the outline, its boundary, the sloped area median and
  the hidden edges.

Per house (all 34 EagleView houses; grade and reasons from `lidar/index.json`):

| house | split | canopy | lidar (project, month) | roof pts/m2 | aligned IoU | bnd m | sloped % | pitch lidar/EV | grade |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| ev-47737198 | dev | light | NC Phase 4 CentralWest 2016-03 | 12.64 | 0.946 | 0.24 | -2.9 | 12/12 | rejected (A1, A4) |
| ev-47738131 | dev | light | CT 2023 Statewide 2023-03 | 25.92 | 0.919 | 1.30 | -13.9 | 10/12 | lidar |
| ev-47743011 | held-out | none | TX Pecos Dallas 2019-04 | 4.98 | 0.824 | 0.66 | -21.0 | 8/8 | rejected (A2, A6) |
| ev-47747994 | held-out | light | FL Palm Beach 2016 (2017-01) | 11.37 | 0.863 | 0.69 | -25.6 | 6/6 | lidar |
| ev-47926585 | held-out | heavy | CA NorthernCA B22 2022-10 | 18.75 | 0.956 | 0.12 | -0.2 | 5/5 | lidar |
| ev-49607192 | held-out | heavy | Wasatch Fault UT 2013-10 | 22.48 | 0.035 | 9.95 | -97.3 | 1/10 | rejected (A1, A3, A4, A5, A6) |
| ev-49611661 | held-out | heavy | IA Western 2020 (2021-03) | 4.54 | 0.174 | 5.24 | -82.3 | 5/6 | rejected (A2, A3, A5) |
| ev-50264667 | held-out | heavy | NY 3County 2019-05 | 17.92 | 0.964 | 0.11 | +5.1 | 6/5 | lidar |
| ev-50264843 | dev | none | NJ NW 6 County 2018-04 | 2.15 | 0.878 | 0.49 | -6.8 | 7/7 | rejected (A2, A3, A4, A5) |
| ev-50288987 | held-out | heavy | AL 19County B24 2024-12 | 31.56 | 0.941 | 0.20 | -0.1 | 8/8 | lidar |
| ev-50319630 | dev | light | SD EasternSD 2020-04 | 10.54 | 0.927 | 0.28 | -3.1 | 6/6 | lidar |
| ev-50319846 | dev | light | SD EasternSD 2020-04 | 4.63 | 0.757 | 1.22 | -27.5 | 8/12 | rejected (A2, A3, A6) |
| ev-50332002 | held-out | none | FL MiamiDade D23 2024-02 | 9.54 | 0.421 | 2.36 | -58.1 | 2/2 | rejected (A3, A4, A5, A6) |
| ev-51881663 | dev | light | CA FEMA Levee D23 2023-05 | 20.83 | 0.905 | 0.48 | +8.0 | 5/5 | lidar |
| ev-51881772 | held-out | none | WA DNR 3DEP 2019-04 | 19.82 | 0.917 | 0.32 | +2.2 | 8/8 | lidar |
| ev-51881820 | dev | light | IN Statewide 2017-03 | 2.49 | 0.833 | 0.58 | +19.3 | 6/6 | rejected (A2, A6) |
| ev-51881844 | held-out | light | WI Statewide 2021-04 | 5.08 | 0.364 | 5.95 | -60.5 | 13/9 | rejected (A1, A2, A3) |
| ev-51881922 | dev | light | MI Wayne County 2017-04 | 6.74 | 0.843 | 0.53 | -18.2 | 8/10 | rejected (A2, A6) |
| ev-51881964 | held-out | light | none (2001 only) | - | - | - | - | - | none |
| ev-51882178 | dev | light | VA Hampton Roads B23 2024-01 | 11.64 | 0.952 | 0.17 | -5.1 | 7/7 | lidar |
| ev-51882232 | dev | light | MO FEMA NRCS 2020-04 | 2.97 | 0.549 | 1.69 | -40.1 | 10/10 | rejected (A2, A3, A6) |
| ev-51882459 | held-out | none | CA California Gaps B23 2023-09 | 14.89 | 0.888 | 0.52 | +6.7 | 5/5 | lidar |
| ev-51882542 | dev | light | CA SoCal Wildfires 2018-08 | 4.31 | 0.546 | 2.87 | -46.1 | 12/12 | rejected (A2, A3, A5, A6) |
| ev-51883109 | dev | light | Delaware Valley QL2 2015-04 | 4.39 | 0.448 | 2.64 | -56.3 | 12/12 | rejected (A2, A3, A5, A6) |
| ev-51883255 | held-out | none | SD EasternSD 2020-04 | 4.27 | 0.488 | 2.07 | -35.7 | 8/12 | rejected (A2, A3, A5, A6) |
| ev-52191050 | dev | light | MO FEMA NRCS 2020-04 | 2.95 | 0.559 | 1.66 | -39.2 | 10/10 | rejected (A2, A3, A6) |
| ev-52191132 | held-out | none | MO FEMA NRCS 2020-04 | 5.41 | 0.800 | 0.71 | -38.9 | 3/3 | rejected (A2, A6) |
| ev-52191405 | held-out | heavy | MO FEMA NRCS 2020-04 | 2.93 | 0.649 | 0.93 | -33.8 | 7/6 | rejected (A2, A6) |
| ev-52191672 | dev | none | GA Central 2019 (2020-01) | 7.78 | 0.733 | 0.90 | -27.2 | 8/8 | rejected (A2, A3, A6) |
| ev-52191863 | dev | none | GA Central 2019 (2020-01) | 2.01 | 0.049 | 6.90 | -95.2 | 12/12 | rejected (A2, A3, A5, A6) |
| ev-52191985 | dev | heavy | OR Portland Metro B24 2024-08 | 16.05 | 0.836 | 0.62 | +15.6 | 5/5 | rejected (A1 conditioning, A6) |
| ev-52192091 | held-out | heavy | SD EasternSD 2020-04 | 14.46 | 0.930 | 0.21 | -3.1 | 6/6 | lidar |
| ev-52192220 | dev | heavy | OR OLC Metro 2019-07 | 11.35 | 0.960 | 0.14 | -0.5 | 5/5 | lidar |
| ev-53863159 | dev | none | NC Phase 4 2017-02 | 14.02 | 0.884 | 0.47 | -6.2 | 12/12 | lidar |

## Coverage and acceptance

84 houses: 81 with QL2-or-better lidar, 40 accepted (dev 26, held-out 14). By canopy: heavy 11 of 21, light 15 of 37,
none 14 of 26. The 30 tree houses: 16 accepted (dev 10, held-out 6), 4 of their 7 canopy-heavy. 33 of the 40 are
leaf-off (every point flown November to April); the 7 leaf-on ones passed A3 (lidar saw past every eave). 36 are QL1,
4 QL2; 13 come from AR_Western_B24 (January to March 2025, Arkansas), the newest project and the reason the Little
Rock, Fort Smith and Hot Springs houses have truth. Median roof density 12.4 returns per m2, expected edge error
0.27 m. First reason a house is refused: density (A2) 25, frame (A1) 8, unobserved edges (A3) 3, change (A4) 3,
sanity (A5) 1, EagleView (A6) 1, no lidar 3 (before the conditioning rule; it rejects two houses already rejected:
ev-52191985 and ev-50332002).

305 Ridgeway Dr (lr-305-ridgeway, dev, canopy-heavy) is accepted (AR_Western_B24, 2025-01-08, 16.9 returns per m2,
every edge observed). The lidar roof continues about 7.6 m east of Google's building box under the crown; the
reconstruction at c606b7a4 overlaps it by 0.587 IoU with 38 % less plan area, and 23 % of its hidden-edge samples
are within 0.5 m of the lidar outline.

## Baseline at c606b7a4 (`baseline-v2.json`)

`npm run roof3d:bench -w @roofline/api -- --split all --base c606b7a4 --json .../baseline-v2.json` (bench code of
662d1095, made on the branch head; the reconstruction files are those of c606b7a4: `changedFiles` is empty). Lidar truth fingerprint
`8dec0f5758c3`, manifest `91e97810c22b`. Seeds 7, 8, 9; no lidar number moves with the seed.

| split | cohort | lidar houses | IoU | bnd m | abs sloped % | hidden samples | hidden mean m | hidden <= 0.5 m | visible <= 0.5 m | truth-hidden mean m | truth-hidden <= 0.5 m |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| dev | all | 26 | 0.870 | 0.49 | 7.9 | 2053 | 0.88 | 42 % | 86 % | 1.42 | 35 % |
| dev | canopy-heavy | 4 | 0.821 | 0.55 | 15.0 | 424 | 0.96 | 52 % | 95 % | 1.57 | 46 % |
| dev | canopy-light | 13 | 0.896 | 0.42 | 7.7 | 1133 | 0.89 | 34 % | 85 % | 1.04 | 32 % |
| dev | canopy-none | 9 | 0.848 | 0.62 | 8.2 | 496 | 0.78 | 53 % | 84 % | 1.86 | 32 % |
| dev | set-testset-trees | 10 | 0.807 | 0.64 | 17.1 | 927 | 1.03 | 35 % | 80 % | 1.34 | 29 % |
| held-out | all | 14 | 0.908 | 0.34 | 2.6 | 884 | 1.06 | 41 % | 90 % | 1.14 | 40 % |
| held-out | canopy-heavy | 7 | 0.875 | 0.40 | 7.9 | 502 | 1.13 | 37 % | 92 % | 1.17 | 39 % |
| held-out | canopy-none | 5 | 0.948 | 0.15 | 2.2 | 200 | 0.34 | 75 % | 90 % | 0.67 | 58 % |
| held-out | set-testset-trees | 6 | 0.857 | 0.52 | 11.3 | 515 | 1.31 | 32 % | 95 % | 1.37 | 33 % |

(Held-out canopy-light has 2 lidar houses; its aggregate is in the JSON only. Cohorts under 10 houses are not gated.)

The taxonomy's finding, now measured on 40 houses instead of a handful: where the heights show the eave, 86-90 % of
our outline is within 0.5 m of the lidar roof; where they do not, 41-42 %, and the lidar outline's own hidden stretches
are 1.1-1.4 m from ours on average. The reconstruction misses roof under canopy more than it invents it: the signed
sloped area against lidar is -15 % in dev canopy-heavy.

## Gates (`gates-v3.json`)

`gates-v2.json` plus a `lidar` block (also the default in `gates.ts`): per cohort, skipped under 3 comparable lidar
houses in either run (and the edge gates under 50 samples, 10 m of outline), with the baseline's seed range as room
like every gate:

| gate | limit |
| --- | --- |
| lidar: median outline IoU | may not fall by more than 0.005 |
| lidar: median boundary distance | may not rise by more than 0.05 m |
| lidar: median abs sloped area error | may not rise by more than 0.5 points |
| lidar: hidden edges within 0.5 m (share) | may not fall by more than 0.02 |
| lidar: hidden edges mean distance | may not rise by more than 0.05 m |
| lidar: truth-hidden edges within 0.5 m (share) | may not fall by more than 0.02 |
| lidar: truth-hidden edges mean distance | may not rise by more than 0.05 m |

A/A check: the same code at seeds 10, 11, 12 against `baseline-v2.json` with `gates-v3.json`: dev 331 pass, held-out
231 pass, none fail.

## Sensitivity (DEV houses only)

`sensitivity.py`: each truth constant at -20 % and +20 %, the truth rebuilt on the 27 dev houses' chosen units into a
scratch folder. Columns: houses passing A1-A5 (27 with the constants in use), median IoU of the moved outline with the
one in use (accepted houses), median aligned IoU against EagleView of the accepted EagleView houses.

Truth constants (each rebuilt on the 52 dev houses' chosen units; 27 pass A1-A5 with the constants in use):

| constant | houses passing A1-A5 | median IoU with the outline in use | median aligned IoU vs EagleView (houses) |
| --- | --- | --- | --- |
| in use | 27 | 1.000 | 0.919 (7) |
| PLANAR_RMS_M 0.10 x0.8 / x1.2 | 27 / 28 | 0.999 / 1.000 | 0.907 / 0.920 |
| GROW_ANGLE_DEG 12 x0.8 / x1.2 | 27 / 28 | 0.996 / 0.996 | 0.912 / 0.922 |
| GROW_DIST_M 0.20 x0.8 / x1.2 | 27 / 28 | 1.000 / 1.000 | 0.919 / 0.919 |
| ATTACH_DIST_M 0.25 x0.8 / x1.2 | 27 / 28 | 0.997 / 0.998 | 0.915 / 0.930 |
| LINK_M 1.2 x0.8 / x1.2 | 26 / 28 | 1.000 / 1.000 | 0.919 / 0.916 |
| MAX_STEP_M 3.5 x0.8 / x1.2 | 26 / 27 | 1.000 / 1.000 | 0.912 (6) / 0.917 |
| NECK_M 1.0 x0.8 / x1.2 | 27 / 27 | 1.000 / 1.000 | 0.919 / 0.919 |
| BIG_PLANE_M2 4.0 x0.8 / x1.2 | 27 / 27 | 1.000 / 1.000 | 0.927 / 0.919 |
| MIN_CLOSE_M 0.75 x0.8 / x1.2 | 27 / 27 | 1.000 / 0.995 | 0.919 / 0.922 |
| MIN_HAG_M 1.5 x0.8 / x1.2 | 27 / 27 | 1.000 / 1.000 | 0.919 / 0.919 |
| EDGE_DROP_M 1.0 x0.8 / x1.2 | 27 / 27 | 1.000 / 1.000 | 0.919 / 0.919 |

(This run predates the A1 conditioning rule, which changes no outline: hence 27 and 7 EagleView houses, against 26
and 6 in the final grades.) No truth constant moves an accepted outline by more than 0.5 % IoU at +-20 %.

Acceptance thresholds (dev, final grades; "agree" = the dev EagleView houses passing A1-A5 with IoU >= 0.85):

| rule | dev accepted | agree |
| --- | --- | --- |
| in use | 26 | 6/6 |
| A1 REG_MAD_M 0.20 x0.8 / x1.2 | 26 / 26 | 6/6, 6/6 |
| A2 MAX_EDGE_ERROR_M 0.30 x0.8 / x1.2 | 2 / 27 | 2/2, 6/7 |
| A3 MIN_EDGE_OBSERVED 0.85 x0.8 / x1.2 (capped at 1) | 28 / 15 | 6/6, 3/3 |
| A4 MAX_CHANGE 0.10 x0.8 / x1.2 | 25 / 27 | 6/6, 6/6 |
| A4 MAX_ROOF_DZ_M 0.5 x0.8 / x1.2 | 26 / 26 | 6/6, 6/6 |
| A6 EV_MIN_IOU 0.85 x0.8 / x1.2 | 26 / 20 | 6/6, 6/6 |

A2 is the sharp one: 0.24 m of expected edge error would need 15 roof returns per m2 and leaves 2 dev houses; 0.36 m
admits ev-51881922 (6.7 per m2), which disagrees with EagleView by 18 % of its area. A3 at 1.0 asks every 0.2 m of
outline to be seen past, which a downspout or a shrub defeats. The values in use sit where the EagleView agreement
holds and the coverage does not collapse.

## Alternatives rejected

- **Hand-drawn outlines on leaf-off orthophotos** (the `visual` grade): tried last round; corners in tree shadow and
  0.8 m of building lean could not be placed to the tolerance the grade promises.
- **Lidar truth scored against the product's own outline code**: circular; nothing here imports `roof-reconstruct`.
- **Using Google's mask or building box to delimit the truth**: the box only picks which building is the house; the
  outline may (and at 305 Ridgeway does) go past it. Google's height map is used for two things only, a rigid frame
  shift and the change check, never the shape.
- **Choosing a house's lidar by agreement with EagleView**: would make the EagleView validation circular; the choice
  uses the truth's own checks.
- **Leaf-off by calendar as the acceptance rule**: April is leaf-on in Arkansas and an evergreen is never leaf-off;
  A3 measures whether the pulses got past the eave.
- **Alpha shapes** instead of the raster close: same edge bias (half the spacing) and no better on scan-line
  patterns; the raster version is simpler to reason about and deterministic.
- **PDAL**: not installed; laspy with the lazrs backend reads LAZ and EPT nodes directly.

## Risks

- **Change between captures that A4 cannot see** (an added patio cover, as at ev-52191985): about 1 in 14 accepted
  houses by the EagleView check.
- **Frame**: a rigid translation from the height-map fit, median MAD 0.06 m; a 0.1-0.2 m registration error inflates
  every boundary number a little (the visible-edge share within 0.5 m, 86-90 %, bounds it).
- **Areas and pitches of complex roofs** are weaker than the outline (see the validation); they are reported, the
  outline is what the gates lean on.
- **Selection**: accepted houses are those with dense recent lidar (13 of 40 from one Arkansas project), not a random
  sample; the tree cohort's 16 houses carry most of the hidden-edge samples.
- **Two changes after the held-out EagleView numbers were first seen**: BIG_PLANE_M2 (small faces no longer chain
  buildings), prompted by two dev tree houses whose truth had merged neighbours, and the A1 conditioning rule,
  prompted by the synthetic test. Held-out EagleView agreement before and after both: 7 of 7 (median aligned IoU
  0.921, then 0.930); no held-out grade changed with either.
- **Public data can be withdrawn or reprocessed**: the tiles are cached and the ledger has their sha1.

## Rollback

The harness change is additive: without `<bench>/lidar/index.json` no house has lidar truth, the lidar columns are
empty and the lidar gates skip. Older baselines still compare (they have no lidar fingerprint, and a missing lidar
block skips the lidar gates); older gates files have no lidar section and do not gate it. Revert the commits on
`outline/truth` to remove it; no reconstruction code and no stored measurement changed, so
`ROOF_3D_ALGORITHM_VERSION` is untouched.

Data credit: USGS 3D Elevation Program (3DEP) lidar, public domain.
