# Lidar fusion: roof only leaf-off lidar sees

Track `lidar/fusion`, base fb0b63db (ROOF_3D_ALGORITHM_VERSION 5). Code: `packages/shared/src/roof-reconstruct/lidar-fusion.ts`,
option `ReconstructOptions.lidarFusion` (index.ts), server option `RoofOnLayersOptions.lidarFusion` (apps/api
estimator/roof-3d.ts), types in `packages/shared/src/roof-3d.ts`. Off by default: the server does not fetch lidar yet, so
stored roofs and the algorithm version are unchanged.

## Problem

Google's Solar layers are captured leaf-on. Under a tree crown the height map is the canopy and the roof mask stops at
the crown, so a wing or an eave under trees is not in the data at all. Against lidar truth the reconstruction is about
15 % too small (signed) on canopy-heavy houses; 305 Ridgeway Dr (Little Rock) misses a lower east wing about 7.6 m past
Google's building box. Leaf-on heuristics (outline-planes.ts, outline-photo.ts) cannot tell a hidden eave from a notch
with a tree. Leaf-off airborne lidar (USGS 3DEP; Arkansas QL1 flown January to March 2025) sees the roof between bare
branches.

## Input interface (published first, commit a0795300)

`LidarEvidence` in roof-3d.ts: points as float32 offsets from a UTM origin (any WGS84 or NAD83 UTM zone), z in the
lidar's own vertical datum, flags (bit 0 last return, bit 1 class-2 ground), and `LidarFlight` (project, work unit,
collection window, leaf-off, QL, density, source, credit). `LidarEvidenceResult` is the service's typed miss
(`no-coverage`, `not-leaf-off`, `too-old`, `sparse`, `too-large`, `timeout`, `fetch-error`, `bad-data`): the service never
throws into Measure. The server option takes the same arrays (`LidarPointsUtm`) plus the flight.

## Approach

The fusion runs BEFORE the reconstruction and changes its input, not its output: where Google's heights are occluded
and the lidar sees roof, the lidar's roof surface is written into a copy of the height map and the mask; the unchanged
reconstruction then fits faces, pitch, outline and lines on it. So the lidar part gets real faces with the lidar's pitch,
joins Google's faces where the planes continue, and Google's own pixels (heights, mask) are never altered.

1. Gates: points present, at most 400 000 (size limit), leaf-off flight, at most 12 years from the imagery, at least 4
   last returns per m2 on Google's roof (QL1 is 8+, QL2 2-4).
2. Registration (outline-lidar.ts `register`, reused): dz from the mode of residuals, (dx, dy) maximising last returns
   within 0.15 m of the height map on smooth pixels, pinned in both axes. Then the roof's returns must lie on Google's
   smooth roof (median 0.15 m) or the step declines `misaligned`.
3. Returns classified (outline-lidar.ts `classify`): ground (class 2 or within 0.5 m of it), roof (2 m or more up, the
   neighbourhood one plane within 0.08 m, at most 24/12: bare branches are not smooth). Per height-map pixel, the lidar
   surface where roof returns are at least as many as ground returns within max(0.35 m, 1.2 spacings): a local
   least-squares plane through them at the pixel centre. Crest strips (a ridge's returns sit on two planes, so classify
   leaves them out) up to 1 m wide are closed, at the median height of the non-ground last returns round them.
4. Change between flight and imagery is refused, not merged: Google's smooth roof where the lidar sees only ground over
   10 % of it (built since), or lidar roof touching the house where Google sees a lower surface, after opening away the
   eave lip, over 6 m2 (taken down since): reason `changed`.
5. Lidar-only roof: lidar roof pixels off Google's roof part where Google is occluded (its height at least 0.5 m above
   the lidar roof, or no data) plus the pixels where both agree (canopy gaps), opened by 0.4 m (the eave lip along a
   visible edge is not a part), each connected part kept when it comes within 1 m of Google's part, is at least 4 m2 and
   at least half occluded (a part Google saw in full is a mask miss or a neighbour, not hidden roof).
