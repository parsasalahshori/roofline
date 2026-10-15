# Design note: hidden edges from the photo (track `photo`)

## Problem

Where a tree crown hangs over an eave, Google's height map cannot see where the roof ends: the heights outside the
edge are the crown's, as high as the roof, so there is no eave drop (eave support `none`, `eave-support.ts`). The mask,
and the outline traced from it, then stops wherever the photogrammetry gave up. Against the new lidar truth
(`truth.md`), at c606b7a4 only 42 % of our dev outline samples with no eave support lie within 0.5 m of the lidar
outline, against 86 % of the supported ones, and the truth's own hidden stretches are 1.42 m from our outline on
average.

## Approach

`packages/shared/src/roof-reconstruct/outline-photo.ts`, behind one option, `ReconstructOptions.hiddenEdge =
{ method: 'photo' }` (off by default), as step 3b of `reconstructRoof`: after the outline is squared and before
topology. It changes only the outline polygon, never mask pixels (last round's mask completion broke topology), and
reads Google's true-ortho photo (the `rgb` layer: the same capture as the height map, on the same grid, so no
alignment). The server resamples the photo onto the height map's grid (`rgbOf` in `estimator/roof-3d.ts`, as
`greenOf` already did) only when the option is on. The benchmark turns it on with `ROOF3D_HIDDEN_EDGE=photo`.

Per squared outline edge:

1. **Is it this method's edge?** Eave support is measured on the outline (the product's own `eaveSupport`, with a
   crown map from the photo's green and the heights' roughness, `crownFromGreen`). An edge is a candidate when at
   least half of it and at least 2 m of it has no support, and at least half of its unsupported samples are hidden by
   a crown: reason `crown`, or reason `level` with a rough outside (|4z - neighbours| >= 0.12 m on 40 % of the points
   0.4-1.2 m out: shaded or autumn foliage the colour test misses). A `level` edge with a smooth outside is a deck, a
   terrace or a porch at eave height: visible, not roof, and often roof-coloured. Walls and taller neighbours
   (`taller-neighbour`), and data gaps, are skipped.
