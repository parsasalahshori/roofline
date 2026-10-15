# Eave support reads the whole edge (algorithm 6)

Track: support (lidar round, October 15 2026). Base fb0b63db (algorithm 5). DEV split only for every choice below.

## Problem

`eave-support.ts` placed its samples at step/2, 3 step/2, ... along each outline edge but clamped each one with
`tt = Math.min(t, L / 2)`, so every sample past an edge's midpoint landed ON the midpoint. The second half of every edge
was never measured and the midpoint was counted once per missing sample. Everything downstream inherited it:

- per-edge support, `unverifiedShare`, reason and `confidence` (Roof3d.edges, the dashed edges in the roof view);
- the house's `quality.edgeSupport` and the `edges-unverified` review reason;
- the confidence calibration (its sample counts were midpoint-weighted);
- the hidden-edge share gates of outline-photo.ts (`minHiddenShare`) and outline-planes.ts (`hiddenShare`), off by
  default: an edge counted as hidden when its midpoint was;
- the benchmark's hidden-edge sets with the default 'midpoint' scorer (lidar.ts `supportAlong`).

Reproduced first (failing on fb0b63db, passing after): `packages/shared/test/eave-support.test.ts` "eave support samples
the whole edge" (a deck at eave height beside the north half of the east edge is not seen at all; first and second halves
weigh differently; samples repeat; 0.25 m MEDIUM case), and `apps/api/test/bench/confidence.test.ts` "a tree crown beside
one half of an eave counts the same whichever way the outline runs" (forward ring 0.004 unverified on the base).

## Approach

- **Sampler.** Each edge is cut into `count = max(1, round(L / step))` equal pieces and read once at the middle of each.
  Every stretch is measured once, both halves weigh the same, an edge shorter than 1.5 steps gets one sample at its
  middle, and the per-sample length `L / count` keeps the length-weighted shares exact. Outline-lidar.ts and the bench's
  'dense' scorer feed pieces of at most one step, which still get exactly one sample at their middle: unchanged.
- **Edge confidence.** Three classes instead of two, `edgeConfidence()` in roof-3d.ts: strong 0.87, weak 0.71,
  unverified 0.51 (chance a stretch lies within 0.5 m of an independent outline). Measured with
  `apps/api/src/scripts/roof-3d-support-calib.ts` (DEV only, seed 7) on every eave-support sample against the
  translation-aligned EagleView outline (18 houses) and the translation-aligned lidar-truth outline (26 houses):

  | class | EagleView within 0.5 m | lidar within 0.5 m | pooled (shipped) |
  | --- | --- | --- | --- |
  | strong | 0.870 (n 6,723) | 0.862 (n 6,390) | 0.87 |
  | weak | 0.742 (n 422) | 0.692 (n 682) | 0.71 |
  | unverified | 0.581 (n 944) | 0.477 (n 2,109) | 0.51 |

  Midpoint sampler on the same scorer: verified 0.868 / unverified 0.518 (EagleView), 0.855 / 0.433 (lidar). The fix
  makes the unverified class less pessimistic by 5-6 points: the old one double-counted midpoints that sat in crowns.
  Sensitivity, weakM +-20% (0.4 / 0.6): pooled unverified 0.499 / 0.511, weak 0.695 / 0.772, strong unchanged.
  The flag and the confidences read only Google's layers, never lidar, so scoring them on lidar truth is not circular.