6. At most as much again as Google's part (`large-change`); nothing found: `nothing-hidden`.
7. Google's building box is drawn from the same leaf-on view, so lidar pixels do not count as running past it in the
   joined-buildings test (otherwise 305 Ridgeway's wing is cut off as a terrace neighbour).

## Provenance and review

- The Google check (roof-3d-compare.ts `checkRoof`) skips faces with source 'lidar': Google's segment under them was
  fitted to the canopy. Without this, two fused DEV houses failed "passing all targets" against the leaf-on segments.

- `LocalFace.lidarShare` / `Roof3dFace.lidarShare`: the share of the face's plan on lidar pixels (from 5 %);
  `source: 'lidar'` when at least half. A gable continuing under a crown keeps one face per slope with a share.
- `Roof3dEdge.source = 'lidar'` when at least half the edge's length has a lidar pixel 0.3 m inside it.
- `Roof3d.lidarFusion`: applied, reason, the plan and sloped area added, its share of the outline, per face the lidar
  area and pitch, and (server) the flight with its USGS credit.
- Review reason `roof-from-lidar` (severity `check`) when the lidar adds at least 3 m2 or 2 % of the outline (the same
  limits as `roof-inferred`): measured, but by another sensor on another date, so a person checks it against the photo.

## Scoring (no circularity)

The fusion reads one flight per house (lidar-edges/<slug>.bin, chosen from metadata alone). It is scored on EagleView and
on cross-flight lidar truth (lidar/<slug>/units/<other unit>/truth.json, a different flight), with the key's shift
frozen from the OFF outline: `npx tsx apps/api/src/scripts/roof-3d-fusion-eval.ts --split dev`. The single-flight lidar
grade in the benchmark is built from the fused flight on most houses and is used for debugging only.

## Results (DEV only; runs in ROOF_BENCH_DIR/fusion/)

Fusion on vs off, same seed (7), same scorer (`roof-3d-fusion-eval.ts`, dev-v4.txt):

- 52 DEV houses have a lidar crop. Applied on 7; declined: 21 not-leaf-off, 13 sparse (QL2), 4 misaligned, 7 nothing-hidden.
- EagleView: no DEV EagleView house was changed (each declined: their fused flights are leaf-on, sparse, or nothing is
  hidden). So EagleView shows no harm and no gain; it is not evidence of success.
- Cross-flight truth (a different flight): 19 house-flight pairs, 4 changed, all 4 better in IoU, none worse; median
  |plan error| over the 19 from 12.2 % to 10.5 %.

| house | canopy | added (plan) | cross-flight truth (flight, density) | IoU off -> on | plan error off -> on |
|---|---|---|---|---|---|
| lr-305-ridgeway | heavy | 31.1 % (517 ft2) | AR_Ouachita_B6_2016 (2017-03, 4.75/m2) | 0.710 -> 0.772 | -17.9 % -> +20.1 % |
| lr-tyler | light | 32.5 % (613 ft2) | AR_Ouachita_B6_2016 (2017-03, 7.07/m2) | 0.663 -> 0.682 | -31.6 % -> -2.0 % |
| hs-summer | none | 2.4 % (50 ft2) | AR_Ouachita_B5_2016 (2017-03, 2.6/m2) | 0.835 -> 0.839 | -4.3 % -> -2.0 % |
| tr-little-rock-981790186 | light | 2.4 % (137 ft2) | AR_Ouachita_B6_2016 (2017-03, 2.44/m2) | 0.854 -> 0.868 | -8.7 % -> -6.4 % |
| tr-austin-381786736 | light | 18.9 % (506 ft2) | none | - | - |
| omaha-roland | heavy | 3.9 % (128 ft2) | none | - | - |
| tr-little-rock-951188237 | light | 5.1 % (72 ft2) | none | - | - |

305 Ridgeway: the east wing comes back (a part of 65 m2 under the crowns, 88 % occluded; faces at 3.4/12, 7.8/12 and
8.2/12 from the lidar). The cross-flight truth disagrees on size: the 2017 flight (4.75 points/m2) outlines 128.5 m2 where
the fused 2025 flight outlines 171.6 m2, and ours is between them, 20 % over the 2017 one. The 2017 flight is sparse and
leaf-off in March; whether it under-sees the wing or the wing changed after 2017 cannot be told from these data. Read the
cross-flight result on this house as "the wing exists in both flights' direction" (IoU up), not as a size check.

**Registry cross-flight truth (the truth track's `crossflight.py`, truth-crossflight.md)** — the stricter scorer: only
the truth its registry names for the fused flight (never the same project, never a changed pair, never the smaller of
two disagreeing outlines), with the crops of the flights that have one (`--edges-dir lidar-edges-xf --registry`,
dev-xf-v1.txt). 17 DEV houses; fusion applies on 1 (9 decline sparse: those are the 2015-2019 QL2 flights; 5 leaf-on;
2 nothing hidden); no house got worse.

- **305 Ridgeway, fusing the 2017 QL2 flight (4.75 points/m2), scored on the 2025 QL1 truth (fine): IoU 0.609 -> 0.794,
  plan error -38.5 % -> -17.5 %; the east wing comes back from the sparse winter flight too.** The registry refuses the
  reverse (fusing 2025, scored on 2017) because the 2017 outline is the smaller of two disagreeing ones: the truth track
  found ground-free returns under the wing in 2017, so the wing stood then and QL2 under trees simply under-resolves it.
  That makes the "+20.1 % against the 2017 truth" above an artefact of the weaker truth, not an over-estimate.

**County planimetric footprints (the free track's PAgis download, Pulaski County; independent of Google and of all
lidar)** — wall lines, so a correct roof is larger by its overhang (about +5-12 % on these houses):

| house | IoU off -> on | plan error off -> on |
|---|---|---|
| lr-305-ridgeway | 0.744 -> 0.822 | -23.2 % -> +12.4 % |
| lr-tyler | 0.652 -> 0.903 | -29.9 % -> +0.4 % |
| tr-little-rock-951188237 | 0.805 -> 0.841 | -15.0 % -> -10.0 % |
| tr-little-rock-981790186 | 0.873 -> 0.889 | -3.1 % -> -0.7 % |
| tr-little-rock-1232985555, tr-north-little-rock-1231176703 | unchanged (declined) | unchanged |

Every changed house with a county footprint is closer to it; none is further.

Canopy-heavy DEV houses: lr-305-ridgeway applied; omaha-roland applied (no second flight); seattle-wallingford declined
misaligned (roof residual 0.19 m over the 0.15 m limit); kc-brookside, ev-52191985, ev-52192220 declined not-leaf-off;
tr-atlanta-1289767665, tr-atlanta-51300274, tr-fayetteville-466556470, tr-fayetteville-467353063 declined sparse (QL2
2015-2018 flights chosen; the 2025 QL1 flights of the Fayetteville houses are not marked leaf-off in the metadata).

Debugging only (circular: the benchmark's lidar grade is built from the flight the fusion reads): canopy-heavy IoU
0.821 -> 0.863, |plan| 15.2 % -> 8.7 %; 305 Ridgeway lidar IoU 0.587 -> 0.807.

DEV gates (`--compare baseline-v2.json --gates gates-v3.json`): fusion off, all pass (output unchanged). Fusion on
(`--lidar-fusion`): 330 pass, 1 fails: canopy-heavy runtime p95 1.70x the calibrated baseline (limit 1.5x): fusion adds
about 0.3-0.8 s on a house where it registers (registration 0.15-0.5 s, classification 0.05 s, surface 0.1 s on a loaded
machine). A tighter registration window was tried and reverted: it changed the shift found on seattle-wallingford by
0.55 m (both pinned), which says the registration is less certain along a house's long axis than its checks admit.

Sensitivity (+-20 % on occludedM, openM, minPartM2, minOccludedShare, touchM, maxConflictM2, maxGoneShare; 18 DEV
houses where fusion acts or nearly does, sens/*.txt): the same 7 houses apply in every run but openM 0.32 m (8, one more
small part); cross-flight results unchanged except plan error on lr-tyler (-2.0 % to +1.1 %) and two small parts.

## Alternatives rejected

- Move outline edges only (outline-lidar.ts, the prototype): cannot add a wing (a new face with its own pitch), only
  shift edges; and it measures where the roof ends but not what it is.
- Fit lidar planes and splice faces into Google's topology: a second topology path to maintain and test; writing the
  lidar surface into the layers lets the one reconstruction do it.
- Replace Google's heights on occluded pixels INSIDE Google's mask too: would change pitch on many tree-covered faces
  Google partly sees; left for a later round (risk of changing priced faces without a truth to show it helps).

## Risks

- A neighbour's roof joined through a crown: bounded by touch distance (1 m), the occlusion test and the 1x cap.
- Cross-flight truth on Arkansas houses comes from the 2016-2017 Ouachita flights at 2-7 points/m2: sparse, and a house
  may have changed between 2017 and 2025. It is weak evidence either way.
- Registration ambiguity: on seattle-wallingford two windows gave shifts 0.55 m apart, both passing the pin test. The
  on-roof residual check (0.15 m) is the guard; it declined that house. A residual check on the added part's edges
  against a second flight would be stronger (not done).
- Lidar ground under crowns is written into the heights used for EDGE EVIDENCE only (within 1.5 m of an added part),
  so an eave the lidar placed is judged by the drop the lidar measured; it never enters the reconstruction.

## Tests

`packages/shared/test/roof-reconstruct-lidar-fusion.test.ts` (synthetic, seeded, 0.1 m and 0.25 m pixels, two turns):
the hidden part comes back with the true pitch, provenance and the review reason; rerun byte-identical; option off or
null is the old reconstruction; typed declines (leaf-on, unknown leaf state, sparse, empty, too old, too many points,
another place); changed roofs refused both ways; a mask miss Google saw is not added; the cap; the building box
exemption; a detached shed under a crown is not added; a roof off Google's roof by 0.4 m is declined. Mutation check by
hand (each guard deleted in turn: occluded share, change, cap, leaf-off, touch, box exemption, on-roof residual): every
deletion fails a test. `apps/api/test/pure/lidar-edge-shares.test.ts`: edge provenance and the service adapter;
`apps/api/test/bench/confidence.test.ts`: the Google check skips lidar faces.

## Rollback

Off by default; nothing to roll back in production. To remove: drop the `lidarFusion` option (index.ts, roof-3d.ts);
the types are additive and old roofs read unchanged.
