# Outline track: wing-aware squaring, attachments, edge precision

Round of 2026-10-14, branch `edge/outline` from `e3ae9615` (reconstruction of `5cabb413`). Result: **no change to the
reconstruction ships from this track.** What ships is a test suite that pins the squaring down (synthetic footprints
and metamorphic properties) and this note, which records what was tried, measured, and rejected, so the next attempt
starts from numbers instead of the taxonomy's hypotheses.

## Problem

The failure taxonomy (`roof-bench/analysis/failure-taxonomy.md`, modes 3, 6, 9) named three outline levers: one
global axis for multi-wing houses (FM09), non-roof attachments inside the outline (FM06), and chamfers or stair-steps
where canopy hides the eave (FM03).

## How it was measured

The bench's outline IoU is against raw EagleView, which sits about 1 m east and 0.5 m south of Google. Until the
hardening track adds an aligned metric to the bench, an outside scorer was used
(`/Users/parsasalahshori-a/RooflineWork/roof-bench/outline-track/score-outline.mts`, run from a worktree's
`apps/api`): dev split only, EagleView shifted by one translation per house **frozen from the baseline outline**
(`outline-track/shifts.json`, grid search of +-3 m, 0.1 m) so that before and after are scored in the same frame;
precision and recall = share of boundary samples (every 0.2 m) within 0.5 m of the other boundary; plan-area error
against EagleView's outline; diagonal edges (> 12 degrees off the outline's own rectilinear frame); mask IoU, OSM IoU.

Baseline, dev split (18 EagleView single-structure houses, 54 houses in all), seeds 7 / 8 / 9:

| metric | seed 7 | seed 8 | seed 9 |
| --- | --- | --- | --- |
| aligned IoU, median (mean) | 0.9266 (0.9110) | same | same |
| precision / recall at 0.5 m, mean | 83.2 % / 81.6 % | same | same |
| mean boundary distance, median | 0.306 m | same | same |
| plan area error vs EagleView outline, median | 5.93 % | same | same |
| sloped area error, median | 4.09 % | 3.94 % | 4.02 % |
| diagonal edges, all 54 houses | 330 | 330 | 330 |
| mask IoU (proxy), median | 0.9708 | 0.9708 | 0.9708 |

The outline does not depend on the seed on any dev house (the terrace cut, which does, is not exercised in dev).

## What was tried

1. **A boundary-chord axis estimator.** `mainAxis` averages simplified-edge directions (4-theta mean, weighted by
   length squared). On a turned roof the simplified edges include grid-aligned pixel stair-steps, which pull the axis
   towards the grid: on ev-50319846 the axis came out 12.2 degrees where EagleView's walls are at 18.4. A histogram of
   2 m chords on straight stretches of the pixel boundary, refined either by the votes' circular mean or by a
   projection-sharpness search, finds 17.0 / 35.9 / 57.9 degrees on synthetic L-shapes turned 17 / 36 / 58 (within
   0.25 degrees), and fixed ev-50319846 (axis error 8.5 -> 2.5 degrees; edges > 6 degrees off EagleView 25 -> 11).
   But across the 18 EagleView houses it was **worse**: precision 83.2 -> 81.7 %, recall 81.6 -> 79.7 %, aligned IoU
   median 0.9266 -> 0.9241, diagonal edges 330 -> 358; with the histogram's main peak and a mean refine, 81.1 / 79.8 %.
   The projection refine snaps houses turned 3 to 4 degrees onto the grid (ev-50319630: precision 98 -> 81 %), the
   mean refine leans to the stairs' rational slopes. Mask IoU went up (0.9708 -> 0.9720) while EagleView agreement went
   down: fitting Google's mask more tightly does not fit EagleView better. **Rejected.**
2. **Per-wing axes** (the old main axis kept; further histogram peaks at least 15 degrees from every axis, with at
   least 25 % of the main axis's votes and 8 m of straight boundary, become extra snap axes). On dev it changes 2 of
   54 houses, neither with EagleView (tr-houston-879083062 mask IoU 0.950 -> 0.975, tr-austin-381786736 unchanged,
   both gain diagonal edges along the second wing); every EagleView number is identical. On synthetic two-wing houses
   (pipeline-cleaned masks) it is no better than the base: edges of a wing turned more than 12 degrees are already left
   free and refitted to their own boundary pixels, and snapping them to an *estimated* second axis adds that
   estimate's error (worst edge 4.1 degrees either way). No measurable benefit, extra code: **not shipped**. The full
   run passed every bench gate except runtime p95, which failed in 7 cohorts at 1.55-1.6x while the machine's load
   average was 11 (the axis search costs 0.37 ms a house).
3. **Attachments (FM06) and canopy-edge bridging (FM03): not attempted** in the time box. Notes for whoever takes
   them: of the four over-measured houses, ev-50264843, ev-51881820 and ev-52191672 are dev; the extra area on
   ev-52191672 is a flat rectangular bump on the east side, on ev-51881820 a lower block at the south-west. Both need
   the faces (a flat face at or below the adjoining eaves) and so cross into planes/topology. FM03 needs the
   confidence track's eave-support feature, which did not exist yet at this round's start.

## Tests added

`packages/shared/test/roof-outline.test.ts` (hermetic, seeded, under a second):

- L, T, U and cross footprints turned 3 to 80 degrees, rasterised at 0.1 m with ragged edges and cleaned the way the
  reconstruction cleans the mask: every squared edge of 2 m or more within 2 degrees of the truth.
- Two-wing houses (wings turned 25 to 45 degrees against each other): every edge of 2.5 m or more within 4.5 degrees.
- Metamorphic: a quarter turn of the mask turns the outline (Hausdorff under 0.3 m, area within 0.5 %); doubling the
  pixel size with every length parameter doubled doubles it (Hausdorff under 0.3 m, area within 1 %); determinism.

They pass on the base commit: they are guards for the next change to `outline.ts`, not reproductions of a bug.

## Alternatives rejected

Tuning outline constants (the taxonomy's +-20 % sweep moved precision by under 0.7 points); judging by mask IoU or
the bench's raw IoU (both reward the wrong thing here, see 1).

## Risks and open questions

- Whether EagleView and Google differ by a small rotation per house as well as the translation: the median angle
  between our outline's rectilinear frame and EagleView's is 4.5 degrees on the 18 dev houses, which is more than the
  axis estimators disagree by. If it is a rotation of EagleView's frame, every axis improvement is scored against a
  turned answer key and the "worse" in 1 may not be real. Worth checking with rotation-aware alignment before anyone
  retries 1.
- Rollback: nothing to roll back; the tests can be deleted without effect on the product.
