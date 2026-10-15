# Design note: cross-flight lidar truth (track `truth`, lidar round)

## Problem

The fusion track reads a USGS 3DEP lidar flight to recover roof that Google's leaf-on height map cannot see. The
benchmark's lidar truth (truth.md) is built from lidar too, and for every house it is built from ONE chosen flight. A
method that read that same flight would be scored against its own input: same returns, same gaps, same misclassified
branches. Those numbers are circular (standard 4) and say nothing about whether the method is right.

Many benchmark houses lie under two 3DEP projects of QL2 or better: in Arkansas the 2015-2017 FEMA Region 6 /
Ouachita / Benton / Washington County QL2 flights (EPT, leaf-off) and the 2024-2025 `AR_Western_B24` QL1 flight; also
CT, FL, AL, NE/SD, VA, OR, TX, TN pairs. The previous round already fetched both flights and built a truth from each
(`lidar/<slug>/units/<unit>/truth.json`) but used only one.

## Approach

`scripts/roof-bench-lidar/crossflight.py` (Python, no product code):

1. **Grade every unit truth** with `validate.grade` (A1 frame, A2 density, A3 edges observed, A4 no change against
   Google, A5 sanity, A6 EagleView where one exists): `fine` = passes all; `coarse` = fails only A2 and its expected
   edge error is <= 0.50 m (QL2: ~0.48 m) - usable for IoU and area, too coarse for the 0.5 m hidden-edge test.