- **`edges-unverified` threshold: kept at share >= 0.25 and >= 20 ft.** With whole-edge sampling the house shares move
  by a median +0.006 (-0.10 to +0.12) and the 23 flagged DEV houses are exactly the same 23. Outline error defined
  before looking at the flag: aligned IoU < 0.85 (the bench's OUTLINE_CHECK_IOU) or plan/area error > 10%, against
  EagleView and lidar truth; "under" = not over-measured (what a hidden eave can explain).

  | rule (DEV, 33 houses with a truth) | bad caught | clean flagged | under-measured caught | flagged of 54 |
  | --- | --- | --- | --- | --- |
  | base, share >= 0.25 | 8/14 | 5/24 | 7/9 | 23 |
  | fix, share >= 0.25 (shipped) | 8/14 | 5/24 | 7/9 | 23 |
  | fix, share >= 0.20 (-20%) | 9/14 | 5/24 | 7/9 | 27 |
  | fix, share >= 0.30 (+20%) | 6/14 | 3/24 | 6/9 | 18 |
  | fix, runs >= 2 m only, share >= 0.25 | 6/14 | 3/24 | 6/9 | 19 |
  | fix, runs >= 3 m only, share >= 0.20 | 6/14 | 3/24 | 5/9 | 20 |

  Precision on houses with a truth: 8/13 before and after. EagleView alone: 0/1 flagged bad (its 3 bad DEV houses are
  over-measurements, which an unverified edge cannot explain); lidar alone: 8/12 precision, 8/12 recall before and after.
  Every rule that flags fewer clean roofs misses an under-measured one; a missed bad roof prices a wrong job, an extra
  review costs minutes, so the threshold stays. Far fewer clean flags is NOT reached: the eave-drop evidence does not
  separate them (see Risks).
- **Hidden-edge steps (off by default).** The share gates keep 0.5: they now mean what they say (half the edge has no
  eave drop) instead of "the midpoint is hidden". Two consequences in their tests and one code change:
  - outline-planes.ts: the "disagrees with the visible eave" check now counts only STRONG samples. A roof plane's own
    slope drops 0.5 m (weak) between eave-support's windows from about 5/12, 1 m (strong) only from about 10/12, so a weak
    sample seen through a gap in a sparse crown is as likely the roof carrying on past a notch; the sparse-crown planes
    tests (which the fix broke: the newly read second halves held such weak samples, offset 1.8 m) pass again.
  - roof-reconstruct-guards.test.ts, photo 'ground' scene: its leaves let 60% of the edge verify, so the share gate
    alone now refuses it (no move, the right outcome); the test opens the gate (`minHiddenShare: 0.3`) so it still tests
    the ground guard by itself.
  - Not recalibrated on real houses: these steps are off and a DEV run with them on did not fit the clock.

## Benchmark (DEV only)

- Default scorer, `--compare baseline-v2.json --gates gates-v3.json`: 327 pass, 4 fail, all on the lidar hidden-edge
  set, whose membership is eave support itself: lowslope hidden within 0.5 m 0.672 -> 0.606, simple 0.614 -> 0.559 (mean
  0.94 -> 1.07 m), steep 0.332 -> 0.234. The scorer now reads the second halves it skipped; no outline moved.
- Same scorer on both sides (ROOF3D_BENCH_SUPPORT=dense, unchanged by the fix), base fb0b63db vs the fix, house by house:
  faces, plan and sloped area, review reasons, flags, lidar IoU, hidden, visible and truth-hidden sets all identical
  (0 differences on 54 houses). The reconstruction's geometry and quotes do not change; only edge evidence does.
- baseline-v3-dense.json was made at 9aee1992 (another reconstruction): comparing against it fails 62 gates on base
  and fix alike, so it is not a baseline for this track.
- Guard mutations (`npm run roof3d:mutate-guards`): all 23 killed.

## Alternatives rejected

- Keep the clamp and densify the outline before calling eaveSupport (what outline-lidar.ts and the bench's dense
  scorer do): treats the symptom per caller; the next caller gets the bug again.
- Outside-above-ground to tell a roof carrying on past the edge from a deck (measured per sample in the calib tool):
  EagleView and lidar disagree on which heights mean an error (e.g. 'level' 5 m+ above ground: 0.78 within on
  EagleView, 0.43 on lidar). Dropped, nothing shipped.
- Per-reason confidences (crown / level / taller-neighbour): the two truths order them differently (taller-neighbour
  0.58 on EagleView, 0.35 on lidar). Not robust; one unverified class.
- Contiguous-run rules for the flag (above): no better than the share.

## Risks

- Small n: 33 DEV houses carry a truth, 14 bad. One house moves recall by 7 points.
- The new confidence numbers come from a finer alignment (0.1 m search, the bench's own) than the old 0.771 / 0.489
  (0.25 m grid); on three EagleView houses the two scorers differ by -1 to +7 points per house. The jump from 0.771 to
  0.87 is mostly the scorer, not the sampler.
- Weak-class confidence moves 0.70-0.77 for weakM +-20%.
- Edge display changes: 102 of 902 DEV edges change unverified share by more than 0.1 (53 by more than 0.25), so the
  dashed edges in the roof view move.
- The bench's default 'midpoint' hidden-edge scorer now samples the whole ring too, so its hidden / truth-hidden numbers
  are not comparable with baselines made before this change; the 'dense' scorer is unchanged (compare with
  ROOF3D_BENCH_SUPPORT=dense against baseline-v3-dense.json).

## Rollback

Revert the eave-support.ts sampler hunk and EDGE_AGREEMENT/edgeConfidence in roof-3d.ts, and set
ROOF_3D_ALGORITHM_VERSION to 7 (never back to 5: roofs stored by 6 must read as stale). No stored format changed:
Roof3dEdge keeps its fields; older snapshots read and render as before.
