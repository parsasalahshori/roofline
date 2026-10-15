# Outline round, remediation (track: remediate, ROOF_3D_ALGORITHM_VERSION 5)

Branch `outline/merge`, on top of the integrator's `9aee1992` (version 4: hidden edges on by default, photo+planes).
Inputs: the verifier's report (`roof-bench/verify-outline/`, "ship with caveats") and the reviewer's findings (four
P1s). Release notes: [outline-release-notes.md](outline-release-notes.md) (rewritten for this version). Bench files of
this note: `/Users/parsasalahshori-a/RooflineWork/roof-bench/remediate-outline/`.

## Problem

Review found that version 4 could price roof it had not measured:

1. **A notch is filled (P1).** The planes step puts a hidden eave where the face's plane comes down to the eave height
   its visible eaves show. A real notch (a recessed entry) has its inner eave on the same plane, higher up, so with a
   tree crown standing in it the notch reads as a 2 m "crown bite" and is filled: +5 % plan area, no review reason
   (`packages/shared/test/roof-reconstruct-notch.test.ts`, 12 cases at 0.1 and 0.25 m: all failed on `9aee1992`).
2. **Inferred roof was priced as measured roof (P1).** `toRoof3d` dropped the steps' records; a stored roof could not
   say which edges or how much area came from inference (up to +14.3 % plan area on the bench with no new reason).
3. **The guards were untested (P1).** Deleting yard-visible, other-building, roof-visible, disagrees-visible, the offset
   gate, the crease check, the area cap, the chamfer checks, or any of the photo step's gates left all 42 tests green.
4. **The default was not earned (P1).** The held-out gain rested on one house (ev-50264667); DEV, where the methods
   were tuned, did not improve; held-out had been used to choose photo+planes.

## What changed

- **Default off, version 5.** `DEFAULT_HIDDEN_EDGE = null` (`apps/api/src/estimator/roof-3d.ts`). A default Measure is
  byte-identical to `c606b7a4` on all 84 bench houses (hash for hash) and passes every gate against baseline-v2 +
  gates-v3. The version moves to 5, not back to 3, so roofs stored by version 4 (inferred roof priced) read as stale,
  and no number ever names two reconstructions. Detached structures get the same option as the main roof.
- **Unconfirmed moves are refused (planes).** Roof added farther than `overhangM` (1 m) outside the outline the mask
  drew is a hypothesis. A move adding at least `maxUnconfirmedM2` (0.5 m2) out there is refused (`unconfirmed`) unless
  at least `minDeepSeenShare` (25 %) of that area shows the face's plane through the leaves (heights within 0.15 m of
  it); the same for a dropped chamfer's corner. `minDeepSeenShare: 0` is hypothesis mode (version 4's behaviour), kept
  for development. Constants: 1 m is a typical eave overhang (what the mask may lose without a crown being needed to
  explain it); 0.5 m2 is above pixel noise at both resolutions (50 pixels at 0.1 m, 8 at 0.25 m); 25 % asks for roof
  in a quarter of the area, where a crown over ground or a crown over roof with no gaps shows none.
