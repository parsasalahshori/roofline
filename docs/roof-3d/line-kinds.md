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

## What is left

Real hips, valleys and rakes the reconstruction does not have at all (10 to 17 % of their length): dormers and small
hip ends the 0.1 m height map blurs into their neighbours. Walls where a lower roof meets a taller part are still
sometimes drawn as a valley when the step is small (a dormer's cheek). Both need more than the height map (the photo's
edges, or a second data source).
