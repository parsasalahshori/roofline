# Hidden eaves from leaf-off lidar (track: lidar)

Status: a prototype behind one option, **off by default**. This is an upper-bound and feasibility study. It is not a
release candidate. Code: `packages/shared/src/roof-reconstruct/outline-lidar.ts`. Branch: `outline/lidar`, from the
truth commit ca305cb6.

## Problem

Under a tree crown, Google's height map cannot show where the eave is. 54 % of the outline next to canopy has no eave
support, and there EagleView disagrees by more than 0.5 m 3.1 times as often (failure-taxonomy.md). USGS 3DEP lidar
is public domain and much of it is flown leaf-off. Its pulses reach the roof and the ground between bare branches.

## Approach

The step runs between `squareOutline` and `buildTopology` (`index.ts` step 3b). It changes outline edges only, never
mask pixels, so the faces, planes and pitch stay Google's. The option is `ReconstructOptions.lidar = { cloud, params? }`.
On the server it is `roofOnLayers(..., { lidar: LidarPointsUtm })`, which reprojects across UTM zones and NAD83/WGS84.
The result is reported as `LocalRoof.lidarEdges` / `Roof3d.lidarEdges`, either applied or declined with a typed reason.

1. **Registration.** The fit counts inliers, the returns within 0.15 m of the height map on smooth pixels, rather than
   averaging residuals. Under a leaf-on crown, Google's heights are the canopy and the lidar's last returns are the
   ground, metres below, so a mean would be dragged off. dz comes from the residual mode, which handles any vertical
   datum. (dx, dy) come from a coarse-to-fine grid within ±3 m, then dz is fitted again. The window is the crop plus
   10 m. At 4 m, tree houses' windows were mostly canopy and 7 of 54 dev houses failed to register.
   - Declined `misaligned` when the best shift is at the search limit, or is not pinned in x and y.
   - Also declined `misaligned` when roof returns are off Google's faces: median above 0.15 m, on smooth pixels.
   - On the Arkansas QL1 houses the fit lands consistently near (-0.95, +0.6) m.
2. **Classification.**
   - **Ground:** class 2, or a last return within 0.5 m of the ground.
   - **Roof:** a last return at least 2 m up whose neighbourhood is one plane within 0.08 m, no steeper than 24/12. A
     wing Google never fitted therefore counts too.
   - **Neither:** branches and walls.
3. **Profiles.** Every 0.2 m along the outline, in a 0.6 m corridor along the outward normal, the run of roof returns
   that starts inside ends at the first ground bin. The eave is the last roof return plus half the point spacing. If no
   ground bin follows within 1 m, the profile has no evidence.
4. **Edge frame.** The same profile is run on the edges Google does see (strong support). Least squares fits
   o = n·δ + b, where δ is the registration's leftover shift at the edges and b is the eave lip; both are taken out of
   the hidden profiles. A lone gable is not pinned along its ridge, and the synthetic 0.25 m / 40° case was 0.5 m off
   before this fix. A large b, or a spread that no shift explains, gives `changed`.
5. **Moves.** An edge whose samples are mostly hidden moves parallel to itself by the median corrected offset, when:
   - at least 40 % of its hidden samples have evidence;
   - their median absolute deviation is ≤ 0.35 m;
   - the offset is between -1 m and +3 m, and at least 0.15 m.

   Corners are rebuilt where the moved lines cross, with a jog when the lines are near parallel or the crossing runs
   more than 1.5 times the move. The move is refused on a self-crossing or more than 30 % area change.

Other typed declines: `no-points`, `too-many-points` (over 400 000 points), `not-leaf-off`, `too-old` (over 12 years),
`sparse` (under 4 roof returns per m²), `no-hidden-edges`, `no-evidence`, `error`. The step never throws, and
`roofOnLayers` keeps its own no-throw guard.

## Data and scoring (no circularity)

- **Input.** `scripts/roof-bench-lidar/edge_points.py` exports one crop per house to `ROOF_BENCH_DIR/lidar-edges`
  (72 MB for 81 houses). The project is picked from metadata alone: leaf-off first, then the latest flight, then the
  most points. The truth's A1–A6 checks are never used. It reuses the truth track's fetched points as the method's
  input, not as an answer.
- **Score: EagleView only** (`apps/api/src/scripts/roof-3d-lidar-eval.ts`). Per house, EagleView's shift onto
  Google's frame is frozen from the option-OFF outline's strong-support samples, so it cannot move with the method.
  - **hidden:** our samples with no support, measured to the key.
  - **evHidden:** the key's samples where Google has no support, measured to our outline. This set is fixed.
  - **visible:** our other samples, as a no-regression guard.
  - Also IoU, mean boundary distance and sloped area error.
