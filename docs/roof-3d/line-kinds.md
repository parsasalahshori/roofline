# Line kinds: how a roof's lines are named (algorithm 7)

A report (EagleView's) counts five kinds of line: ridges, hips, valleys, eaves and rakes. The reconstruction finds the
lines well (85 to 90 % of an EagleView report's line length has a line of ours within 0.75 m) but named a good share
of them differently. Since algorithm 7 a crease between two faces is named by **which way each face drains** there
(`roof-reconstruct/topology.ts`, `creaseLine`):

| the two faces at the line | kind |
| --- | --- |
| both fall away from it | **ridge** when it is level, or when the faces are opposite each other (downhill directions 135° or more apart: fitted planes make a real ridge climb a little); otherwise **hip** |
| both come down to it | **valley** |
| one comes down to it, the other falls away (or is flat), and the line is within 25° of level on the upper face | the upper face's **eave** (the main roof's eave over a porch roof, a dormer's over the roof below). It was a valley or a hip before |
| the same, and the two slope the same way (within 30°) at nearly the same pitch (under 2/12 apart) | **pitch break**: one slope, drawn but never counted as an edge |
| anything else (the line climbs across the faces) | by the planes: convex a hip (or ridge), concave a valley |

Faces, areas, pitches and the outline are untouched by this; only line kinds and their totals change.

The estimate's priced ridge length is now ridges **plus hips** (cap shingles run along both; an exact report's ridge
length already was both), so a hip roof's free estimate no longer leaves its hip caps out.

## Measured (2026-11-21, EagleView answer keys, Google data re-bought the same day)

Median absolute error of each line total against EagleView's, per house; dev 18 houses, held-out 14:

| | ridge | hip | valley | eave | rake | area | main pitch exact |
| --- | --- | --- | --- | --- | --- | --- | --- |
| dev, algorithm 6 | 28 % | 15 % | 42 % | 24 % | 26 % | 4.0 % | 14/18 |
| dev, algorithm 7 | 19 % | 22 % | 24 % | 19 % | 26 % | 4.0 % | 14/18 |
| held-out, algorithm 6 | 19 % | 42 % | 23 % | 22 % | 17 % | 2.4 % | 7/14 |
| held-out, algorithm 7 | 12 % | 42 % | 23 % | 12 % | 17 % | 2.4 % | 7/14 |

Every gate of `gates-v3.json` passes against a fresh algorithm-6 baseline (`roof-bench/better/`). The hip figure on dev
got worse because lines that were wrongly called hips used to make up for real hips the reconstruction misses (small
hip ends and dormers merged into their neighbours); the total hip length is now 9 % short on dev and 31 % short
held-out, which is what is really missing.

## The height map beside a line checks its name (round 2, 2026-11-21)

The planes name a line; the height map beside it can say the planes are wrong there. The pixels along a line are often
another face's than the roof behind them (a hip end merged into the main slope, a gable the planes missed, a strip cut
off along a ridge, a step the planes smoothed over). Four checks in `topology.ts`, each read at stations every 0.4 m
along the line, 0.6 to 1.5 m out from it (clear of the half metre where the height map rounds an edge off), each
switched by its own parameter (`ROOF3D_TUNING='{"topology":{...}}'`):

| parameter (default) | what it does |
| --- | --- |
| `measuredEdge` (true), `measuredEaveDeg` 40, `measuredRakeDeg` 75, `measuredMinSlope` 0.1 | A face's edge (on the outline, or over a wall) is an eave or a rake by its plane, unless the roof beside it says otherwise: how it climbs away from the edge against how much it climbs or falls along it gives the edge's angle from level on the roof that is really there. Under 40 degrees a "rake" is an eave; at 75 or more an "eave" is a rake; between, the plane stands. |
| `measuredRidge` (true), `fallAwaySlope` 0.1, `ridgeAlongSlope` 0.3, `ridgeBesideM` 1.2 | A line the planes call an upper face's eave over a lower roof (a crease it drains onto, or a wall under it), with the height map falling away on both sides, is no eave. It is a ridge, unless a ridge already runs alongside within 1.2 m (the usual case: the other side of a strip the planes cut off along the ridge), and then it is a pitch break, drawn and not counted: a ridge is drawn once. |
| `valleyDropM` **0 = off by default** (0.3 is the studied value) | A valley is a trough. A "valley" with the height map 1 m out on the lower face's side 0.3 m or more below the line is the upper face's edge over a lower roof: eave or rake, and flashing on the lower face, as along a wall. Right line by line, and it costs the valley total where valleys are already short (below). |
| `hipStepM` 0.6 (0 = off) | A hip is a crest. A "hip" that climbs the upper face, with the height map 1 m out on that face's side 0.6 m or more above the line, is the upper roof's rake over the lower roof (the lower face step flashed). |

Tree crowns lean over edges, and a crown's heights are not the roof's. A name is changed only on the say of three in
four of the stations one by one (not of the median alone); heights falling away from an edge are never an eave's, and
heights climbing along an edge at over twice the face's own slope are never a rake's.

### How the rules were found

`npm run roof3d:dump -w @roofline/api -- --out DIR --set testset-ev --features` writes, beside each reconstruction,
what the topology knew about every line when it named it (`LineFeatures`: development only, never stored). Each line
was matched to the EagleView line it lies on (the per-line answer key, `roof-bench/better/evtruth.py`) and the rules
were read off cross-tabulations and shallow decision trees fitted on the DEV houses, leave one house out. What that
showed:

