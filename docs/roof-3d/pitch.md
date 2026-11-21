# The pitch a face reports (track: pitch, roof accuracy round 2)

Branch `roof2/pitch`. Code: `packages/shared/src/roof-reconstruct/pitch.ts` (`reportedPitches`), wired at the end of
`reconstructRoof` (`index.ts`) behind `ReconstructOptions.pitch`; the server's calibration is
`GOOGLE_PITCH_OFFSET_X12` in `apps/api/src/estimator/roof-3d.ts`. Tests: `packages/shared/test/roof-reconstruct-pitch.test.ts`,
`apps/api/test/bench/pitch.test.ts`. Switches (through `ROOF3D_TUNING`):

| parameter | default | off |
| --- | --- | --- |
| `pitch.pool` | `true` (engine) | `{"pitch":{"pool":false}}` |
| `pitch.offsetX12` | `0` in the engine, `0.25` from the server (Google's height maps) | `{"pitch":{"offsetX12":0}}` |

With both off the output is byte for byte what it was (checked on the 34 EagleView houses' dumps).

## Problem

A roofer quotes by the main pitch (a whole number over 12) and the sloped area; both come from each face's pitch. At
algorithm 7 a matched face of 100 sq ft or more was within 0.5/12 of EagleView's pitch on 56 % of dev faces (74 % of
faces of 300 sq ft or more, 44 % of faces of 100 to 200 sq ft), and the main pitch was exact on 14 of 18 dev houses.

## What the table says (dev, 174 matched faces)

`work-pitch/table.py` reads, for every matched face, our pitch, EagleView's, and a family of other readings of the
height map on our face's pixels and on EagleView's own polygon.

1. **The fit is not the limit; the height map is.** No estimator beats the engine's (trimmed least squares at 0.1 m,
   0.2 m in from the face's edge): interior only (0.5 to 1.2 m in), Huber, Tukey, a fit along the fall line, the eave
   strip to the ridge strip, the median gradient: 30 to 57 % within 0.5/12 against the engine's 56 %, and every one
   loses main pitches (8 to 13 of 18). On EagleView's own polygons (perfect segmentation) the best reading is 59 %.
   Of the 76 faces off by more than 0.5/12, 57 are off on EagleView's polygon too.
2. **Google's segments are no second opinion.** `buildingInsights` pitch at the face: 48 % within 0.5/12 (ours 57 % on
   the same faces), the same bias house by house, more noise; the mean of the two 54 %.
3. **A per-house scale or tilt is real but cannot be read blind.** Fitted on the answer key itself, a per-house scale
   lifts 58 to 64 %, a per-house tilt (one face steeper, the opposite one shallower) to 63 %. Without the key the tilt
   estimate is wrong on exactly the houses that have one (a one-pitch hip seen through a tilt looks like a two-pitch
   roof); four forms were tried (a tilt solved with the pitch groups, ridge-pair midpoints, wide groups first, merging
   groups that face opposite ways): 62 to 69 % against 67 to 70 % for pooling alone, main pitch 11 to 13.
4. **Faces of one pitch are readings of one number.** Grouped by their true pitch, the pooled reading rounds to
   EagleView's pitch for 21 of 27 groups: the scatter is face by face (0.65/12 median error at 100 to 200 sq ft, 0.28 at
   400 to 800), not group by group.
5. **The height map reads steep by about a quarter of a twelfth.** The pitch group holding the most roof is above
   EagleView's whole number on 17 of 18 dev houses: median +0.23, mean +0.27, and the same at 5/12 (+0.07, +0.22,
   +0.24) as at 12/12 (-0.10 to +0.41): an offset, not a scale. (A scale of 0.975 is a knife edge for 12/12 roofs:
   0.965 loses 10 points.)

## Approach

`reportedPitches(faces, params)`, on each face's own plane pitch and plan area, after the faces are final:

1. Faces under `minPitchX12` (2/12) keep their reading and join nothing.
2. The pitch (one of the faces' own) with the most roof within tolerance of it is found, settled on its own median, and
   every face within tolerance reports that median. Then the same among the faces left, until a group would have fewer
   than `minFaces` (2) faces or less than `minShare` (5 %) of the sloped roof's plan area. No reassignment afterwards:
   the pitch holding the most roof takes every face that could be a reading of it (re-sorting faces to their nearest
   group splits a tilted one-pitch hip in two: 13 of 18 main pitches).
3. A face's tolerance: `tolX12` (1/12) at `refM2` (28 m2, 300 sq ft) or more, growing as sqrt(28 / area) to
   `smallTolX` (1.5) times that for small faces, and never more than `capShare` (20 %) of the group's pitch (a 3/12
   porch roof beside a 4/12 roof stays 3/12).