- **Lidar-truth numbers are circular** for this method, because they come from the same returns. The bench still
  prints them under `--lidar-edges`. They are not evidence and are not quoted here as gains.
- **Sampling bug.** The eval and the step sample in 0.2 m pieces because of the eave-support.ts bug below.

## Results (DEV only; held-out is the integrator's)

### Who it can reach

On the dev split, 54 houses have 52 crops. With the default (shippable) gates the step does:

| outcome | houses |
| --- | --- |
| not-leaf-off | 21 |
| sparse (QL2 at 2–4 points/m²) | 13 |
| **applied** | **8** |
| misaligned | 4 |
| no-evidence | 4 |
| changed | 1 |
| no-hidden-edges | 1 |
| no crop | 2 |

- The 8 applied houses are hs-summer, lr-305-ridgeway, lr-tyler, omaha-roland, tr-little-rock-951188237,
  tr-little-rock-981790186, tr-nashville-1217412740 and tr-seattle-222155638.
- **None of the 8 has an EagleView report.** The 18 dev EagleView houses are mostly leaf-on (10) or sparse QL2 (5). Only
  one is leaf-off QL1.
- **So with the shippable gates, EagleView can score 0 dev houses.** This is the headline limitation.

### EagleView score, default gates

18 comparable dev houses, seeds 7, 8, 9: no house changed. Every metric is identical off and on.

| cohort | houses | hidden ≤ 0.5 m | evHidden ≤ 0.5 m | visible ≤ 0.5 m | median IoU | median boundary |
| --- | --- | --- | --- | --- | --- | --- |
| all | 18 | 57 % | 44 % | 86 % | 0.925 | 0.31 m |
| canopy-heavy | 2 | 60 % | 49 % | 92 % | 0.921 | 0.29 m |
| canopy-light | 12 | 53 % | 42 % | 83 % | 0.915 | 0.33 m |
| canopy-none | 4 | 75 % | 55 % | 92 % | 0.932 | 0.28 m |

### EagleView score, relaxed gates

This run is an upper-bound probe: `requireLeafOff=false`, `minRoofDensity=2`, seeds 7, 8, 9. Exactly **one** EagleView
house is applied: ev-52192220, canopy-heavy, QL1 flown leaf-on. The other 17 are unchanged.

| set | hidden ≤ 0.5 m (mean) | evHidden ≤ 0.5 m (mean) | visible ≤ 0.5 m | IoU | boundary | sloped area error |
| --- | --- | --- | --- | --- | --- | --- |
| ev-52192220, off | 48 % (0.61 m) | 43 % (0.68 m) | 90 % | 0.928 | 0.28 m | -0.3 % |
| ev-52192220, on | **97 %** (0.28 m) | **89 %** (0.33 m) | 92 % | **0.945** | **0.20 m** | +1.5 % (**worse**) |
| dev canopy-heavy (2), off | 60 % | 49 % | 92 % | 0.921 | 0.29 m | median 1.0 % |
| dev canopy-heavy (2), on | **76 %** | **71 %** | 92 % | 0.930 | 0.25 m | median 1.6 % (**worse**) |

- **Edges.** One house, so this shows that it can work, not how often. On that house the hidden edges come to within
  0.5 m where EagleView puts them.
- **Area.** The absolute area error grows from 0.3 % to 1.5 %. Before, an outline that was too small in one place and
  too large in another happened to cancel.
- **Not shippable.** The relaxed gates send 18 house-seeds to `misaligned` and 30 to `no-evidence`.

### Visual check (no truth)

See `roof-bench/analysis/lidar-track/pics.png`.

- **tr-little-rock-951188237:** the outline moves out under the eastern tree and squares a chamfered corner. Area
  goes from 124.8 to 140.1 m². This is plausible on the ortho.
