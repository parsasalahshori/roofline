# Faces track: seed stability, thin edge faces, steep faces

## Problem

- **Seed instability.** The plane search drew its RANSAC candidates and its scoring sample at random. At seeds 7, 8
  and 9 the dev split gave materially different roofs on 28 of 54 houses (face count, checker verdict, area); the
  checker pass count moved by up to four houses. A price must not depend on a random seed.
- **Thin faces along the outline** (the owner's 305 Ridgeway Dr screenshot): faces over 25 sq ft but under 0.9 m
  wide (62 on dev at the baseline), mostly strips along eaves and rakes whose plane is a gutter, a wall or foliage.
- **Faces steeper than 18/12** survive when Google's segments allow 24/12 for the whole roof (2018 N Tyler St).

## Approach

1. `findPlanes` visits candidate seeds on a square lattice over the free pixels (step chosen so about `candidates`
   pixels fall on it, shrinking as pixels are used) and scores each candidate on an evenly spread sample; ties go to
   the lower pixel index. The outcome no longer reads the random stream at all (`lattice: true`; property test:
   any rng gives the same planes).
2. Face cleanup (see the commits that follow) for thin edge strips and steep faces.

## Alternatives rejected

- *Consensus over several seeds* (run 3-5 seeds, keep the median roof): 3-5x the runtime, and the median of
  discrete face sets is not well defined.
- *More random candidates*: lowers the variance, never removes it.

## Risks

- A lattice can sit badly against a small face (a dormer of 2 m2 is about 14 x 14 pixels; the lattice step is
  about 7 pixels on a 200 m2 roof, the same density the random draw had). Synthetic dormer and porch tests still pass.
- Runtime: the step is floored, so a little more than `candidates` seeds are visited (dev p95 806 -> about 1000 ms
  on a busy shared machine; the calibrated gate passes).

## Rollback

`planes: { lattice: false }` restores the random search (kept, tested); reverting the commits restores everything.
