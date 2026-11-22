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

## Round 3: faces kept on evidence, not on size (`faces-evidence.ts`; off by default)

Switches: `evidence.enabled` (the rule), `evidence.thinM` (0.9: a face kept on evidence must not be a thin face; 0: whatever
its width), `planes.cleanupRoundsPerFace` 1 + `planes.splitOnce` true (buildFaces' cleanup runs to its end). All off by
default: the default run is byte-identical to before and passes every gate.

Labelled data (18 dev answer keys): with every dissolve rule off the plane search leaves 472 candidate faces; from
EagleView's faces 322 are REAL (a face of matching normal under 60 % of it), 92 FRAG (a second candidate on the same
EagleView face, touching a bigger one), 44 JUNK, 14 outside EagleView's roof. The size rules keep REAL 260, FRAG 41, JUNK 20.
By rule: `explained` removes fragments (42 of 48); `sliver/steep` removes real faces (15 of 20), `chamfer/riser` 8 of 23.

The rule (two physical conditions and one veto, measured on each boundary of a face in the height map itself):
- **a ridge or hip of its own**: at least 1 m of boundary where the heights turn over (slope falls by 0.15 or more across
  it), shared with a face turned 60 degrees or more away at a pitch within 4/12; or
- **a facing of its own**: pitched 3/12 or more, and no pitched neighbour faces within 60 degrees of its way;
- **never a fragment**: a face under 1 m wide beside a bigger one facing its way (within 30 degrees, planes within 20) with
  no step between them (under 0.25 m) is the rounded top or smeared foot of that face, whatever it meets on its other side;
- not within a metre of a tree crown over a fifth of it.
Such a face is passed over by buildFaces' steps 2 to 5 and by the thin-face rules, and marked unsure. Leave-one-house-out
(parameters picked on 17 houses, scored on the 18th; candidates under 15 m2): REAL 138/193, FRAG 13/88, JUNK 10/43
protected, against 142, 11, 7 in sample: not memorised.

Results (scorer OBJECTIVE dev / held-out; labelled candidates kept REAL, FRAG, JUNK on dev):
| run | dev | held-out | area dev / held-out | kept |
|---|---|---|---|---|
| default | 18.0 | 20.2 | 3.9 / 2.3 % | 260, 41, 20 |
| cleanup to its end alone | 17.9 | 20.9 | 4.1 / 3.8 % | 241, 34, 18 |
| evidence, thinM 0.9 | 16.9 | 20.2 | 4.4 / 3.2 % | - |
| evidence, thinM 0 | 15.4 | 17.9 | 4.9 / 3.5 % | 290, 45, 23 |
| evidence + cleanup to its end, thinM 0.9 | 16.9 | 20.8 | 4.4 / 3.2 % | 267, 38, 19 |
| evidence + cleanup to its end, thinM 0 | 14.9 | 19.5 | 4.8 / 3.5 % | 286, 38, 21 |
No evidence run passes the gates: thin faces rise (dev answer-key houses, thinM 0: 24 -> 63 thin faces, 53 of them real by
the answer key; EagleView's own faces are thin 122 of 390 times), the median area error rises (the faces that come back
are steeper than what stood in for them, on plans that are already too big: 18 of 32 houses are over), two houses fail the
checker, one sliver on held-out.

Dead ends: joining fragments to their face instead of dissolving them (`evidence.joinFragments`; with the answer key
picking the fragments the oracle is 14.7 on dev, with the run-time rule 18.2: hips lost); dissolving the JUNK-labelled
faces (oracle 15.4 against 14.7 keeping them); no single measurement separates real from junk among the faces with no
crease or facing of their own (AUC 0.64 at best, 24 against 18).

The cleanup loop (review finding): 12 rounds end it unfinished on complex roofs, and a neck split that is dissolved was
split again every two rounds. Both are fixed behind `planes.cleanupRoundsPerFace` and `planes.splitOnce`, and both are off
by default because the unfinished cleanup is the better one while the size rules decide alone (run to the end they
dissolve 19 more real faces on dev and fail 17 gates). The unsure mask is now rebuilt after a canopy re-crop.

## Round 4: the flag, the corrected thin check, and what the cleanup can and cannot do

**The flag.** A stored face says when it stands on evidence of its own: `Roof3dFace.evidence` is `'crease'` (a ridge or
hip of its own) or `'facing'` (no pitched neighbour faces its way), from `faceEvidence` (faces-evidence.ts, the same test
as `realFaces`: never a fragment, never by trees). Set only while `evidence.enabled`; optional, ignored by `isRoof3d`,
changes no area, line or quote. With the rule off the stored roof is byte-identical to before.

