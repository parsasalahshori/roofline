# Design note: remediation of `edge/merge` (track `remediate`)

The independent verifier and the adversarial reviewer found problems in `edge/merge` at `93d944c9`. This note covers
what was fixed, how, what was rejected, and what is still open. All tuning was done on the DEV split only. The
held-out split was run once, at the end, aggregates only (no `--reveal`).

## Problems and fixes

### P0: the lattice plane search lost whole roof planes

- **Root cause.** On a clean face every candidate fits every sample point, so candidate scores tie. Ties went to the
  lowest pixel index. Lattice seeds are taken in raster order, so the 12 best candidates were neighbouring pixels on
  the first row of the free region, which is its edge. `patchFrom([seed])` needs the seed's four neighbours to be free
  and on the plane, so an edge seed grows nothing. All 12 grew nothing, and the search stopped with a plane missing.
- **Reproduced first.** `packages/shared/test/roof-reconstruct-resolution.test.ts` has golden gables and hips at
  0.1, 0.25 and 0.3 m pixels, axis-aligned and turned 15 and 30 degrees, with and without noise. It asserts face
  count, every pitch within 0.5/12, area within 1% (2% at coarse pixels) and ridge and hip lengths. On `93d944c9`
  three of its 18 cases fail (gables at turn 0 without noise come out as one face). A wider sweep of 192 gables and
  hips per pixel size found 6 failures with the lattice on and none with it off.
- **Fix (planes.ts).** A patch now grows from the whole window the candidate was fitted on, not from its single
  seed pixel. The top-K are kept as distinct planes: a candidate within 1 degree and within the height tolerance of
  one already kept replaces it only when it ranks higher. Ties are broken by window fill (an interior seed first),
  then window fit, then pixel index. After the fix, all 18 golden cases and all 1,152 sweep cases pass.
- **Not done: lattice off.** Turning the lattice off was the reviewer's stop-gap. With the root cause fixed, the
  lattice keeps its gains (dev main pitch exact 12 -> 14 of 18) and its determinism.
- **MEDIUM-like data.** All 54 dev houses were block-averaged to 0.3 m with the photo dropped
  (`roof-bench/remediate/tools/medium.mts`). No house came out as no roof or as one face, before or after the fix:
  real heights carry enough noise to break the ties. The median EagleView area error at 0.3 m is 3.7% at base, 3.5%
  at `93d944c9` and 4.1% now, on 18 houses. That spread is within the noise of 18 houses, but it is not better.

### P1: the seed-variance metric measured nothing

- The lattice search never reads the random stream, so "seeds 7, 8 and 9 give the same roof" is true by
  construction. The stability tests now say so in their header.
- The robustness signal is `roof-reconstruct-perturb.test.ts`. It covers the mask moved 1 pixel east or south of
  the heights, the heights moved half a pixel, 1, 2 and 3 cm of seeded height noise, turns of 5, 15 and 30 degrees,
  and a 3x3 block-mean to 0.3 m. For GABLE, HIP and L_CROSS it asserts the face count, every pitch within 0.5/12,
  area within 1-2% (3% at 0.3 m), and an area spread under 2.5 points across all perturbations of one roof.

### P1: `differs-from-google` lost a bad roof's review

- ev-51881820 is over-measured by 13.8%. Its only disagreement with Google is one flat face of 225 sq ft over a
  Google segment of 78 sq ft, which is 9% of the main area. The third-of-the-area rule therefore demoted it to a
  note.
- **Fix (roof-3d-compare.ts).** The review is now kept when the area at stake is at least `DIFFERS_STAKE_SHARE = 5%`
  of the roof's plan area. The area at stake is the sum of |ours - Google's| plan area over the differing faces. 5%
  is the benchmark's "area within 5%" line, half the 10% "bad" line. The third-of-the-area rule stays alongside it.
- **Golden test.** `confidence.test.ts` has a roof where one face of four differs, Google's segment is a third of
  our face, and the area at stake is at least 5%. It must be a review. The same disagreement in pitch only must
  stay a note. With the stake rule disabled, the test fails.
- **Dev result.** Flag recall goes 0.80 -> 1.00 and precision 0.31 -> 0.29.
- **Sensitivity (DEV, `remediate/sensitivity-dev.txt`).** At 4% the reason fires on 13 dev houses (2 bad, 6 good,
  5 without a key). At 5% it fires on 8 (2 bad, 3 good, 3 without a key). At 6% it fires on 6 (2 bad, 1 good, 3
  without a key). ev-51881820 (6.0% at stake) is caught at all three. The rule was calibrated knowing that house was
  the one to catch; with one bad example this is weak evidence, and it is reported as such.

### P1: constants tuned on held-out houses; circular thin-face metric