2. **Compare every pair of flights** of a house: IoU, plan areas, boundary distance, and a **roof-change check from
   the returns themselves** (`change_check`): on a 0.5 m grid in Google's frame (each flight's own registration
   applied), the region one flight calls roof and the other does not, eroded by the two outlines' expected edge
   errors, is split into connected pieces; a piece of 4 m2 or more is a change when, of its cells where the other
   flight has any return, at least half hold a ground (class 2) return. A roof stops every pulse; a bare crown over
   open ground lets many through; a crown over a roof yields none. So "the old flight saw ground where the new one has
   roof" is a change (refuse the house for that pair), while "the old flight saw only branches there" is missing
   observation, not a change. A median roof-height difference over the shared roof above 0.5 m (validate's A4 line)
   is also a change (rebuild, new storey).
3. **Register, per fusion flight F, the truth T**: the best accepted other flight (choose.py's order), never the same
   project (another work unit of one project is the same flight), never a changed pair. If the two outlines disagree
   (IoU < 0.85, validate's EagleView line) with no change found, one of them missed roof or took in something else:
   T is kept only when it is `fine` and the LARGER of the two (its extra roof stands where F's returns found no
   ground); otherwise refused (`outlines-disagree`).

Outputs: `lidar/<slug>/crossflight.json` (units, pairs, registry) and `lidar/crossflight.json` (registry summary,
independence statistics). Deterministic (byte-identical on rerun, checked).

`scripts/roof-bench-lidar/edge_points.py --pick xf` writes the fusion input crops to `ROOF_BENCH_DIR/lidar-edges-xf`
for the flight per house that HAS a `fine` cross-flight truth (same metadata order otherwise). The registry decides only
which houses and flights can be scored without circularity; the method still reads only the points.

Harness (`apps/api/src/bench/roof3d/crossflight.ts`, `roof-3d-bench.ts`):

- `--fusion-flight auto|UNIT|none`: score lidar against cross-flight truth for the flight fused (`auto`: each house's
  crop's work unit in `<lidar-edges-dir>/<slug>.json`). A house without one gets **no** lidar score; it never falls back
  to the primary truth. `--lidar-edges` now implies `--fusion-flight auto`; `none` restores the old (circular)
  behaviour with a warning.
- `--lidar-edges-dir NAME` (default `lidar-edges`): use `lidar-edges-xf`.
- `--xf-coarse`: also take `coarse` truth.
- The run's `lidarHash` becomes `xf:<hash>` so a compare against a primary-truth baseline is refused; freeze a
  cross-flight baseline (below).
- The guard (`selectCrossFlightTruth`): a registry or truth file naming the fused work unit, or the same project,
  throws (exit 3); three tests each fail when one clause of the guard is deleted (mutation-checked).

Typical fusion run:

```
python -I scripts/roof-bench-lidar/edge_points.py --pick xf           # once (already done: 22 houses)
npm run roof3d:bench -w @roofline/api -- --split dev --lidar-edges --lidar-edges-dir lidar-edges-xf \
   --compare <ROOF_BENCH_DIR>/baseline-xf.json --gates <ROOF_BENCH_DIR>/gates-v3.json
```

## What there is (all 84 houses scanned; 37 have two or more built unit truths)

Registry entries (one per house x fused flight): DEV 18 fine, 7 coarse, 27 refused; HELD-OUT 6 fine, 3 coarse, 15
refused. 22 houses (DEV 17, HELD-OUT 5) have at least one flight with a `fine` cross-flight truth; in most the
fused flight is the OLDER QL2 one and the truth the newer QL1 one (the QL2 truths mostly fail A2-density, so fusing the
QL1 flight usually leaves only `coarse` truth). Consequence: a fusion method is scored on the sparser 2015-2019 flight;
how it does on the dense 2024-2025 flight it will actually read in production is an extrapolation.

Changes found: `tr-little-rock-951188237` (median roof height 1.8 m apart: rebuilt), `ev-47926585` (Sonoma 2013 vs 2022,
0.75 m), `ev-51883255` (31 m2 removed). 305 Ridgeway (`lr-305-ridgeway`): the 2017 QL2 outline is 128.5 m2, the 2025
QL1 outline 171.6 m2 (IoU 0.75); the 2017 returns hold no ground where the east wing is, so the wing stood in 2017 and
the QL2 flight simply did not resolve it under the trees. Fusing the 2017 flight is scored on the 2025 truth (fine);
fusing the 2025 flight has no cross-flight truth (the 2017 one is the smaller and coarse: refused).

## Cross-flight baseline (`ROOF_BENCH_DIR/baseline-xf.json`)

Frozen from this branch's harness on the released reconstruction (fb0b63db; no reconstruction file changed), split
`all`, `--fusion-flight auto --lidar-edges-dir lidar-edges-xf`, lidar hash `xf:f0ec2667ffd0` (22 houses). DEV, against
cross-flight truth: 16/17 comparable, IoU 0.863, mean boundary 0.52 m, |plan| 11.8 %, hidden <= 0.5 m 33 % (1208
samples), truth-hidden <= 0.5 m 33 % (1859); canopy-heavy 3/3, IoU 0.722, |plan| 23.2 %. HELD-OUT: 5/5 comparable,
IoU 0.870 (aggregates only). A rerun on DEV with `--compare baseline-xf.json --gates gates-v3.json`: all 324 gates
pass (327 skipped, 7 of them for fewer than 3 houses with lidar truth). The primary-truth DEV run on the same tree
against `baseline-v2.json` passes every quality gate; 6 runtime p95 gates failed there because the shared machine was
loaded by other tracks' benchmark runs (2x calibration-relative time), not because of a code change (no reconstruction
file differs).

## Fusing the dense flight (`--pick xf-any`, `--xf-coarse`)

Production will read the newest leaf-off flight (in Arkansas the 2024-25 QL1). Its cross-flight truth is usually the
2015-17 QL2 flight, which is `coarse`. `edge_points.py --pick xf-any` writes crops (to `lidar-edges-xf-any`) for the
flight the metadata rule prefers among those with fine OR coarse cross-flight truth (22 houses; 6 of them now fuse the newer flight instead, 5 of those
the Arkansas 2025 QL1). Score with `--lidar-edges-dir lidar-edges-xf-any --xf-coarse` against
`ROOF_BENCH_DIR/baseline-xf-coarse.json`, and read only IoU, boundary and area there: a coarse truth's edges are
+-0.5 m, as coarse as the hidden-edge test itself.
Baseline (released reconstruction, hash `xf+coarse:015d00a38fce`, 22 houses): DEV 16/17 comparable, IoU 0.841,
boundary 0.57 m, |plan| 9.6 %, signed plan -23.0 % against the (coarse, under-sized) QL2 truths where they apply.

## New houses (part 2): `ROOF_BENCH_DIR/xf-extra`

Ten tree-covered Arkansas houses outside the 84, chosen from the existing free pre-screen (OSM outlines + NAIP crown
share, `trees-candidates/`) where BOTH 3DEP flights are already on disk or in EPT (AR_Western_B24 tiles already
downloaded; Ouachita B6 2016 and Washington Co 2015 by EPT): Little Rock (Heights, Pleasant Valley), North Little
Rock (Indian Hills), Fayetteville (Wilson Park). Bought with `roof3d:bench-fetch --ids ... --out-set testset-xf`:
11 Data Layers requests this round (budget 15; ledger 30 -> 41), 19 buildingInsights; one bought house
(`tr-fayetteville-466556266`) is set aside in `testset-xf-spare/` unused to keep to the ten-house scope. Google's
canopy measure calls only 4 of the 10 heavy (NAIP's growing-season crown share over-reads canopy for Google's
captures).

They are NOT in the frozen `manifest.json` (adding them would move its hash and void every baseline this round).
`xf-extra/` is a bench folder of its own (`ROOF_BENCH_DIR=<...>/roof-bench/xf-extra`: its own manifest with the split
rule's DEV/HELD-OUT assignment, lidar index, cross-flight registry and crops; tiles and sources are links to the main
lidar folder). Graded exactly like the others (lidar_truth, choose, validate, crossflight): 6 primary `lidar`, 4
rejected (A1-frame: registration MAD 0.20-0.63 m; two also A4); 6 have fine cross-flight truth (DEV 4, HELD-OUT 2).
Between flights: median IoU 0.91 (heavy 0.89 over 4 pairs), no roof change found. DEV against cross-flight truth on the
released reconstruction: 4/4 comparable, IoU 0.910, |plan| 2.3 %, hidden <= 0.5 m 51 %, truth-hidden <= 0.5 m 42 %
(`xf-extra/xf-base-all.json`; held-out aggregates only).

To merge them into the main benchmark (an integrator decision, needs a new baseline): move the folders into
`testset-trees/`, run `roof3d:bench-manifest`, and rerun the lidar pipeline for them in the main bench.

## How independent is it

- **Independent**: different flight, year (0-11 years apart, median 6.5 over the registered fine truths; 0 is NE 2020 vs SD 2020, two projects of one season), contractor and sensor; separately classified
  ground; separately registered to Google's frame.
- **Shared**: the same truth algorithm (lidar_truth.py: same grow-by-half-spacing, closing radius, plane rules), the
  same sensor CLASS (linear-mode airborne lidar: both miss the same things a linear-mode pulse misses, e.g. dark wet
  roofs, glass), and the same Google height map as the registration target (a Google frame error moves both truths
  alike; it cannot make a method look right on its own).
- **Measured**: between flights on unchanged roofs, median IoU 0.85 (no canopy 0.80, light 0.85, heavy 0.86 over 33
  pairs, including truths that fail acceptance), median |plan diff| 12 %. Against EagleView (10 pairs), the older
  flights' plan error averages -35 % and the newer -1 %, and the two flights' signed errors correlate only weakly
  (r = 0.15): the flights' errors are largely not shared, the old QL2 flights simply miss roof.
- **The registered truth's own error against EagleView** (what a fusion run is scored on): `fine`, 9 house-flights:
  median aligned IoU 0.941, mean plan error -0.97 %, median boundary 0.21 m (the primary lidar truth: 0.927 aligned
  IoU). `coarse`, 2: median IoU 0.912, mean plan error +3.5 %, boundary 0.31 m.

## Sensitivity (+-20 %, DEV houses; registry entries that change out of 52)

MIN_CHANGE_M2 x0.8: 2 (one more pair called changed), x1.2: 0. MAX_ROOF_DZ_M, GROUND_SHARE, GRID_M, MIN_OBSERVED_M2
x0.8 / x1.2: 0. COARSE_MAX_EDGE_ERROR_M x0.8: 6 (coarse truths drop out; fine unchanged), x1.2: 0. XF_MIN_IOU x0.8: 3
more accepted; x1.2 (= 1.02, impossible to meet) refuses every disagreeing pair: 11. Full table:
`ROOF_BENCH_DIR/runs-l-truth/xf-sensitivity.txt`.

## Alternatives rejected

- **Same-flight truth with the fused points held out** (split the returns): the halves share the flight's gaps, its
  ground classification and its canopy state; still circular for exactly the stretches that matter.
- **EagleView only**: 34 reports, few under heavy canopy, and no paid data may be added.
- **Change detection by outline difference alone**: cannot tell a wing built after the old flight from a wing the old
  flight could not see (305 Ridgeway is the second).
- **Per-cell contradicted blob size**: tried first; at QL2 density half the 0.5 m cells are empty, so a real 30 m2
  wing breaks into small blobs and is missed (caught by a test); the per-piece ground share is density-fair.

## Risks

- Few houses: 17 DEV / 5 HELD-OUT with fine cross-flight truth; cohort gates under 10 houses are skipped.
- Fusion is scored on the older, sparser flight (see above); a method tuned to QL2 may behave differently on QL1.
- A ground misclassification (class 2 on a low flat roof) could fake a removal; the 4 m2 piece and half-share rules
  limit it.
- The unit truths were built by the previous round's lidar_truth.py (unchanged on this branch).

## Bug fixed on the way

`edge_points.py` multiplied heights by the source's `zUnitsToM` although `fetch.py` had already converted them to
metres: the crops of the two houses whose chosen flight is in US survey feet (`ev-50332002` FL_MiamiDade_1_D23,
`ev-51882178` VA_HamptonRoads_1_B23) had every height scaled by 0.3048. Fixed and tested; the shared
`ROOF_BENCH_DIR/lidar-edges` folder was NOT regenerated (other tracks read it during this round): rerun
`python -I scripts/roof-bench-lidar/edge_points.py` to refresh it. `lidar-edges-xf` was written with the fix.

## Not done

- No new lidar flight was fetched beyond the houses' existing tiles (rockyweb at ~0.3 MB/s): houses with a second flight
  only on undownloaded tiles were not considered.
- The QL2 unit truths were not rebuilt with any QL2-specific tuning; they are graded as built.
- No change to how the benchmark nulls hidden-edge metrics on coarse truth (documented instead).

## Rollback

Everything is opt-in: without `--fusion-flight`/`--lidar-edges` the benchmark is unchanged (same hash, same numbers).
Revert the commits; delete `lidar/*/crossflight.json`, `lidar/crossflight.json` and `lidar-edges-xf/`.