4. The group's pitch is the area-weighted median, interpolated (two equal faces give their mean; the plain lower median
   jumped between two readings with the last digit of an area, and read low).
5. `offsetX12` comes off every face (at most `offsetShare`, 10 %, of the pitch). The engine's default is 0: on true
   heights it reports what it measures. The server passes 0.25 for Google's height maps.

Only `pitchX12` and `slopedAreaM2` change. `plane` stays the fitted plane, so creases, line kinds and lengths are
untouched (the scorer's line totals are identical), and `flat` is still the plane's.

Not snapping: nothing is rounded, and a group's pitch comes from its faces, not from a list of whole numbers.

## Results (the round's scorer, `score.sh`; faces: `work-pitch/facecmp.py`, matched as `pitchcmp.py` does)

Dev (18 houses, 174 matched faces of 100 sq ft or more):

| | main pitch exact | within 1 | area median | faces within 0.5/12 | 300 sq ft up | 100 to 200 sq ft | median error | OBJECTIVE |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| algorithm 7 | 14/18 | 16/18 | 4.0 % | 56.3 % | 74 % | 44 % | 0.46 | 21.9 |
| pooling only | 13/18 | 15/18 | 3.9 % | 67.2 % | 76 % | 59 % | 0.30 | 21.9 |
| offset only | 14/18 | 15/18 | 3.7 % | 58.0 % | 74 % | 42 % | 0.39 | 21.9 |
| pooling + offset | 15/18 | 15/18 | 3.8 % | 73.0 % | 90 % | 60 % | 0.24 | 21.9 |

HELDOUT_TABLE

Per house on dev (faces within 0.5/12, before -> after): better on 14, the same on 2, worse on 2 (`ev-47737198` 3 -> 2
of 15, `ev-52191050` 8 -> 7 of 8). Main pitch: `ev-51881820` (the bowed simple roof) 7 -> 6, right; `ev-47737198` 13 -> 10
against 12 (one off before, two off now: its faces read 9 to 13.5 in one smear, and the group holding the most roof is
the 10/12 half); `ev-50319846` and `ev-51881922` stay wrong (below).

Sensitivity (dev, pooling + offset, each moved alone): `tolX12` 0.8 / 1.2: 70.7 / 71.8 % of faces, 14 / 15 main
pitches; `capShare` 0.15: 71.8 %, 15; `smallTolX` 1.0 / 2.0: 71.8 / 73.0 %, 15 / 15; offset 0.2 to 0.35: 73 to 74 %,
15 (0.1: 68 %, 14; 0.4: 65 %, 14).

## What it does not fix

- **Roof drawn as the wrong faces.** `ev-51881922` (main pitch 8 against 10): 250 sq ft of 10/12 dormers lie inside
  our 8/12 faces. `ev-50319846` (8 against 12): the 12/12 faces read 13.4 to 16 on the height map itself and steep roof
  is short. `ev-51881820`: the bowed north slope is still cut into a 4/12 face and an 11/12 strip (its main pitch is
  right now because the other faces carry it); merging same-way strips belongs to the faces.
- **The area misses.** `ev-51881820` +11 %: its plan area is 10.5 % over EagleView's (the outline), not its pitch.
  HELDOUT_AREA
- **A tilted roof whose two halves fall in two groups** (`ev-50319630`: north and west faces 6.9, south and east 5.2,
  EagleView 6 all round): the larger group reports 6.3, the east face still 4.8.

## Risks

- The offset is one number from 18 houses (17 independent: two keys are one house). It is a property of Google's
  processing and could change with it; it is applied in the server wrapper, not in the engine, and is one constant.
- Pooling makes a group's faces rise and fall together: when the group's pitch is wrong every face in it is.
  On a roof whose pitches are 1/12 apart (7 and 8) the two can pool into one.
- Lidar-fused faces (off by default) get the same pooling and offset as Google's; the offset should not apply to a
  face measured by lidar if fusion is ever turned on.
