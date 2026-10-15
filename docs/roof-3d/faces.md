# Faces track: seed stability, thin edge faces, steep faces

## Problem

- **Seed instability.** The plane search drew its RANSAC candidates and its scoring sample at random. At seeds 7, 8
  and 9 the dev split gave materially different roofs on 28 of 54 houses (face count, checker verdict, area). A price
  must not depend on a random seed.
- **Thin faces along the outline** (the owner's 305 Ridgeway Dr screenshot): faces over 25 sq ft but under 0.9 m
  wide (62 on dev at the baseline), strips along eaves and rakes whose plane is a gutter, a wall or foliage.
- **Faces steeper than 18/12** survive when Google's segments allow 24/12 for the whole roof (2018 N Tyler St).

## Approach

1. **Lattice search** (`planes.ts`, `lattice: true`). Candidate seeds sit on a square lattice over the free pixels
   (step chosen so about `candidates` pixels fall on it, shrinking as pixels are used) and each candidate is scored
   on an evenly spread sample; ties go to the lower pixel index. The outcome no longer reads the random stream
   (property test: any rng gives the same planes).
2. **Weak-face cleanup** (`faces-cleanup.ts`, called from the post-topology loop in `index.ts`). Each face gets a
   support record (polygon width 2A/P, area, pitch, interior plane share, smallest angle to a neighbour, share of its
   boundary on the outline). Dissolved into their neighbours (pixels flood to the best-fitting neighbour plane, which
   is refitted on the union), with a typed reason counted on `LocalRoof.dissolved`:
   - `thin-edge`: polygon under 0.9 m wide and 12 m2 with a quarter of its boundary on the outline;
   - `thin-coplanar`: thin and within 8 degrees of a neighbour (one face cut in two);
   - `steep-unsupported`: over 18/12 and thin, or under 0.88 of its interior on its plane.

## Evidence that shaped it

- Interior thin faces are kept on purpose: EagleView itself has 122 of 390 dev faces (25 sq ft or more) under 0.9 m
  wide (dormer and bay faces). Dissolving every thin face cost area on steep roofs (ev-52191863 -3.3 -> -4.6 %).
- The interior plane share does not separate junk strips from real faces: a 0.8 m strip is trivially planar
  (305 Ridgeway's strip is 0.94 on its plane). So the rule for strips on the outline is geometric, not support-based.
- A pixel-thickness measure (largest inscribed disc) was tried and rejected as a criterion: topology's straight creases
  make polygons much thinner than their pixel regions, so it did not separate the cases (kept in the debug output).

## Results (dev split, 54 houses, mean of seeds 7/8/9, same harness, baseline = 5cabb413)

| metric | baseline | after |
| --- | --- | --- |
| houses whose seeds differ materially | 28 / 54 | 0 / 54 (byte-identical across seeds) |
| thin faces (all / simple / canopy-heavy / canopy-light) | 62.3 / 4.3 / 10 / 33.3 | 32 / 0 / 3 / 21 |
| faces over 18/12 (any) / steep junk / slivers | 3 / 0 / 0 | 2 / 0 / 0 |
| median abs area error (18 key houses) | 4.0 % [3.9-4.1] | 4.1 % |
| main pitch exact / within 1 (of 18) | 12 [11-13] / 15.3 [14-16] | 12 / 14 |
| per-face pitch error (area-weighted, median) | 0.62 [0.57-0.69] | 0.53 |
| valley / hip / ridge / eave / rake vs EagleView | +24.6 / -0.1 / -23.9 / -23.1 / -2.7 % | +22.1 / +0.6 / -22.9 / -25.2 / +0.8 % |
| checker passing | 33.7 [33-35] / 54 | 34 / 54 |
| gates | - | all 174 pass |

Worse: main pitch within 1/12 (15.3 -> 14 of 18, inside the old seed range 14-16), eave -23.1 -> -25.2 %,
canopy-heavy hip -4.1 -> -24.7 % (2 key houses), runtime p95 in the bench (see below).

Runtime: the bench's p95 rose to 1.2-1.6x the baseline's while five agents shared the machine; the last run failed the
runtime gate on the EagleView and steep cohorts (1.56x, limit 1.5) with every other gate passing, an earlier run of
the same rules passed all 174. A same-process A/B on the 15 steep dev houses shows no cost from this track: random
search, cleanup off 9.7-10.6 s; lattice, cleanup on 9.8 s. The calibration loop is arithmetic and does not see memory
contention. A re-run of the committed code passed all 174 dev gates (p95 958 ms).

## Sensitivity (dev, 54 houses; faces 631 / thin 33 / >18/12 2 with the defaults; cleanup off: 657 / 59 / 4)

| constant | -20 % | +20 % |
| --- | --- | --- |
| thinWidthM 0.9 | thin 57 (almost off) | thin 34, max area change 1.6 % |
| edgeShare 0.25 | thin 30 | thin 36 |
| thinMaxM2 12 | thin 36 | thin 33 |
| distinctDeg 8 | thin 35 | thin 31 |
| keepShare 0.88 (-20 %) | no change | - |

`thinWidthM` is the sensitive one, by construction: most strips sit between 0.72 and 0.9 m, the same band the
benchmark counts as thin. Median area change is 0.00 % for every variant (max 1.6 % except "off").

## Alternatives rejected

- *Consensus over several seeds*: 3-5x the runtime; the median of discrete face sets is not well defined.
- *More random candidates*: lowers the variance, never removes it.
- *Dissolve every thin face / every weakly supported thin face*: hurts real dormer faces and area on steep roofs.

## Risks

- A lattice can sit badly against a small face (the same density as the old random draw; synthetic dormer and porch
  tests pass).
- A real narrow face along the outline (a bay's hip end under 0.9 m average width) is dissolved; its area goes to the
  neighbour at the neighbour's pitch.
- Held-out not looked at (integrator).

## Rollback

`planes: { lattice: false }` restores the random search; `faces: { enabled: false }` turns the cleanup off; or revert
the commits. No stored data changes shape (`dissolved` lives on LocalRoof only, not in Roof3d snapshots).

## Not done

- Slope-proportional tolerance in the first RANSAC pass for steep roofs (FM08); Google segments as a plane prior.
- Line tidying after merges (jagged valleys); valley overshoot is only slightly down.
- A per-face support/confidence value in the stored Roof3d (would change the snapshot schema owned by another track).