**The corrected thin check.** The benchmark counts the thin faces that carry `evidence` or `fitted`
(`HouseMetrics.thinExcused`, `thinCounts` in bench/roof3d/metrics.ts) and the gates option `thinFaces.excuseEvidence`
compares the run's unexcused thin faces with the baseline's (a baseline made before the flags counts all its thin
faces). The gates file with it on is gates-v4 (outside the repo, beside gates-v3: only that key differs).

**Where evidence-on stands** (`{"evidence":{"enabled":true,"thinM":0}}`, with `keepCoplanar` false, the default since
round 4: a thin piece within a few degrees of a neighbour's plane goes whatever crease it meets elsewhere, as a fragment
does). Line error, three views (MED = the scorer's OBJECTIVE, MEAN = mean per-house error, POOL = summed |ours - EagleView|
over summed EagleView): dev 18.0 / 23.5 / 18.3 -> 15.5 / 21.2 / 18.0; held-out 20.2 / 29.6 / 27.3 -> 17.9 / 27.5 / 25.6.
Labelled candidates kept (dev): REAL 260 -> 288 of 322, FRAG 41 -> 43 of 92, JUNK 20 -> 23 of 44. Gates-v4: every thin
check passes; what fails is the median area error (the outline's, with the area track), held-out checker 20 -> 18
(orlando-college-park: two doubtful faces in a dark low-slope part; ev-51881844: a new face moves a Google segment's centre
into a south face), and runtime p95 under load (same-process timing: evidence costs 0-3 %). Of the excused thin faces on
EagleView houses, 35 read nearer EagleView's normal than what the default run had there, 13 the same, 7 worse. Where
evidence-on still loses feet on dev: restored faces' lower edges drawn as valleys where EagleView has eaves (the lines
track's eaveAlong), and two complex roofs whose 3.5 m2 faces sit below the plane search's floor (a hip becomes a valley
or the reverse there, with or without the rule). buildFaces' loose coplanar merge (`planes.mergeLooseDeg` 6 or 10) makes
evidence-on worse (MED 16.8-17.0, MEAN 22.6-22.8) and the default no better on the mean (10: 15.1 / 24.5 / 18.9).

**Negative evidence before a size rule deletes a face** (`evidence.bowM`, off). `chamfer/riser` and `sliver/steep`
dissolve a face only when the median distance of its heights from the nearest neighbour plane is under bowM (the bow of
Google's slopes, 0.1-0.3 m); an eave-band variant (`evidence.bandM`, off) also lets a face within 0.4 m of the roof's
edge go. On the faces these two rules took (evidence on, dev): REAL stood 0.16-0.56 m off every neighbour plane, JUNK
0.12-2.3 m. Dev OBJECTIVE 15.4 -> 14.2 (0.15) / 14.4 (0.25) with 5-7 more real faces kept, but leave-one-house-out does
not confirm it and the unseen split got worse (17.9 -> 18.9 at 0.25): physically reasonable, not a measured win.

**The fragment join** is the refine track's (`refine.enabled`); a model-selection join tried here (one bowed surface,
Cauchy loss 0.1 m, against two planes; never across a wall, a turn of 30 degrees or a deck) reached 14.5 on dev with
evidence on against the answer-key oracle's 14.7 on the all-off candidates; not kept.

**The plane-search floor.** What sets it (planes.ts findPlanes): no plane is seeded or fitted within 0.2 m of the roof's
edge; a candidate is fitted on a 13 x 13 pixel window (windowM 0.6) that must be half free and fit within 6 cm RMS; the
patch must be minPlaneM2 (2 m2) of pixels within tolM whose four neighbours are within it too; buildFaces then dissolves
every face under tinyFaceM2 (2.35 m2). EagleView's dev faces found, under 2.5 / 2.5-5 / 5-10 m2: default 0/262, 19/115,
32/78; evidence on 2/262, 29/115, 42/78; every dissolve rule off 2/262, 31/115, 47/78 (the search's ceiling). Lowering
the floor (minPlaneM2 1, tinyFaceM2 1.2, windowM 0.4) with small faces kept only on their own evidence finds 7/262 and
34/115 but is no win on the mean (windowM 0.4 moves the big planes of bowed slopes): faces under about 5 m2 have to be
drawn from shapes, not found.

**Pitch of restored small faces.** Against the EagleView face under each (dev, evidence on): under 5 m2 the plane's own
fit reads +1.3/12 steep (median) but the pitch reported (pooled) is +0.2/12; 5-10 m2 0.0; larger faces -0.1. The fit on a
small face's core (eroded 0.1-0.3 m) is what reads steep; a robust fit on all its pixels reads +0.1. Not over-read as
reported. Where restored faces change the sloped area (11 of 18 dev houses), most of the change moves toward EagleView's
slope factor at those pixels on 10 (the exception, ev-53863159, restores faces read too shallow); the median area error
still rises because the outlines those faces sit on are too big (plan +6 % median, the area track's).