- **lr-305-ridgeway (the owner's house): not fixed.** The lidar shows the roof running about 6.5 m east under the
  tree. That is a wing whose faces Google never fitted, and the step only moves edges by up to 3 m. It moved the NE
  diagonal 2.67 m, and the corner jog at the north end leaves a wedge that looks wrong on the ortho. Area went from
  105.5 to 110.7 m², and topology made 5 faces from 3.
  - The fix is the "missing wing" v2: add the lidar roof region to the outline as a polygon, with its own planes from
    the lidar. That was not built.

### Gates

`roof3d:bench --split dev --lidar-edges --compare baseline-v2.json --gates gates-v3.json` gives **321 pass, 10 fail**:

- **Checker pass:** 9 cohort rows lose one checker-pass house, and it is one house, tr-little-rock-981790186. The
  checker's 'outline over Google's mask' test now fails with `outline-off`. By design the outline goes past Google's
  mask, and that checker target judges the outline against the mask. The integrator has to decide whether it still
  gates hidden edges.
- **Runtime:** state-AR p95 rose from 23.9 to 39.4 calibration units, 1.65× against a limit of 1.5×. The step adds
  p50 54 ms and p95 316 ms per house with a crop, mostly the classification and registration.
- **Option off:** 331 pass, 0 fail. With the option off, the reconstruction is byte-identical to before.

### Sensitivity (±20 %, dev, default gates)

The measure is the count of applied houses and the plan area they add, which is 59.0 m² at the defaults. EagleView
cannot measure this, because no applied house has a key.

| constant | -20 % | +20 % |
| --- | --- | --- |
| minRoofDensity 4 | 8 / 59.0 | 8 / 59.0 |
| maxSpreadM 0.35 | 7 / 53.8 | 8 / 62.3 |
| minEvidenceShare 0.4 | 8 / 67.2 | 8 / 58.0 |
| minHiddenShare 0.5 | 8 / 67.6 | 8 / 59.0 |
| maxBiasM 0.4 | 7 / 58.1 | 8 / 59.0 |
| corridorM 0.3 | 6 / 66.5 | 8 / 55.9 |

### Determinism, runtime and size

- **Determinism:** byte-identical on rerun (tested). There is no randomness, and points are read in file order.
- **Seeds:** the step reads no randomness, and its declines and moves are the same at seeds 7, 8 and 9 on the
  EagleView houses.
- **Download per house:** EPT reads cost 2–16 MB (the median is about 4 MB); whole LAZ tiles cost 46–235 MB. The crop
  actually used is 0.2–2.9 MB (13 bytes a point).

## Could it run in the product?

- **Only with EPT range reads.** Of the 81 crops, 83 work units came from the public EPT bucket and 36 from tiles. The
  Arkansas leaf-off projects that matter most, AR_Western_B24 among them, were only on rockyweb as 100–235 MB tiles,
  at about 0.3 MB/s per connection. That is minutes per house: not viable inside a Measure request.
- **What it would need:**
  - an EPT/COPC reader in Node (copc.js and laz-perf; their licences are not verified);
  - a 3 s budget and a 400 000-point cap (`too-many-points`);
  - a cache keyed by project and tile;
  - background pre-fetch for addresses in leaf-off project footprints.
- **Most of the time it changes nothing.** On dev it applies to 8 of 54 houses (15 %); everywhere else it declines with
  a reason.
- **Turning it on bumps `ROOF_3D_ALGORITHM_VERSION`.** It changes stored outlines. Moved edges stay unverified in
  `Roof3d.edges`, since the height map still cannot see them. `Roof3d.lidarEdges` says lidar placed them.

## Alternatives rejected

- **Scoring on lidar truth:** circular.
- **Growing the mask from lidar:** last round's mask completion broke topology on 7 of 8 dev houses.
- **Face-plane-only roof detection:** this was the first version. It cannot see a face Google never fitted, and on 305
  Ridgeway nothing was found.
- **Residual-mean registration:** canopy dominated it (cost 0.43 on 305 Ridgeway, wrong dz).
- **A strict leaf-off gate relaxed for scoring:** left as a parameter. Leaf-on lidar did help ev-52192220, but leaf-on
  lidar more often fails to register or finds no evidence.

## Risks

- **Changed houses:** captured only by the visible-edge check. A change on a hidden side alone is invisible to it (the
  "2 m shorter" synthetic case is ambiguous and declines safely).
- **One-sided moves read as a shift:** the edge frame can explain one visible side moving as a registration shift and
  cancel a real hidden move. The result is safe (no move), but it costs recall.
- **The checker's mask target:** it conflicts with any method that corrects the mask.

## Rollback

Do not pass `lidar` (the default). Nothing else changed behaviour: the off path is byte-identical, and all 331 gates
pass.

## Found on the way: eave-support.ts sampling bug (affects the product and the bench)

`eaveSupport` (c606b7a4) computes `tt = Math.min(t, L / 2)` for every sample. Every sample past an edge's midpoint is
therefore placed AT the midpoint: on a 10 m edge, samples 25–50 all sit at 5.0 m.

- **What it affects:** the product's per-edge support shares, the 'edges-unverified' flag, the EDGE_AGREEMENT
  calibration, and the bench's lidar hidden, visible and truth-hidden sets. Half of each edge is never measured, and
  its midpoint is counted twice over.
- **Not fixed here:** the fix changes product output and every baseline, so it is the integrator's call. Probably
  `tt = L < step ? L / 2 : t`, and it needs a version bump and a new baseline.
- **Workaround:** this track measures 0.2 m pieces (`densify`).
