# Fitted shapes: small roofs the plane search never finds (round 4, roof3/small)

Small ridge roofs (gables over bump-outs, dormers, front gables nested in a slope) are fitted as shapes on the height
map where the faces lack them (`fitted-shapes.ts`, `ridge-roofs.ts`; hip ends `hip-ends.ts`). Everything is behind
`primitives.ridgeRoofs` (OFF by default; with every shape switch off the reconstruction is byte-identical to the base).
Recommended setting: `ROOF3D_TUNING='{"primitives":{"ridgeRoofs":true}}'` (the parts below are on inside it).

## How a ridge roof is fitted
1. A crest the faces lack: heights falling away on both sides across one of the roof's directions, no ridge of the
   faces within half a metre, in line for a metre or more.
2. The tent on it: a level ridge, one pitch. The pitch is the tent's own least-squares pitch, the faces' beside the
   crest or the roof's largest pitch groups, whichever explains the heights round the crest best (`ridgePitchPrior`).
3. The footprint on its planes (`ridgeFootprint: 'planes'`): each slope out to a straight eave and in to where its plane
   goes under the faces' own (the valley, a line); a face reaching over from the other side of the ridge is taken; a
   slope the plane search already found is kept and the new slope is its mirror image across its own level line (the
   two meet in a level ridge); only what hangs together with the ridge.
4. Precision rules: the crest stands 0.12 m above the face it is cut from (`shapeCrestM`: a ridge the roof already has,
   drawn off, stands on that face's plane); no new slope within 8 degrees and 0.1 m of a face beside it
   (`shapeCoplanarDeg`); no lent pitch under 3/12.
5. Judged through the smoothing (`shapeJudge`): the faces with and without the shape, rendered and smoothed like the
   height map (Gaussian 0.35 m, among the roof's own pixels), must differ by 0.03 m RMS over the footprint in the shape's
   favour; a shape of two new slopes must also beat ONE plane fitted to its footprint by as much (a lump on a near-flat
   patch is no ridge roof). The faces' common test (refine.ts judgeChange arithmetic, refit false) is recorded on each
   shape, FittedShape.judge, but not applied: its gain floor was set for faces found on their own heights.
6. Placed as faces (planes locked, faces marked `fitted`), checked on topology: no face of it under 2.35 m2
   (`shapeFaceM2`), no neighbour spoiled; thin fitted faces are not refused (`shapeFaceWidthM` 0).

## Results (scorer + panel, runs r4-small-off / r4-small-v12; held-out looked at once)
| | MED | MEAN | POOL | same-kind ridge / valley | missing valley | fitted faces on EagleView's own face |
|---|---|---|---|---|---|---|
| dev base | 18.0 | 23.5 | 18.3 | 80 / 67 % | 15 % | - |
| dev ridge roofs | 17.1 | 22.3 | 18.4 | 83 / 69 % | 13 % | 8 of 8 |
| held-out base | 20.2 | 29.6 | 27.3 | 82 / 60 % | 17 % | - |
| held-out ridge roofs | 21.3 | 29.3 | 26.8 | 84 / 63 % | 14 % | 3 of 3 |
| dev evidence on / + ridge roofs | 15.4 / 15.4 | 21.8 / 21.8 | 18.5 / 18.5 | | | 2 of 2 |
| held-out evidence on / + ridge roofs | 17.9 / 17.4 | 27.5 / 27.1 | 25.6 / 25.3 | | | 1 of 2 (1 piece) |
Extras (our lines with no EagleView line near) unchanged on both splits; the three simple dev roofs byte-identical. Area
median dev 3.9 -> 4.2 %: right pitches (within 0.7/12 of EagleView's) on outlines already too big. CPU +19 % over 84
houses (p95 1.01 -> 1.21 s; worst house +0.9 s: the topology builds that check each shape).

## Bench
`slivers.excuseFitted` (gates file option, like `thinFaces.excuseEvidence`): a sliver carrying `fitted` is not counted
and not junk in the checker's verdict. With ridge roofs on, every new thin face is a fitted face (dev canopy-light +4,
canopy-heavy +2); no fitted sliver is made at the default floor.

## Tried and not kept
- Hip ends from the outline's eaves (`hipEnds`, off): fits nothing at the face floor; hip ends went to the skeleton track.
- Hip-ended ridge roofs (`ridgeHipEnds`, off): a hip dormer's front is 1-1.5 m2. With fitted slivers excused and the
  floor at 0.8 m2 it places 2 hip-fronted dormers on dev; their hip fronts face the wrong way; fitted faces under
  2.35 m2 are EagleView's 2 times in 8. The floor stays at 2.35 m2.
- A blurred tent profile in the fit (`shapeBlurM` 0.2 / 0.35): no more shapes, fewer right ones.
- Fans (turrets, bays) from apexes in the height map (heights falling away in every direction at a similar slope):
  2 of 25 candidates on dev at an EagleView fan apex; with the faces-fail / cone-fits filters 0 of 1. Dead end.
