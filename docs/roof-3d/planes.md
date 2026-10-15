# Hidden eaves from the roof's planes (track: planes)

Branch `outline/planes`, from the lidar truth commit `ca305cb6`. Code: `packages/shared/src/roof-reconstruct/outline-planes.ts`
(step 3b), wired in `index.ts` behind `ReconstructOptions.hiddenEdge = { method: 'planes' }`, **off by default**.
Tests: `packages/shared/test/roof-reconstruct-planes.test.ts`. Diagnostic: `apps/api/src/scripts/roof-3d-planes-diag.ts`
(DEV houses only). The bench turns it on with `ROOF3D_HIDDEN_EDGE=planes` (and `ROOF3D_HIDDEN_EDGE_PARAMS='{"k":v}'`
for sensitivity runs).

## Problem

Where a tree crown stands over an eave, Google's height map shows the crown, not the drop to the yard, and Google's
mask stops wherever the crown starts. The outline traced from the mask is then short of the eave, ragged (a staircase of
1-3 m edges following the crown's rim) and chamfered at hip corners: the 305 Ridgeway Dr symptom. Last round's
taxonomy: 54 % of canopy-exposed outline has eave support `none`, and there EagleView disagrees by more than 0.5 m 3.1
times as often. At `ca305cb6`, against lidar truth (DEV, 26 houses), only 42 % of our hidden-edge samples are within
0.5 m of the lidar outline (86 % of visible ones), and 35 % of the lidar outline's own hidden stretches are.

## Approach

The roof's planes are known from the visible part of every face, and on most houses every eave of a face sits at one
height (the wall plate), which that face's visible eaves show. A face's hidden eave lies where its plane comes down to
that height: the iso-line `a x + b y + c = h_e`. Step 3b, between `squareOutline` and `buildTopology`, on the polygon
only (never mask pixels, the mistake of last round's canopy completion):

1. **Eave support** (`eave-support.ts`) on the squared outline, on a window 4 m round the crop (the crop itself is not
   changed, so with nothing to do the reconstruction is byte-identical).
2. **Eave height per face**: on each strongly supported sample of an edge that runs level along its face (within 45 deg,
   topology's `eaveDeg`) of a face of 3/12 or more, the centre of the drop across the edge (the centroid of the height's
   fall beyond the plane's own slope, read +-0.5 m or 3 pixels) and the plane's height there. A face's value is the
   median when it has 2 m of such samples and their MAD is at most 0.10 m. Faces without one take the house's median
   only when all faces agree within 0.25 m, else `split-level`.
   *Why the centroid, not the steepest point:* a blurred step falls over a plateau as wide as the blur, and the plane's
   slope moves the steepest point to its inner end. On the 0.25 m synthetic hip the steepest point read the eave 0.25 m
   high (an iso-line 0.5 m inside); the centroid reads it within 0.03 m.
3. **Pieces**: runs of consecutive hidden edges (half or more of the samples `none`), split by the face they bound (the
   majority face label 0.4 m inside).
4. **A piece on its face's downhill side** (outward normal within 50 deg of downhill) is replaced by its face's eave line
   when every gate passes:
   - offset: every replaced corner at least -1 m from the line (the line at most 1 m inside), the corners between the
     ends and the nearer end at most 3 m inside it, the farther end (a chamfer's far end) at most 4.5 m;
   - its own visible samples (if 5 or more) within 0.3 m (median) of the line;
   - the area it adds: no other building's mask, at most 10 % of it lower than the plane by 1 m (visible yard: no roof
     there); the area it removes: at most 50 % of it on the plane (seen roof is not cut).
5. **Chamfers**: consecutive hidden pieces that are no face's eave, 4 m or less in all, are dropped for the corner where
   their neighbours' lines meet, only when both neighbours are eaves of two different steep faces (kept or replaced) and
   the corner lies within 0.3 m (horizontally) of those faces' crease: the hip's extension.
6. **Rebuild**: kept edges keep their lines, a replaced piece is one line, neighbours meet where they cross (or, nearly
   parallel, in a jog through the old corner). Pieces are accepted one at a time, the most hidden outline first, each
   only if the ring stays simple, its area within 25 %, no corner more than 4 m from an old one, and every corner where
   a replaced line meets another face's eave on their crease.

Rakes (a face's climbing side) are not inferred: no eave height says where a gable ends. Inferred edges stay unverified
(eave support on the final outline still reports them `none`; `Roof3d.edges` is computed on the final outline), and
`LocalRoof.hiddenEdge` records what the step did: pieces replaced, metres inferred, declined pieces by reason, or why it
did not run (`joined`: a terrace cut; `bad-input`, `eave-support`, `error`: never a throw). Pure and deterministic; the
step costs under 5 ms a house (in-process medians over 5 runs, canopy-heavy DEV: 2061 ms off, 2061 ms on, summed).

## Results (DEV split only, same scorer, `--compare baseline-v2.json --gates gates-v3.json`)

Reproduction: at `ca305cb6` the synthetic tests' "off" outlines stop more than 0.8 m short of the true eave under the
crown (asserted in every hidden-eave test); the module does not exist there.

Against lidar truth, 26 DEV houses (mean over seeds 7-9; lidar numbers do not move with the seed). Hidden: our samples
with eave support `none`, to the lidar outline. Truth-hidden: the lidar outline's stretches Google's heights cannot
vouch for, to ours (a set that does not move with the reconstruction).

| cohort | houses | hidden <= 0.5 m | hidden mean | truth-hidden <= 0.5 m | truth-hidden mean | IoU median (mean) | boundary median | abs plan error median |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| all, before | 26 | 42.2 % | 0.88 m | 35.0 % | 1.42 m | 0.870 (0.842) | 0.49 m | 8.9 % |
| all, after | 26 | **47.8 %** | **0.78 m** | **38.8 %** | **1.31 m** | 0.864 (**0.850**) | 0.48 m | 8.4 % |
| canopy-heavy, before | 4 | 51.9 % | 0.96 m | 46.4 % | 1.57 m | 0.821 (0.787) | 0.54 m | 15.2 % |
| canopy-heavy, after | 4 | 53.0 % | 0.92 m | 44.9 % | 1.47 m | 0.801 (0.789) | 0.59 m | 12.4 % |
| canopy-light, before | 13 | 33.9 % | 0.89 m | 32.4 % | 1.04 m | 0.896 (0.859) | 0.42 m | 8.5 % |
| canopy-light, after | 13 | **44.2 %** | **0.74 m** | **40.5 %** | **0.84 m** | 0.896 (**0.872**) | 0.42 m | 8.3 % |
| canopy-none, before | 9 | 52.8 % | 0.78 m | 32.4 % | 1.86 m | 0.848 (0.843) | 0.62 m | 9.9 % |
| canopy-none, after | 9 | 51.6 % | 0.76 m | 33.2 % | 1.85 m | 0.848 (0.844) | 0.62 m | 9.9 % |
| tree set, before | 10 | 35 % | 1.03 m | 29 % | 1.34 m | 0.807 | 0.64 m | 17.3 % |
| tree set, after | 10 | 38 % | 0.94 m | 31 % | 1.21 m | 0.823 | 0.57 m | 14.1 % |

Visible-edge share within 0.5 m is unchanged (86 %). HD95 against lidar: 1.72 -> 1.57 m (all).

Per house (lidar IoU before -> after): 15 of 54 DEV houses change at all (the rest are byte-identical), 8 of them
with lidar truth. `tr-houston-910102897` 0.627 -> 0.713, `tr-little-rock-951188237` 0.775 -> 0.827, `lr-305-ridgeway`
0.587 -> 0.635 (its south-east chamfer becomes the hip corner; hidden samples within 0.5 m 16/69 -> 35/78),
`houston-heights` 0.914 -> 0.948, `phx-arcadia` 0.891 -> 0.895, `hs-summer` 0.820 -> 0.823, `irvine-123-briar` unchanged
IoU (plan error -5.7 -> -3.7 %); **worse: `seattle-wallingford` 0.920 -> 0.880** (see Risks). Six changed houses have
no truth (`dc-lowell` +1.6 % plan area, `lr-tyler` +4.9 %, `tr-austin-381786736` +6.6 %, `tr-fayetteville-467353063`
-0.2 %, `tr-raleigh-47735197` +1.3 %, `tr-raleigh-47735779` +8.2 %): unscored. Review reasons change on five houses:
`seattle-wallingford` gains `outline-off`, `lr-305-ridgeway` `roof-hidden`, `tr-austin-381786736` `faces-patchy`,
`tr-raleigh-47735779` `edges-unverified`; `tr-little-rock-951188237` loses `differs-from-google`.

Against EagleView (DEV, 18 houses with a key): one key house changes, `ev-52191985` (canopy-heavy), whose |area error|
goes 1.7 % -> 5.1 % (IoU 0.763 -> 0.762, boundary 0.86 -> 0.87 m): the step adds 7.6 m2 under a dark tree at its
south-west that EagleView does not have. The all-houses median |area error| moves 4.0 % -> 4.4 %.

### Gates (option on, DEV, against baseline-v2 with gates-v3)

Fail. Every failure traces to `seattle-wallingford` or `ev-52191985`:

- **Checker passes** drop by one house in `all`, `canopy-any`, `canopy-heavy`, `lowslope`, `simple`, `set-testset`,
  `truth-proxy`, `truth-lidar` (seattle-wallingford). The checker's outline target is overlap with Google's mask: an
  outline moved past the mask fails it by construction. That target scores the method on the evidence it departs from
  (the circularity rule); it should not gate this option, but it is the contract and it fails.
- **Lidar median IoU** in `all`, `canopy-heavy`, `lowslope`, `simple`, `set-testset`, `truth-lidar` (and lidar boundary in
  `simple`, hidden and truth-hidden shares in `lowslope`): seattle-wallingford crossing the median of cohorts of 4-10
  houses. The mean IoU rises.
- **Median |area error|** against EagleView in `complex` (3.70 -> 4.33 points; `canopy-any` passes): ev-52191985.

With the option off (the default) the DEV run is byte-identical to baseline-v2 house by house and every gate passes.

### Sensitivity (+-20 %, DEV lidar houses, seed 7)

Each constant moved alone, the step on, the 26 DEV lidar houses at seed 7 (`roof-bench/planes/sens/`). No variant
was chosen from this table: the defaults are the ones written down before it was run.

| run | hidden <= 0.5 m | hidden mean | truth-hidden <= 0.5 m | truth-hidden mean | IoU median (mean) |
| --- | --- | --- | --- | --- | --- |
| step off | 42.2 % | 0.88 m | 35.0 % | 1.42 m | 0.870 (0.842) |
| defaults | 47.8 % | 0.78 m | 38.8 % | 1.31 m | 0.864 (0.850) |
| maxOffsetM 2.4 / 3.6 | 47.7 / 47.8 % | 0.79 / 0.78 | 38.3 / 38.8 % | 1.35 / 1.31 | 0.864 (0.846 / 0.850) |
| maxEndOffsetM 3.6 / 5.4 | 45.6 / 47.8 % | 0.81 / 0.78 | 37.5 / 38.8 % | 1.36 / 1.31 | 0.864 (0.846 / 0.850) |
| maxNormalDeg 40 / 60 | 44.4 / 47.9 % | 0.82 / 0.78 | 36.4 / 39.3 % | 1.37 / 1.29 | 0.864 (0.846 / 0.850) |
| yardShare 0.08 / 0.12 | 47.8 / 47.8 % | 0.78 / 0.78 | 38.8 / 38.8 % | 1.31 / 1.31 | 0.864 (0.850) |
| creaseTolM 0.24 / 0.36 | 46.5 / 47.8 % | 0.80 / 0.78 | 38.0 / 38.8 % | 1.32 / 1.31 | 0.864 (0.849 / 0.850) |
| visibleAgreeM 0.24 / 0.36 | 47.7 / 47.8 % | 0.78 / 0.78 | 38.8 / 38.8 % | 1.31 / 1.31 | 0.865 / 0.864 (0.850) |
| minPitchX12 2.4 / 3.6 | 47.7 / 47.8 % | 0.78 / 0.78 | 38.3 / 38.8 % | 1.32 / 1.31 | 0.865 / 0.864 (0.850) |
| chamferMaxM 3.2 / 4.8 | 47.8 / 47.8 % | 0.78 / 0.78 | 38.8 / 38.8 % | 1.31 / 1.31 | 0.864 (0.850) |

Every variant keeps the gain over "off"; the most sensitive constants are the downhill-normal limit (50 deg) and the
far-end offset (4.5 m), the two that admit diagonal (chamfer-like) pieces. No variant changes seattle-wallingford, so
the median-IoU gate failure is not a tuning matter. Not swept for time: faceMadM, houseAgreeM, hiddenShare, minHiddenM,
minStrongM, onPlaneShare, yardDropM, maxCornerMoveM, maxAreaChange.

## Alternatives rejected

- **Per-edge replacement** (first slice): the hidden stretch is a staircase of short edges at 30-90 deg to the eave, so
  per edge the angle gate refused almost all of it (6 edges changed in 26 lidar houses). Pieces (runs split by face)
  replace the staircase as a whole.
- **Growing the crop** for room: changed the plane search's lattice seeds on houses the step never touches (main pitch
  flips on 3 houses). The step reads its own window instead.
- **Steepest descent for the eave height**: biased high on blurred heights (above).
- **Excluding `taller-neighbour` samples**: a crown higher than the roof that the photo misses reads as a taller
  neighbour; 305 Ridgeway's tree side was refused that way. A wall of another building is caught by the other-building
  sweep instead.
- **Per-wing squaring, rake/gable symmetry, missing wings**: not done (time box). Missing wings (ev-52191132,
  ev-47747994; the east 8 m of 305 Ridgeway) are not reachable from planes the mask never saw.

## Risks

- **Foliage at eave height read as roof**: seattle-wallingford (canopy-heavy). Its north eave is replaced by one 19 m
  line; the lidar says the north-west corner is stepped 1.2 m south under a conifer. Nothing in the heights tells the
  two apart (the swept area is at or above the plane either way). The visible-agreement and yard gates did not fire.
- **A covered patio or porch at eave height** (ev-52191985): the same mechanism.
- Horizontal error is sigma_h / tan(pitch): about 0.2 m at 6/12, 0.4 m at 3/12; faces under 3/12 are left alone.
- Split-level houses: faces without their own eave height decline unless all faces agree within 0.25 m.
- The checker's mask target and `quality.outlineIoU` (the outline over Google's mask) fall where the step moves an edge;
  that can add review reasons.

## Remediation (after review; [outline-remediate.md](outline-remediate.md))

- **A dense crown over an eave and a dense crown in a notch of the eave are the same scene to this step**: the notch's
  inner eave lies on the same plane, higher up, so it reads as a 2 m crown bite and was filled (+5 % area, no review
  reason; packages/shared/test/roof-reconstruct-notch.test.ts). Now a move that adds at least `maxUnconfirmedM2`
  (0.5 m2) farther than `overhangM` (1 m) outside the old outline is refused (`unconfirmed`) unless at least
  `minDeepSeenShare` (25 %) of that area shows the face's plane through the leaves. The same applies to a dropped
  chamfer's corner. On DEV the evidence share of every deep move was 0-11 % (one, tr-raleigh-47735779, 20 %): leaf-on
  photogrammetry does not see the roof under a crown, so the step keeps only overhang-sized moves. `minDeepSeenShare: 0`
  is hypothesis mode (version 4's behaviour), for development.
- Every guard now has a scene in which only it refuses (roof-reconstruct-guards.test.ts), checked by
  `npm run roof3d:mutate-guards`.

## Rollback

The option is off by default and nothing else changes when it is off. Turning it on in `roofOnLayers` must bump
`ROOF_3D_ALGORITHM_VERSION`; rolling back is turning it off again (old stored roofs are unaffected either way).
