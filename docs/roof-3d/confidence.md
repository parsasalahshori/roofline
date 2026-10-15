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
2. (later commits) per-edge and per-face confidence stored as optional fields; recalibrated review reasons; UI cue.

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

The module has no callers in the first commit; later commits read it from the API only, so reverting those commits
restores the old behaviour. Stored fields are optional and ignored by older readers.