- **Labelling has a low ceiling.** Naming every line piece of ours perfectly (its majority EagleView kind, extras kept)
  would give same-kind shares of ridge 82, hip 72, valley 67, eave 83, rake 72 % on dev and an objective of 19.4 (an
  offline replica of the scorer, which gives algorithm 7 itself 80, 74, 66, 75, 57 % and 21.8). Hip and valley cannot
  rise by naming alone: what is wrong there is geometry (missing hips and valleys, lines of ours where EagleView has
  none).
- **A tree on all the features does not beat the hand rules** on lines between two faces (70.6 % of the length right by
  the engine, 71 to 74 % by trees of depth 3 to 6, leave one house out). The gains are in a few clear-cut pockets, and
  those are the four checks above.
- **Wrong names still cancel missing lines in the totals.** A perfect naming that also dropped our lines with no
  EagleView line near them makes the objective WORSE (24.9): false valleys, hips and eaves stand in for real ones the
  reconstruction does not find.

### Measured (dev 18 houses, held-out 14; same scorer as above)

Median error of each line total, and OBJECTIVE (their mean):

| | ridge | hip | valley | eave | rake | OBJECTIVE |
| --- | --- | --- | --- | --- | --- | --- |
| dev, algorithm 7 | 19 % | 22 % | 24 % | 19 % | 26 % | 21.9 |
| dev, the defaults (edge, ridge and hip checks) | 19 % | 25 % | 24 % | 10 % | 24 % | 20.5 |
| dev, with `valleyDropM` 0.3 too | 19 % | 25 % | 21 % | 15 % | 17 % | 19.6 |
| held-out, algorithm 7 | 12 % | 42 % | 23 % | 12 % | 17 % | 20.9 |
| held-out, the defaults | 12 % | 42 % | 23 % | 12 % | 15 % | 20.5 |
| held-out, with `valleyDropM` 0.3 too | 12 % | 42 % | 31 % | 13 % | 15 % | 22.5 |

EagleView line length with a line of ours of the same kind within 0.75 m:

| | ridge | hip | valley | eave | rake |
| --- | --- | --- | --- | --- | --- |
| dev, algorithm 7 | 79 % | 74 % | 66 % | 74 % | 56 % |
| dev, the defaults | 80 % | 73 % | 66 % | 76 % | 63 % |
| dev, with `valleyDropM` 0.3 too | 80 % | 73 % | 65 % | 77 % | 65 % |
| held-out, algorithm 7 | 80 % | 63 % | 61 % | 71 % | 68 % |
| held-out, the defaults | 80 % | 63 % | 61 % | 73 % | 69 % |
| held-out, with `valleyDropM` 0.3 too | 80 % | 63 % | 59 % | 74 % | 69 % |

The rules and their thresholds were set on dev with all four checks on; held-out was looked at once, with the four
switches on and off and nothing else changed. `valleyDropM` was turned off by default after that look (so the held-out
row for the defaults is a choice made on held-out, not a clean estimate): it renames lines that were not valleys (on
dev, none of the renamed length with a clear answer was), so the valley total falls to what the reconstruction really
finds (dev sum -4 % to -13 %, held-out -19 % to -29 %), and on held-out the total's median error rose from 23 to 31 %.
Wrong valleys make up for missing ones; the check belongs on once the missing valleys are found.

Each of the other three alone or together stays under algorithm 7 on both splits (objective, dev / held-out: edge
20.7 / 20.3; edge and hip 21.0 / 20.0; edge and ridge 20.1 / 20.8; all three 20.5 / 20.5): the differences between
them are the noise of medians over 18 and 14 houses. `hipStepM` costs the hip total's median error on dev (22 to 25 %)
for the same reason as the valleys, and the same-kind share of hips a point: a wrongly named line near a real one used
to count as finding it.

## Tried and not kept (same benchmark)

- Naming every same-way, same-pitch pair a pitch break whatever the line's direction: lost real hips and valleys
  between faces whose fitted planes came out alike.
- Eave or rake read from the height map along the edge instead of from the face's plane: the height map along an
  edge is too noisy (turned 2,000 ft of eaves into rakes).
- Snapping face pitches to the roof's dominant whole pitches: the dominant pitch itself is off by one where it is
  wrong (the height map's own scale), so snapping moved more main pitches away from the report than towards it.
- Dissolving narrow same-way strips and small flat pockets: right on simple roofs the height map bows (one house's
  line error halved), wrong on complex roofs, where the strips are real small faces; nothing at hand tells them apart
  (Google's own segment count over-counts the same bowed roofs).
- `eaveDeg` 50 to 60 instead of 45: eaves better, rakes worse by as much.
- (Round 2) A ridge by its plan angle (a convex crease within 25 to 30 degrees of level on both faces is a ridge even
  when the fitted planes make it climb): right on every line it renamed that had a clear answer (40 ft ridge, 0 ft hip
  on dev), but half of them have no EagleView line at all, and the hip total's median error rose from 22 to 29 %.
- (Round 2) A crease whose planes are apart at the drawn line (0.4 to 1.5 m) taken as the upper face's edge: renames
  real hips and valleys as well (dev: of the renamed valley length with a clear answer, a third was a valley).
  `valleyDropM` asks the height map instead and renames none.
- (Round 2) An outline edge named by the face that holds the roof 1 m in from it instead of the face whose pixels touch
  it: right twice as often as wrong, but a third of what the height-map check gets.
- (Round 2) A ridge beside a dead-level face taken for a flat roof's edge: one house.

## What is left

Real hips, valleys and rakes the reconstruction does not have at all (10 to 17 % of their length): dormers and small
hip ends the 0.1 m height map blurs into their neighbours. Walls where a lower roof meets a taller part are still
sometimes drawn as a valley when the step is small (a dormer's cheek). Both need more than the height map (the photo's
edges, or a second data source).
