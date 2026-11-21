# The pitch a face reports (track: pitch, roof accuracy round 2)

Branch `roof2/pitch`. Code: `packages/shared/src/roof-reconstruct/pitch.ts` (`reportedPitches`), wired at the end of
`reconstructRoof` (`index.ts`) behind `ReconstructOptions.pitch`; the server's calibration is
`GOOGLE_PITCH_OFFSET_X12` in `apps/api/src/estimator/roof-3d.ts`; the check against Google's segments
(`roof-3d-compare.ts`) reads the face's fitted pitch. Tests: `packages/shared/test/roof-reconstruct-pitch.test.ts`,
`apps/api/test/bench/pitch.test.ts`. Switches (through `ROOF3D_TUNING`):

| parameter | default | to turn off / on |
| --- | --- | --- |
| `pitch.pool` | `true` (engine) | `{"pitch":{"pool":false}}` |
| `pitch.offsetX12` | `0` in the engine, `0.25` from the server (Google's height maps) | `{"pitch":{"offsetX12":0}}` |
| `pitch.offsetArea` | `false`: the sloped area keeps the pitch before the offset | `{"pitch":{"offsetArea":true}}` |

With `pool` false and `offsetX12` 0 the output is byte for byte what it was (the 34 EagleView houses' dumps compared).

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
5. **Google's height map reads steep by about a quarter of a twelfth.** The pitch group holding the most roof is above
   EagleView's whole number on 17 of 18 dev houses: median +0.23, mean +0.27, and the same at 5/12 (+0.07, +0.22,
   +0.24) as at 12/12 (-0.10 to +0.41): an offset, not a scale (a scale of 0.975 is a knife edge for 12/12 roofs:
   0.965 loses 10 points). **USGS lidar says the same, independently** (`work-pitch/lidarpitch.py`, the benchmark's
   lidar planes, 16 dev houses whose main pitch group is the same in all three): lidar against EagleView median -0.04
   (within 0.2 on all 16), ours against lidar median +0.25, above on 16 of 16. So it is Google's surface, not
   EagleView's rounding.

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
   jumped between two readings with the last digit of an area, and read low, which hid part of the offset).
5. `offsetX12` comes off every face (at most `offsetShare`, 10 %, of the pitch). The engine's default is 0: on true
   heights it reports what it measures (the synthetic roofs in the tests read within 0.2/12 of their true pitch). The server passes 0.25 for Google's
   height maps.