- **Provenance on the stored roof.** `LocalRoof.inferred` and the optional `Roof3d.inferredEdges` record, when a
  hidden-edge step ran, each final outline edge with an inferred stretch (`from` indexes `outline` as `Roof3d.edges`
  does; method; inferred length; largest distance from the heights' outline) and the plan area added and removed
  (counted on a 5 cm grid). Absent when the step is off, so older snapshots read and render as before.
- **Review reason `roof-inferred` ('block').** When the steps add or remove at least 3 m2 (a third of a roofing square)
  or 2 % of the outline (the method's median area error against EagleView), the roof needs review before pricing,
  whatever the unverified-length floor (20 ft) of `edges-unverified` says. The card shows the reason; inferred edges are
  drawn dashed even where the heights now read them as supported (`apps/web/src/features/measure/lift/edgeCue.ts`).
- **One combined limit** (`HIDDEN_EDGE_LIMITS`): the steps together may change the area by at most 15 % and put no
  corner more than 4.5 m from an old one; past that the outline goes back to the heights' and the record says
  `undone: 'large-change'`. (Each step's own 25 % cap compounded to 1.56x.)
- **Failure behaviour.** The photo step is wrapped like the planes step: an exception keeps the outline, records
  `declined: 'error'`, and never reaches `roofOnLayersResult` (where it used to lose the whole roof as 'not-found').
  The planes step now pads the crop when a move reaches past it and sets `clipped` when the roof then reaches the
  layers' edge.
- **Tests that fail without their guard.** `packages/shared/test/roof-reconstruct-guards.test.ts`: one scene per guard
  (12 planes, 8 photo; 0.1 and 0.25 m except one photo scene that only exists at 0.1 m) in which only that guard
  refuses, asserting its own reason and an unchanged outline. `npm run roof3d:mutate-guards` deletes each of 23 guards in
  turn (the two steps' gates, the combined cap, the photo catch, the `roof-inferred` reason): all 23 are killed.
- **Bench.** `ROOF3D_BENCH_RESAMPLE_M=0.25` resamples heights, mask AND photo (the verifier's MEDIUM check, adopted;
  the integrator's MEDIUM check left the photo at 0.1 m).

## Results (one harness for every run; seeds 7, 8, 9; `--split all --reveal`)

Default (version 5) against `c606b7a4` (the verifier's `base.json`): 84/84 identical hashes; gates DEV 331 pass / 0
fail, held-out 231 / 0. Runtime p50/p95 DEV 215/755 ms, held-out 172/558 ms. 0 of 84 not byte-identical, 0 seed-unstable.

The option, for whoever decides on a default later (`ROOF3D_HIDDEN_EDGE=photo+planes`). Fixed-set metrics first
(truth-hidden and IoU do not move with the method; "hidden" does and is left out). Leave-one-house-out range and a
seeded house-level bootstrap (2,000 resamples) for each delta; `tools/stats.py`:

| | photo+planes, version 5 defaults | hypothesis mode (= version 4) |
| --- | --- | --- |
| DEV lidar IoU median (26 houses) | 0.8700 -> 0.8719 (LOO +0.000..+0.004; CI +0.000..+0.006) | 0.8700 -> 0.8668 (CI -0.019..+0.010) |
| DEV truth-hidden <= 0.5 m | 35.0 -> 35.9 % (CI +0.0..+1.9 pt) | 35.0 -> 38.8 % (CI -0.7..+9.4 pt) |
| DEV EagleView abs area median (18) | 4.01 -> 4.01 % | 4.01 -> 4.36 % |
| held-out lidar IoU median (14) | 0.9079 -> 0.9094 (CI 0..+0.003) | 0.9079 -> 0.9340 (LOO 0..+0.052; CI 0..+0.062) |
| held-out truth-hidden <= 0.5 m | 40.4 -> 42.2 % (LOO +0.7..+2.3 pt; CI 0..+4.1 pt) | 40.4 -> 47.1 % (LOO without ev-50264667: +0.3 pt; CI -3.0..+23.7 pt) |
| held-out EagleView abs area median (16) | 2.86 -> 2.86 % | 2.86 -> 4.78 % |
| lidar houses better / worse (IoU by > 0.003) | DEV 4 / 0, held-out 1 / 0 | DEV 5 / 1, held-out 3 / 1 |
| roofs changed | DEV 9, held-out 8 (largest +5.6 %, ev-52191132) | DEV 17, held-out 11 (largest +14.3 %) |
| gates vs baseline-v2 + gates-v3 | all pass | DEV 16 fail, held-out 4 fail |

The safe option is a small, consistent improvement with no lidar house worse; it does not fix the owner's 305
Ridgeway corner (its move is 4.2 m deep with no evidence: refused) and it no longer helps ev-50264667. Hypothesis mode
reproduces version 4 (same plan areas within 1 sq ft on all houses) and now flags every roof it changes by 2 % or more
(`roof-inferred` on 18 houses); its held-out gain still rests on ev-50264667 and its bootstrap interval includes zero.

DEV calibration of the evidence rule (`_calib.ts`, DEV only, lidar truth for planes is not circular): of 87.8 m2 that
version 4 added on 8 DEV lidar houses, 78 % lies inside the lidar outline (houston-heights 90 %, lr-305-ridgeway 100 %,
tr-houston-910102897 97 %, seattle-wallingford 37 %, irvine-123-briar 49 %). The roof's plane was seen in 0-11 % of
every deep move's area (tr-raleigh-47735779: 20 %), good or bad: October photogrammetry does not see a roof under a
leaf-on crown, so no evidence from the heights separates the 78 % from the 22 %.

MEDIUM (heights, mask and photo at 0.25 m), same harness: 0 throws, 0 lost roofs, 0 not byte-identical, all 84 status
ok, for off, the option and hypothesis mode. Plan area at 0.25 m against the same configuration at 0.1 m: off
0.974-1.027, option 0.949-1.027. Option against off at MEDIUM: DEV lidar IoU median 0.870 -> 0.872, held-out unchanged
(0.905); EagleView aligned IoU DEV 0.926 -> 0.924 (the one metric that moves the wrong way, by 0.002). Hypothesis mode at
MEDIUM brings back ev-49611661's `outline-off` (as the verifier found) and adds `roof-inferred` there; the option does not.

Sensitivity (+-20 %, DEV, the option): `overhangM` 0.8 / 1.2 and `maxUnconfirmedM2` 0.4 / 0.6 change nothing but one
flag (overhang 0.8: truth-hidden 35.5 % instead of 35.9 %); `minDeepSeenShare` 0.3 changes nothing, 0.2 lets
tr-raleigh-47735779's 8.2 % corner (no truth; the verifier judged it wrong) back in. The `roof-inferred` thresholds at
+-20 % flag the same 11 DEV houses in hypothesis mode (proxy: plan-area change).

## Alternatives rejected

- **Keep version 4's default and only add the flag.** Every changed roof would go to review; the review queue would
  carry inferred corners on 17 of 54 DEV roofs with the area already in the price.
- **Clamp an unconfirmed move at the overhang instead of refusing it.** The clamped line is on no plane's eave height,
  so it is wrong by construction.
- **Require the photo step to confirm deep moves.** The photo moved 3 of 902 DEV edges; it would refuse almost all.
- **Fix the product's `eaveSupport` midpoint sampling now.** It changes per-edge support, `edges-unverified`, the
  confidence calibration and both methods' hidden tests on every roof; it needs its own round (recalibration, new
  baselines) and must land before any hidden-edge default is reconsidered.

## Risks

- With the option on, review load goes up (`roof-inferred` on 6 of 84 roofs with the defaults, 18 in hypothesis mode).
- The evidence rule is principled but it makes the planes step nearly inert on leaf-on data: the owner's 305 Ridgeway
  chamfer stays (as in version 3). The fix for that house needs evidence the heights do not have (leaf-off lidar at
  request time, or a better photo).
- The synthetic sparse-crown scene that passes the evidence rule works at 0.1 m; at 0.25 m the same crown does not
  show enough plane, so MEDIUM refuses more.
- Held-out is not pristine for these methods (it was used to choose photo+planes in version 4); nothing in this round
  was tuned on it, and the default decision is not taken on it.

## Rollback

Code: revert this branch's commits; the methods stay behind their option either way. Data: stored roofs carry their
algorithm version; version 4 and 5 roofs are reconstructed on the next request if the version moves again.

## Not done

- Product `eaveSupport` midpoint bug (see above). Keep the hidden-edge default off until it is fixed.
- Fresh verification houses (not among the 84) with lidar or EagleView truth for any default decision.
- Lidar truth flagged for low-roof attachments (patio or deck at eave height) and leaf-on/leaf-off cohorts reported
  separately (truth-bias finding).
- Missing wings (305 Ridgeway east, lr-tyler west, ev-52191132, ev-47747994).
- The lidar method still ships in the shared package (development entry point only by convention).
- The real-layers acceptance test (`apps/api/test/roof-3d-real.test.ts`) needs `ROOF_3D_REAL_DATA`, not set here: skipped.