2. **Directed hypothesis test.** The direction is known (the outline is squared), so only the offset d along the
   outward normal is searched, -1.5 to +2.5 m in 0.1 m steps (the survey's range: a hidden overhang is rarely more than
   2 m past the visible line). Each pixel near the edge is *roof-coloured* (within 3 robust sigmas, floor 0.012, of the
   chromaticity of this edge's own visible roof, learned from a strip 0.5-3 m inside it; luminance 0.45-1.8 times its
   median, for shade and glare), *foliage* (the estimator's vegetation test) or *other*; foliage and near-black shadow
   (luminance < 22) carry no evidence. The contrast at d is the roof share in the 0.6 m strip inside the line minus
   the share in the 0.6 m strip outside it, over informative pixels only.
3. **Accept only with strong evidence** (each a typed reason when it fails):
   - coverage: at least 30 % of each strip informative (`no-coverage`);
   - contrast at the best d at least 0.5 (`weak-contrast`), and at least 0.25 above the contrast at the current edge
     (`no-gain`); a best d within 0.2 m of the edge confirms it (`confirmed`);
   - consensus: each 0.1 m column along the edge finds its own best d; at least 30 % of the columns must have an opinion
     and 40 % of those must agree with the edge's d within 0.3 m (`no-consensus`): a parallel gutter, path or shadow
     line that runs only part of the edge does not carry it (the a-contrario idea, without a permutation null);
   - the heights must not contradict it: an outward move may not sweep over ground (over 10 % of the swept pixels more
     than 1 m below the eave: `ground`) or another mask part (over 5 %: `neighbour-roof`); an inward move must cut off
     occluded pixels (crown, foliage, deep shadow or something above the eave), at least half of them (`not-occluded`).
4. **Rebuild.** Moved edges are re-intersected with their neighbours' lines (a jog where they are parallel). A corner
   moving over 3.5 m, an edge flipping, a self-intersection (`corner`) or an area change over 25 % (`large-change`)
   undoes the largest move and tries again.

The result records every edge's status, reason, offset and contrast, and the moved stretches of the final outline
(`LocalRoof.hiddenEdges`), so a later UI can mark them as inferred, not seen. When the outline reaches past the crop,
the crop is padded (new pixels have no face; topology draws the faces to the outline as it does elsewhere).

## Results (DEV split only; held-out is the integrator's)

Same scorer, same commit of the harness (ca305cb6 + this branch), seeds 7, 8, 9, `--compare baseline-v2.json --gates
gates-v3.json`. Before: option off (identical to ca305cb6). After: `ROOF3D_HIDDEN_EDGE=photo`. Outputs in
`<ROOF_BENCH_DIR>/photo-track/` (`base-dev.*`, `v3-dev.*`; `v1-dev.*` is the first version, kept as the record of
what the crown requirement fixed).

Against lidar truth (hidden: our samples with no eave support, to the lidar outline; truth-hidden: the lidar outline's
hidden stretches, to ours, a set that does not move):

| cohort | lidar houses | hidden samples | hidden mean m | hidden <= 0.5 | visible <= 0.5 | truth-hidden mean m | truth-hidden <= 0.5 | IoU | boundary m | abs sloped % |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| all, before | 26 | 2053 | 0.876 | 42.2 % | 85.6 % | 1.424 | 35.0 % | 0.870 | 0.493 | 7.9 |
| all, after | 26 | 2069 | 0.869 | 41.9 % | 85.7 % | 1.420 | 35.1 % | 0.870 | 0.489 | 7.8 |
| canopy-heavy, before | 4 | 424 | 0.963 | 51.9 % | 95.4 % | 1.567 | 46.4 % | 0.821 | 0.545 | 15.0 |
| canopy-heavy, after | 4 | 425 | 0.945 | 52.0 % | 95.4 % | 1.562 | 46.5 % | 0.821 | 0.545 | 14.5 |
| canopy-light, before | 13 | 1133 | 0.887 | 33.9 % | 84.6 % | 1.036 | 32.4 % | 0.896 | 0.420 | 7.7 |
| canopy-light, after | 13 | 1148 | 0.882 | 33.4 % | 84.9 % | 1.030 | 32.4 % | 0.896 | 0.420 | 7.4 |
| canopy-none | 9 | 496 | 0.775 | 52.8 % | 84.3 % | 1.855 | 32.4 % | 0.848 | 0.624 | 8.2 (unchanged) |
| tree set, before | 10 | 927 | 1.030 | 35.3 % | 80.4 % | 1.342 | 28.9 % | 0.807 | 0.641 | 17.1 |
| tree set, after | 10 | 942 | 1.022 | 34.7 % | 80.8 % | 1.335 | 28.9 % | 0.807 | 0.641 | 17.1 |

EagleView (raw and aligned IoU, aligned boundary, area, checker, thin faces, faces): unchanged in every cohort (no
EagleView house moved). Gates: 331 pass, 0 fail (320 skipped: small cohorts). Determinism: 0 of 54 not
byte-identical; seeds differ 0 of 54. Runtime p50 255 -> 286 ms, p95 863 -> 926 ms (calibration 23 -> 25 ms).

What moved: 3 edges on 3 of 54 dev houses (seattle-wallingford +0.3 m, tr-little-rock-981790186 +0.5 m, both lidar
houses, both closer to the lidar outline: boundary 0.233 -> 0.218 m and 0.560 -> 0.541 m; tr-atlanta-268890926 +0.3 m,
no truth). 15 edges were confirmed where they were. 305 Ridgeway (lr-305-ridgeway): both hidden candidate edges are
declined, contrast 0.24-0.25 against 0.5 needed: the crown there is dense and leaf-on in Google's photo, and the lidar
roof under it is out of the photo's sight. The method cannot fix the owner's example.

Why so little (a seed-7 survey of the 54 dev houses): of 902 squared outline edges, 660 are supported, 85 hidden but shorter than 2 m, 64
walls or data gaps, 33 hidden but not by a crown (decks, terraces), 32 weak photo contrast, 4 no gain, 1 no consensus,
2 inward moves over non-canopy, 3 corner conflicts; 18 reached a decision (15 confirmed, 3 moved).

The first version (`v1-dev`) had no crown requirement and moved 8 edges; 5 of the 6 lidar houses among them got
closer to the lidar outline, but ev-47738131 moved onto a raised stone terrace the same grey as its roof (hidden
within 0.5 m 15 % -> 2 %, EagleView IoU -0.004) and five lidar hidden-share gates failed. That is the false positive
the design was warned about, and the reason for step 1's crown rule.

## Sensitivity (+-20 %, DEV houses, seed 7)

Which edges move when one constant moves by 20 % (default: 3 moves). 23 of the 34 settings leave the set exactly as
it is; none adds or removes more than two moves:

| constant | x0.8 | x1.2 |
| --- | --- | --- |
| minContrast (0.5) | 5 moves (+2: tr-atlanta-1289767665, tr-fayetteville-467353063, no truth) | 1 move (-2) |
| minHiddenM (2 m) | 4 (+omaha-roland -0.2 m inward) | same |
| minHiddenShare (0.5) | same | 2 (-seattle-wallingford) |
| bandM (0.6 m) | 3 (one swapped) | 3 (one offset 0.3 -> 0.4 m) |
| madK (3) | 2 (-tr-atlanta-268890926) | 3 (two offsets 0.3/0.5 -> 0.7 m) |
| minGain (0.25), lumLo (0.45), darkLum (22) | 4 / same / 3 (one swapped) | same / 4 / same |
| consensusM (0.3 m) | 2 | same |
| minCrownShare, roughM, roughShare, minCoverage, minConsensus, minColumns, groundDropM, minOccluded | same | same |

The sharp one is minContrast: the evidence thresholds decide how many edges move, and on DEV the set is so small that
no threshold can be tuned against truth without fitting a house or two. It was not tuned: 0.5 means "a clear majority
change of colour across the line" and was set before the first run.

## Alternatives rejected

- **Free line detection (LSD, Hough).** LSD's reference code is AGPL, and the direction is already known; searching
  one offset per edge is cheaper and harder to fool.
- **Gradient term (oriented luminance edge) and a circular-shift permutation null** (the survey's S = z(G) + z(C)).
  The colour contrast with a per-column consensus is simpler to reason about; a gradient would mostly add the gutter
  and shadow lines that are this method's false positives. Not tried: a possible v2.
- **Rotation search (+-3 degrees).** The outline is squared to the house's axes already; not tried.
- **Growing the mask by roof colour** (region growing under the crown). Edits mask pixels (last round: broke topology on
  7 of 8 dev houses) and has no straight-edge prior.
- **Shadow geometry.** Google gives no acquisition time, so the sun's azimuth is unknown.

## MEDIUM (0.25 m) resolution

No benchmark house is MEDIUM. Synthetic tests run every case at 0.1 and 0.25 m (and check that the two agree within
0.3 m). As a robustness check, every DEV house was also resampled to 0.25 m (nearest pixel, imagery quality MEDIUM)
and reconstructed with the option off and on: no throw, no lost roof, byte-identical on a rerun, 6 of 54 outlines
changed. There is no truth on that grid to score them.

## Risks

- Roof-coloured ground next to an eave (concrete, a stone terrace): guarded by the crown requirement and the ground
  test, but a raised terrace at eave height under a crown would pass both.
- Dense leaf-on canopy shows no roof at all; the method then (correctly) does nothing. Google's imagery is mostly
  leaf-on, so recall is low by construction.
- 0.25 m (MEDIUM) imagery: strips are 2-3 pixels wide; tested synthetically only (every benchmark house is HIGH).
- Moved edges are still unverified by the heights; they are recorded, but `Roof3d` does not carry the flag yet.

## Rollback

The option is off by default: nothing changes unless a caller passes `hiddenEdge`. Removing the option (and the
module) restores c606b7a4 behaviour exactly. Turning it on in the server changes reconstructions and must bump
`ROOF_3D_ALGORITHM_VERSION`.
