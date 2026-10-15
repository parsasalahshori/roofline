# Confidence track: per-edge evidence, honest flags, UI cue

## Problem

On this data trees are an edge problem, not a plane-fitting problem. Canopy hides the eave: 54% of canopy-exposed
outline length has no height evidence (9.5% elsewhere), and where the heights cannot verify an edge EagleView disagrees
by more than 0.5 m 41.8% of the time (13.5% where they can). The product did not say so: the only outline check
compared the outline with the mask it was traced from (IoU >= 0.939 and edge fit 100% on all 54 houses), three review
reasons never fired, and 72% of houses carried some reason (flag fatigue).

## Approach

1. `packages/shared/src/roof-reconstruct/eave-support.ts` (pure, self-contained, never throws): every 0.2 m along the
   outline, the eave drop = median height 0.2-0.5 m inside minus median height 0.6-1.0 m outside. Strong >= 1.0 m,
   weak 0.5-1.0 m, none < 0.5 m (= unverified). Per sample, per edge (class of the median drop, shares, the dominant
   unverified reason: crown, taller-neighbour, data-gap, level) and per outline (shares, unverified length, canopy
   exposure = share of samples with crown on >= 25% of a 3 m window). The outline and canopy tracks vendor a verbatim
   copy until the merge; only this track edits it.
2. Stored evidence (all optional, additive; older snapshots read and render unchanged):
   - `Roof3d.edges[]`: per outline edge `{from, lengthFt, support, unverifiedShare, reason, canopy, confidence}`.
     `confidence` = chance the edge is within 0.5 m of EagleView given its support: 0.865 verified, 0.582 unverified
     (failure taxonomy 2.3, pooled), mixed by the edge's unverified share.
   - `RoofQuality.edgeSupport` (strong/weak/unverified shares, unverified feet, canopy share), `edgeSupportFailure`
     (machine-readable code when the heights cannot be read: no-zone, off-raster, bad-outline, error), `notes`.
   - `Roof3dFace.confidence`: length-weighted confidence of the outline edges the face ends on (0.865 for a face of
     creases only) x 0.8 when Google's segment under it disagrees (ours is closer to EagleView in 16 of 27 conflicts,
     so disagreement is weak evidence). Informational; never changes areas or the quote.
   Computed in the API (`withEdgeEvidence` in roofOnLayers, `withFaceConfidence` in withGoogleCheck) on a window of the
   height map round the outline (box + 4 m), with the benchmark's crown definition (`crownFromGreen`) for the reason.
3. Review reasons: `ROOF_QUALITY_SEVERITY` (block / check / info). Only block and check stay in `quality.reasons` (and
   so make needsReview true); info goes to `quality.notes`. New reason `edges-unverified` (block): unverified share >=
   0.25 of the outline and >= 20 ft. 0.25 was chosen a priori (the analysis's cohort line: about one whole side of a
   rectangular house), not tuned. `differs-from-google` needs a review only when the differing main faces carry a
   third of the main area or more (enough to put the dominant pitch in question); below that it is a note.
4. UI: unverified edges (>= 1 m) drawn dashed amber over the photo while the outline is still the reconstruction's own
   (`sameOutline`), with one line on the card ("Edge hidden by trees: check it", or the general wording when walls or
   data gaps dominate). The outline editor, section selection, buildings list and popover are untouched.

## Calibration (DEV split only, seeds 7 / 8 / 9)

Tools: `apps/api/src/scripts/roof-3d-confidence-calib.ts` (refuses held-out houses) and
`/Users/parsasalahshori-a/RooflineWork/roof-bench/confidence/tools/policy2.py`.

| policy | flagged | EagleView-bad caught | EagleView-good flagged | tree houses flagged | OSM-bad (IoU < 0.70) caught |
| --- | --- | --- | --- | --- | --- |
| before (base) | 37 / 37 / 38 of 54 | 4/4, 4/4, 6/6 | 13/14, 12/14, 11/12 | 12/20 | 5/10 |
| after (share >= 0.25) | 41 / 39 / 42 | 3/4, 3/4, 5/6 | 8/14, 9/14, 8/12 | 17/20, 15/20, 17/20 | 9/10 |
| share >= 0.20 (-20%) | 45 / 43 / 46 | 4/4, 4/4, 6/6 | 8/14, 9/14, 8/12 | 19/20, 17/20, 19/20 | 10/10 |
| share >= 0.30 (+20%) | 36 / 35 / 37 | 3/4, 3/4, 5/6 | 8/14, 9/14, 8/12 | 16/20, 14/20, 16/20 | 8/10 |
| min length 16 / 24 ft | unchanged | unchanged | unchanged | unchanged | unchanged |

- The missed EagleView-bad house is an over-measured attachment (+13.8%) that only `differs-from-google` (9% of its
  main area) flagged before, by accident. It has 22% unverified edges, so 0.20 would catch it; we did not move the
  threshold for one house.
- The dev split is tree-heavy (20 of 54 from testset-trees), so the overall flag rate rises; on houses with an answer
  key it falls (0.93 to 0.67) and on tree houses it rises to catch 9 of 10 whose outline disagrees with OpenStreetMap.
- Per sample, against translation-aligned EagleView on the dev EagleView houses: unverified samples disagree by >0.5 m
  51% of the time vs 22% (strong) and 30% (weak). The unverified class holds 10.8% of the length and captures only 15% of
  the samples off by >0.75 m: the analysis's acceptance target (>= 60% capture) is NOT met on these houses, whose
  disagreements are mostly attachments and overhang conventions, not hidden eaves.

## Not changed (other tracks' files)

- `outline-off`, `trees`, `rough-heights` still cannot fire in practice; their triggers live in roof-reconstruct/index.ts
  (other tracks). `outline-off` compares the outline with the mask it was traced from: `edges-unverified` is its
  independent replacement; drop or rewire the old trigger at merge. The checker's `outlineOk` is left as is so the
  checker-pass gate keeps its meaning (the scorer belongs to the hardening track).
- The bench counts only `quality.reasons`, not `notes`.

## Alternatives rejected

- Bilinear height sampling: the reference used nearest pixel; the medians over 4-5 samples already smooth it, and the
  classes depend on metre-scale drops.
- Classifying edges by majority of samples rather than median drop: same result on the synthetic eaves; the median is
  what the reference analysis scored.
- Colour-only crown evidence for unverified edges: it misses shaded and autumn foliage (recall 29%). The drop itself is
  colour-blind; crown evidence only labels the reason.

## Risks

- A flat roof next to a deck or a porch at eave height reads 'level' (unverified) though the edge may be right.
- An outline off the raster reads as a data gap (unverified), which is the honest answer.

## Rollback

Revert the API commit: the reconstruction is untouched (no face, area or outline changes from this track), and every
new stored field is optional, so older and newer snapshots both keep reading. Snapshots stored by older commits keep
their reasons as stored (they are never re-tiered on read).
