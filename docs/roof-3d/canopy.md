# Canopy track: roof hidden under trees or shade, and a better crown map

Code: `packages/shared/src/roof-reconstruct/canopy.ts` (new), the completion step 2a in `roof-reconstruct/index.ts`
(additive: an optional `canopy` option, an optional `LocalRoof.canopy` field, an optional `roomM` on `windowRound`,
two helper functions). Tests: `packages/shared/test/roof-reconstruct-canopy.test.ts`. `eave-support.ts` (confidence
track) did not exist yet; this track does not depend on it: the eave-drop test it needs is a small private function in
`canopy.ts` with the failure taxonomy's definition, to be replaced by the confidence track's when both are merged.

## Problem

The failure taxonomy (`roof-bench/analysis/failure-taxonomy.md`, modes 4 and 10) found that trees on this data are an
edge problem: crown pixels inside Google's mask are 0.28 % of it and a better tree mask moves no EagleView metric, but
canopy and shade hide roof the mask then leaves out (the two largest area misses, both in the held-out split) and 54 %
of canopy-exposed outline has no eave drop in the heights. The product's only crown rule is the photo's green, which
misses shaded and autumn foliage.

## Approach

1. **Crown map** (`crownMap`): photo-green and more than 1.0 m above the ground, OR (whatever the colour) more than
   1.5 m above the ground, non-planar (a plane through 0.8 m of heights leaves an RMS of 8 cm or more, computed in
   O(pixels) with summed-area tables, `localPlaneRms`), off every mask part, opened by 0.5 m, parts of 3 m2 or more.
   This is the taxonomy's section 1.2 definition, unchanged. It is an input: it decides what counts as occluded in
   the completion below and is there for the confidence and outline tracks.
2. **Grown roof** (`completeRoof`, step 1): pixels off every mask, in Google's box (+1 m), not crown, on the nearest
   face's own plane within 0.15 m, smooth (plane RMS under 5 cm), in parts at least 1 m across (an opening: the eave's
   blurred rim never grows) and 2 m2, connected to the roof, AND ending in an eave: of the part's open edge (off
   crowns), at least half must drop by 1 m or more (the taxonomy's "strong" eave support). Measured roof: it counts.
3. **Bridged roof** (step 2): a notch a crown bites out of one roof line. A pixel off every mask, in the box, no lower
   than the nearest face's plane by more than 0.5 m (no visible ground: no eave there), with roof on both sides along
   one of the house's axes within 5 m in total, and a crown pixel on that line. Inferred, not seen: bridged pixels are
   marked as crown for the faces (no plane is fitted on them), counted in `LocalRoof.canopy.bridgedM2`, and their
   outline-edge centres listed in `LocalRoof.canopy.occluded` for the confidence track to draw as unverified.
4. When anything is added, the crop is re-cut round the completed roof and the faces rebuilt from the same planes
   (no new plane search, no new random numbers); bridged pixels take their face's plane height (the crown's heights
   are not the roof's). A roof with nothing to complete is byte-identical to the result with completion off (tested).
5. **Guard**: if the completed roof's topology comes out worse (any face drawn from its pixels, or eave and rake lines
   longer than 1.05 x the outline's perimeter) the completion is undone and the roof reconstructed without it;
   `LocalRoof.canopy.undone = 'topology'` says so (a typed value, countable).

## Why simple growing was reverted, and what this version does about it

In a roof's own shadow the height map is interpolated by the photogrammetry: next to the roof it sits on the roof's
plane, smooth, for a metre or two, then fades to the ground with no eave drop. Growing "smooth, on the plane" takes
it (dev house hs-summer: 6.3 m2 of stair-stepped "roof" into the shadow; the first version of this track also grew
6.9 m2 on ev-47738131, an EagleView house, making its area error worse). The eave-ended test rejects such parts: a real
hidden wing has a far eave that drops by metres. The price, found on the dev split: **no dev house has a hidden part
that ends in a real eave drop**: with the test, growth fires on 0 of 54 dev houses. Where it might fire is the two
held-out area misses (not looked at, by the rules). The honest summary: growing from the heights works on synthetic
roofs with clean heights; on this data the heights under shade are not evidence, so it adds nothing on dev.

## What happened on the dev split (the honest part)

- Growing from the heights: 0 of 54 dev houses (above).
- Bridging under crowns: fires on 8 dev houses (0.5 to 0.8 m2 each at bridgeMaxM 3 m; 17 houses at 5 m). On 7 of
  the 8 the completed roof's topology broke (faces drawn from pixels; on ev-51882178 eave length went from 280 to
  696 ft), so the guard undid it; on the eighth (atl-virginia-highland) it stays (+0.7 % area). With bridgeMaxM 5 m
  and no guard, OSM overlap rose on 6 of 7 changed tree houses but the low-slope outline IoU gate failed and four more
  roofs were flagged faces-patchy. The topology failure is not understood yet (a cleaned, re-cut roof with nothing
  added is byte-identical, so it is the added pixels' shape; the topology is the faces track's file): an open issue.
- So on dev this track changes almost nothing measurable; it ships a crown map, a completion step that is safe by
  construction (eave-ended, crown-bounded, topology-guarded), and tests that show it works when the evidence is there.

## Alternatives rejected

- Growing without the eave test: takes interpolated shadow (above), area worse on EagleView houses.
- Following the crown edge, or bridging with a chord: invents roof past evidence or leaves the chamfer.
- Crown pixels into plane fitting: the taxonomy's ablation moves no metric; plane fitting is untouched here.
- Extrapolating every unverified edge to its neighbours' intersection (corner completion): cannot tell a chamfer
  under a crown from the inner corner of an L-shaped house without a footprint prior; left to the outline track.

## Risks

- Bridging can fill a real gap between two wings (up to 5 m) when a tree covers it entirely and nothing in the gap
  is lower than the roof plane by 0.5 m. Bounded by Google's box and by the crown requirement.
- Bridged area is inferred: it is in the measured area today (it is a small share: 0.5 to 1 m2 on the dev houses it
  fires on). The confidence track should mark those spans and the integrator decide whether a quote counts them.
- The north-up box is loose for rotated houses (it bounds growth only loosely there).

## Rollback

`reconstructRoof(..., { canopy: { complete: false } })` restores the previous reconstruction exactly; reverting the
commit removes everything (no stored format changed; `LocalRoof.canopy` is optional and not stored by `toRoof3d`).