- **`EDGE_AGREEMENT`.** Re-measured on DEV EagleView houses only (`roof-3d-confidence-calib.ts`, which refuses
  held-out houses). Verified went 0.865 -> 0.771 and unverified 0.582 -> 0.489, on 7,212 and 877 samples. The gap
  holds for weakM 0.4-0.6. `INTERIOR_FACE_CONFIDENCE` follows the verified figure. These numbers change face and
  edge confidence values only, not any review reason.
- **Eave-support thresholds.** These are physical (a storey's eave drop) and were not refitted. Their DEV-only
  agreement figures are above.
- **Non-circular metric.** The bench reports "faces vs key %": the median |our face count - EagleView's| /
  EagleView's. The thin-face count is the cleanup's own width limit, so it moves by construction.
- **New gates (`gates.ts`, optional fields, so older `gates.json` files still parse):**
  - review-flag recall may not drop, per cohort;
  - median aligned outline IoU may not drop by more than 0.005;
  - a held-out vs dev gap (split all): the held-out change in median |area error| may not be worse than dev's by more
    than 0.5 points, and the IoU change by more than 0.005.
  These gates live in `roof-bench/remediate/gates-v2.json`. The shared `roof-bench/gates.json` was not changed: the
  integrator decides whether to adopt them.
- **Contaminated flag metrics.** The held-out flag metrics in the earlier release notes come from a 25%
  `edges-unverified` line and confidence numbers that saw all 54 original houses. Treat those held-out flag figures
  as contaminated.

### P1: the round's goal (305 Ridgeway, junk faces from foliage)

- **Fix (faces-cleanup.ts, `crown-edge`).** A face is dissolved into its neighbours when all of these hold:
  - it is at most 15 m2 (the plane search's `steepM2`);
  - at least a quarter of its boundary is the roof's edge;
  - at least half of that edge is an eave the heights cannot verify;
  - its pitch is more than 3/12 (the plane search's `steeperX12`) from the neighbour it shares the most boundary
    with.

  An eave cannot be verified when there is no eave drop beside a crown (eave-support's own `crown` test) or when
  something stands more than 0.5 m taller than the eave beside it. The second case covers a shaded crown that the
  colour test misses. A level outside, such as a deck or a porch at eave height, is not enough: on the dev split that
  variant removed a real 7/12 face (ev-51882178, main pitch 7 -> 9, a good roof made bad), so it was rejected.
- **Reproduced first.** `roof-reconstruct-cleanup.test.ts` builds a 6/12 gable with a crown leaning over 5 m of one
  eave. Google's mask runs on over the crown's smooth top at 2/12, as at 305 Ridgeway. With the rule off it comes
  out as three faces, one of them 2/12. With the rule on it comes out as two faces at 6/12. Pure-rule tests cover
  each condition.
- **Dev result.**
  - lr-305-ridgeway goes 4 -> 3 faces: A and B, the two gable faces at 8.4/12, and C, the 5.7/12 green attachment
    roof the owner's photo shows. The 4.6/12 foliage face is gone.
  - kc-brookside goes 10 -> 9 faces: two low-slope faces merged into one.
  - tr-fayetteville-467353063 goes 12 -> 11 faces.
  - No EagleView house changes.
- **Sensitivity (DEV).**
  - `crownMaxM2` at 12 changes nothing; at 18 seattle-wallingford goes 3 -> 2 faces.
  - `crownShare` at 0.4 changes kc-brookside and omaha-roland. At 0.6, kc-brookside and **305 Ridgeway keep their
    foliage face**: the Ridgeway result sits close to the limit.
  - `crownPitchX12` at 2.4 changes tr-atlanta-51300274; at 3.6 nothing changes.
  - No EagleView metric moves at any of these settings.
- **Not delivered: the outline.** 305 Ridgeway's outline is unchanged: 13 corners with the chamfered, jagged side
  under the tree. Aligned outline IoU against EagleView is unchanged at 0.927 dev and 0.910 held-out. A proposed
  next track is in "Open issues" below.

### Verifier regressions

- **ev-50319630 hole and fragment.** The 23 m2 hole under no face is gone after the plane-search fix: faces cover
  97% of the mask again, 13 faces. The upper-left face is still split in two (6.9/12 and 7.3/12) along a jagged
  line; base had a straight seam. Open.
- **Runtime +30%.** Canopy completion is now off by default (`canopy: { complete: true }` turns it on). On DEV it
  changed 2 of 54 roofs by 1.25 m2 in all, undid itself on 6, cost about 60 ms a house, and its inferred area was
  not reported on the stored roof. Turned off, it changes one dev roof (tr-north-little-rock-1231176703: 6 sq ft,
  rectilinearity 0.93 -> 0.89) and no aggregate. Dev p50/p95 is 213/740 ms against 291/840 at `93d944c9` and about
  208/664 at base; held-out is 172/542 against 235/731 and 171/524.

### P2s fixed because they were cheap and safe

- **Edge index remap.** A new test with a repeated outline corner exposed a real bug: an edge after a repeated
  corner mapped to the zero-length step between the two copies, so its dash was drawn with no length. Edges now start
  at the last copy of a repeated corner.
- **`edges-unverified` at fixed shares.** On a 40 x 14 m house, a crown along a long side (share about 0.37) must
  flag and a crown along a short side (about 0.13) must not. These replace a test that restated the rule.
- **Web cue fatigue (edgeCue.ts).**
  - Dashes are drawn only for edges at least 2 m long with at least half their length unverified.
  - The card line shows only when the roof carries `edges-unverified` or the dashes are 10% or more of the outline.
  - New tests: a clean roof shows nothing; a single 8 ft dash on a 300 ft outline is drawn but gets no card line.
- **No-building after an outage.** The building is now three-state (`undefined` = Google's lookup failed). Only
  "Google answered: no building" can produce the 30-day `no-building` verdict. A pure test with a rejecting building
  promise fails on `93d944c9`.
- **Retention.** `solar:retention` also lists and deletes derived copies under its roots: SVGs that embed an image,
  and PNGs. Each takes the earliest house date.
- **Guard comment.** It no longer claims "well under a second": a roof near the 3,000 m2 limit takes 1.25-1.8 s.

## Alternatives rejected

- **Ship the lattice off.** It would fix the symptom, not the cause, and lose the dev main-pitch gain.
- **Revert `differs-from-google` to "any differing face is a review".** Recall would be 1.0, but the flag would come
  back on about 17 good roofs. The stake rule catches the money case at a cost of 3 extra flags on dev houses
  without a key.
- **Crown evidence from the face's own green share.** 305 Ridgeway's foliage face is not green in the photo (it is
  in shade), so this caught nothing.
- **Crown-edge with any unverified edge, including a level outside.** It broke a real 7/12 face on ev-51882178;
  rejected.
- **Outline completion under canopy.** Not attempted in this round; see the open issues.

## Risks

- `crownShare` = 0.5 sits close to 305 Ridgeway's own value. A small change in its foliage brings the junk face back.
- The stake rule was calibrated against one bad dev house.
- `crown-edge` adds unseen area to a neighbour, because the foliage face's area stays in the roof. It removes a junk
  face; it does not make the area more right.
- Held-out results come from a single final run on 14 houses with a key. The held-out area improvement (3.6 -> 2.3%)
  is larger than any dev move and probably mostly noise.

## Rollback

- Each change is its own commit; revert it with `git revert`.
- Any revert that changes reconstruction output must bump `ROOF_3D_ALGORITHM_VERSION` (now 3).
- `DEFAULT_FACE_CLEANUP.crownShare = 1.01` turns `crown-edge` off.
- `canopy: { complete: true }` restores completion.
- Setting `DIFFERS_STAKE_SHARE` above 1 restores the third-of-the-area rule alone.
- The web cue thresholds are constants in `edgeCue.ts`.

## Open issues (not done in this round)

- **Outline under canopy: the round's headline goal, still open.** Proposed track:
  - Fit the hidden part of the outline from the faces' own planes and the squared main axis.
  - Extend the eave line across the crown.
  - Rebuild chamfered corners from their two adjacent straight edges.
  - Gate it on aligned IoU and rectilinearity in the canopy cohorts, and on EagleView face count for simple roofs.
  - Truth under trees is thin: dev has 2 canopy-heavy EagleView houses.
- **Roofs in tree areas are still flagged often.** `edges-unverified` still fires on 23 of 54 dev houses. Its 25%
  line has not been re-tuned. The web cue is quieter now, but the flag is not.
- **No worker deadline.** Reconstruction runs on the request's event loop, with no hard deadline.
- **Results card covers the roof.** In the Measure view the card hides part of the roof, and so most of the dashed
  edges (fitBounds padding).
- **Re-buying the same layers.** Unusable, clipped and timeout answers are never reused, so the same layers are
  bought again.
- **Huge DSM spikes.** Heights such as 1e30 are not treated as no-data.
- **Unused fields.** `ROOF_QUALITY_SEVERITY` 'block' is not acted on, and `roof3dMissing` is not shown.
- **Unbounded downloads.** The GeoTIFF reader has no streaming size cap.
- **Live geocode.** 1166 Oxford Rd NE was geocoded to a different structure than its bench copy.
- **Two waste figures.** The card says 10% and the proposal says 12% (probably pre-existing).
- **Two faces on one plane.** ev-50319630's upper-left face is split along a jagged seam.
- **Postgres suites not run.** The API and DB suites (Testcontainers) were not run by this track. `measure.ts`
  changed only in how it passes Google's building to the 3D roof (three call sites).