What changes on a face: `pitchX12` (the reported pitch) and `slopedAreaM2` (plan area times the slope factor of the
pooled pitch, before the offset unless `offsetArea`). What does not: `plane` (the fitted plane), so creases, line kinds
and lengths are untouched (the scorer's line totals are identical), and `flat`. The fitted pitch is kept on the face
(`LocalFace.fitPitchX12`; stored as `Roof3dFace.fitPitchX12` only where it differs from the reported one).

Not snapping: nothing is rounded, and a group's pitch comes from its faces, not from a list of whole numbers.

### Two things the benchmark's gates asked for

- **Google's segment is held against the fitted plane.** `checkRoof` compared `pitchX12` with Google's segment under
  the face (within 1/12, or the roof is marked `differs-from-google`). The segment is a plane fitted to the same
  heights; a pitch pooled and calibrated away from it is not a disagreement about the heights. With the reported pitch
  the houses passing every target fell from 33 to 31 (dev) and 20 to 13 (held-out); with `fitPitchX12 ?? pitchX12`
  they are as before.
- **The sloped area does not follow the offset (yet).** When it did, the dev median area error fell (4.0 to 3.8 %) but
  the held-out one rose (2.4 to 3.3 %, gate limit +0.5), and the error against lidar's sloped area rose 0.7 to 0.8
  points on every cohort. Our plan areas run under on those houses (median signed error -1.6 % on held-out, 8 of 14 under) and the
  steep reading was hiding about 1 % of that. `pitch.offsetArea` is the switch for when the outline no longer runs
  under. So a face's sloped area is its plan area at the pooled pitch, 0.25/12 steeper than the pitch it reports
  (0.8 % of area at 6/12, 1.0 % at 12/12).

## Results (the round's scorer, `score.sh`; faces: `work-pitch/facecmp.py`, matched as `pitchcmp.py` does)

Dev (18 houses, 174 matched faces of 100 sq ft or more):

| | main pitch exact | within 1 | area median | faces within 0.5/12 | 300 sq ft up | 100 to 200 sq ft | median error | OBJECTIVE |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| algorithm 7 | 14/18 | 16/18 | 4.0 % | 56.3 % | 74 % | 44 % | 0.46 | 21.9 |
| pooling only | 13/18 | 15/18 | 3.9 % | 67.2 % | 76 % | 59 % | 0.30 | 21.9 |
| offset only | 14/18 | 15/18 | 4.0 % | 58.0 % | 74 % | 42 % | 0.39 | 21.9 |
| **pooling + offset (default)** | **15/18** | 15/18 | **3.9 %** | **73.0 %** | **90 %** | **60 %** | **0.24** | 21.9 |
| the same, area following the offset | 15/18 | 15/18 | 3.8 % | 73.0 % | 90 % | 60 % | 0.24 | 21.9 |

Held-out (14 houses, 92 matched faces), looked at once, after the parameters were committed:

| | main pitch exact | within 1 | area median | faces within 0.5/12 | 300 sq ft up | 100 to 200 sq ft | median error | OBJECTIVE |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| algorithm 7 | 7/14 | 13/14 | 2.4 % | 57.6 % | 62 % | 48 % | 0.38 | 20.9 |
| pooling only | 7/14 | 13/14 | 2.4 % | 59.8 % | 74 % | 48 % | 0.19 | 20.9 |
| offset only | 7/14 | 13/14 | 2.4 % | 60.9 % | 67 % | 52 % | 0.37 | 20.9 |
| **pooling + offset (default)** | **8/14** | 13/14 | 2.4 % | **67.4 %** | **79 %** | **55 %** | 0.39 | 20.9 |
| the same, area following the offset | 8/14 | 13/14 | 3.3 % | 67.4 % | 79 % | 55 % | 0.39 | 20.9 |

Per house, faces within 0.5/12, before -> after. Dev: better on 14, the same on 2, worse on 2 (`ev-47737198` 3 -> 2 of
15, `ev-52191050` 8 -> 7 of 8). Held-out: better on 8, the same on 2, worse on 3 (`ev-50332002` 2 -> 1 of 4,
`ev-51881772` 2 -> 0 of 6, `ev-52192091` 1 -> 0 of 4).

Main pitch. Dev: `ev-51881820` (the bowed simple roof) 7 -> 6, right; `ev-47737198` 13 -> 10 against 12 (one off
before, two off now: its faces read 9 to 13.5 in one smear and the group holding the most roof is its 10/12 half);
`ev-50319846` and `ev-51881922` stay wrong (below). Held-out: `ev-50264667` 6 -> 5, right. The six still wrong:
three read 7 against 8 (`ev-47743011`, `ev-50288987`, `ev-51881772`: on the two with a usable lidar pitch, Google's
surface is 0.85/12 shallower than lidar there, the opposite of the usual), two read 7 against 6 (`ev-52191405`,
`ev-52192091`: 0.3 and 1.1 steeper than lidar), and `ev-51883255` reads 8 against 12 (the steep faces are short).

The offset on held-out: Google reads steeper than lidar on 6 of 10 houses, median +0.12 (dev: 16 of 16, +0.25). The
median face error does not move with it there (0.38 to 0.39; pooling alone 0.19): 0.25 is on the high side for those
14 houses. It was not changed after the look.

Sensitivity (dev, the engine, each moved alone from the default 73.0 % of faces, 15 main pitches, area 3.9 %):

| moved | faces within 0.5/12 | main pitch exact | area median |
| --- | --- | --- | --- |
| `tolX12` 0.8 / 1.2 | 70.7 / 71.8 % | 14 / 15 | 3.9 / 3.9 % |
| `capShare` 0.15 / 0.3 | 70.7 / 73.0 % | 15 / 15 | 3.9 / 3.9 % |
| `smallTolX` 1 / 2 | 71.8 / 73.0 % | 15 / 15 | 3.9 / 3.8 % |
| `minShare` 0.1 | 73.6 % | 15 | 3.9 % |
| `offsetX12` 0.15 / 0.35 | 69.5 / 74.1 % | 14 / 15 | 3.9 / 3.9 % |

Every variant keeps the gain over algorithm 7 (56.3 %, 14). None was chosen from this table.

Gates (`roof3d:bench --split all --compare baseline-v7.json --gates gates-v3.json`): dev 349 pass, 0 fail; held-out 264
pass, 0 fail; held-out against dev 2 pass. "All gates pass."

## What it does not fix

- **Roof drawn as the wrong faces.** `ev-51881922` (main pitch 8 against 10): 250 sq ft of 10/12 dormers lie inside
  our 8/12 faces. `ev-50319846` (8 against 12): the 12/12 faces read 13.4 to 16 on the height map itself and steep roof
  is short. `ev-51881820`: the bowed north slope is still cut into a 4/12 face and an 11/12 strip (its main pitch is
  right now because the other faces carry it); merging same-way strips belongs to the faces.
- **The area misses are plan area, not pitch.** `ev-51881820` (+11 %): our outline holds 10.5 % more plan area than
  EagleView's. `ev-47747994` (-22 %): our plan area is 7,262 sq ft against 9,533; Google's mask has no lanai cover on
  the south, no wide lower roof along the west side and stops short along the north-east eave. `ev-52191132` (-54 %):
  the south-east wing is under trees (plan 1,886 against 2,755 sq ft, flagged `roof-hidden`), and the key itself
  counts near-vertical faces (26/12 to 120/12: parapet and wall faces) as sloped roof: its sloped total is 1.56 times
  its plan area on a 3/12 roof. No height map gives that area.
- **A tilted roof whose two halves fall in two groups** (`ev-50319630`: north and west faces 6.9, south and east 5.2,
  EagleView 6 all round): the larger group reports 6.3, the east face still 4.8.
- **A house whose surface reads the other way** (the three 7-against-8 held-out houses): one offset cannot serve both.

## Risks

- The offset is one number from 18 houses (17 independent: two keys are one house), confirmed by lidar on dev and
  weaker on held-out. It is a property of Google's processing and could change with it; it lives in the server
  wrapper as one constant, not in the engine.
- The sloped area and the reported pitch differ by the offset until `offsetArea` is turned on: a face's sloped area is
  about 1 % more than its plan area at the reported pitch.
- Pooling makes a group's faces rise and fall together: when the group's pitch is wrong every face in it is. On a roof
  whose pitches are 1/12 apart (7 and 8) the two can pool into one.
- Stored roofs gain an optional field (`fitPitchX12`); roofs stored before have none and are compared with Google's
  segments on `pitchX12` as before.
- Lidar-fused faces (off by default) get the same pooling and offset as Google's; the offset should not apply to a
  face measured by lidar if fusion is turned on.
