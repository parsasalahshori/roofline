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

Results: see "Results" below (filled from the DEV runs in roof-bench/fusion/).

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
- Edges of a lidar part are judged on Google's heights outside them (still canopy), so they read `unverified`; they carry
  source 'lidar' and the roof carries `roof-from-lidar`.

## Rollback

Off by default; nothing to roll back in production. To remove: drop the `lidarFusion` option (index.ts, roof-3d.ts);
the types are additive and old roofs read unchanged.
