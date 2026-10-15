# Roof 3D edge cases: release notes (branch `edge/merge`)

Base: `e3ae9615` (the benchmark commit on `edge/bench`, reconstruction as at `5cabb413`). Five tracks were merged in
order, one `git merge --no-ff` each, with typecheck, the shared tests and the benchmark (dev and held-out aggregates,
`--compare roof-bench/baseline.json`) after every merge: hardening, faces, canopy, outline, confidence. Every merge
passed every gate in the end; one needed a fix first (canopy, below). Not fast-forwarded into `real-lookups`, not pushed.

This file is also the integrator's design note (problem, approach, what was rejected, risks, rollback). Each track's own
note is beside it: `hardening.md`, `faces.md`, `canopy.md`, `outline.md`, `confidence.md`.

## What changed, for the owner's two screenshots

- **305 Ridgeway Dr (sliver faces along tree-covered eaves).** Two causes, both addressed:
  - The roof on screen was an old stored snapshot served again for 30 days. Snapshots now carry an algorithm version
    (`ROOF_3D_ALGORITHM_VERSION = 2`); every snapshot stored before this release is stale and is rebuilt on the next
    Measure (one Data Layers request inside the free quota). Old rows still read and render.
  - Thin strips along the outline (under 0.9 m wide, under 12 m2, at least a quarter of their edge on the outline) and
    unsupported faces steeper than 18/12 are now dissolved into their neighbours. On the benchmark copy of
    305 Ridgeway the faces go from 5 to 4 and its thin face is gone. **It is still not the two-face gable the owner
    expects**, and its outline is unchanged (13 corners, rectilinearity 0.55): the jagged, chamfered edges are not
    fixed by this release.
- **Clean rectangle under canopy, nothing saying so.** Every outline edge now carries its evidence from the height map
  (does the roof drop by a metre at the eave?). Edges that cannot be checked (a crown, a taller wall, a deck, no data
  beside them) are drawn dashed amber over the photo with one line on the card ("Edge hidden by trees: check it"), and
  a roof with at least 25% and 20 ft of unverified outline gets the new review reason `edges-unverified`.
  305 Ridgeway, lr-tyler and kc-brookside now carry it; on the base commit they carried no reason at all.

## Per track

| track | what it ships | output change |
| --- | --- | --- |
| hardening | versioned snapshots; typed `none` reasons (`no-imagery`, `no-building`, `no-roof`, `clipped`, `unusable`, `timeout`, `shadow`); reuse only of layers that cover the building; one wider re-buy of a clipped roof; `ROOF_3D_MODE=off\|shadow\|on`; GeoTIFF size/CRS/timeout guards; input guard (`guard.ts`); roofs over 3,000 m2 refused as `too-large`; `Roof3d.maskCut`; counters as JSON log lines; bench alignment metrics and an independent outline check; `roof3d:perf`, `solar:retention` | none to the roof (adds `maskCut`) |
| faces | plane search on a lattice (no seed dependence); weak-face cleanup (`faces-cleanup.ts`) | yes |
| canopy | crown map; roof completion under canopy (grow with eave drop, bridge crown notches), topology guard | small (see below) |
| outline | guard tests for `squareOutline`; both measured outline changes rejected | none |
| confidence | `eave-support.ts`; `Roof3d.edges`; `quality.edgeSupport`; `edges-unverified`; severity tiers (info reasons become notes); `differs-from-google` only when a third of the main area disagrees; face confidence; dashed-edge UI cue | flags only |

## Integration work (merge commits and one fix)

- **hardening x faces x canopy, `roof-reconstruct/index.ts`:** `LocalRoof` returns `cuts`, `dissolved` and `canopy`;
  `ReconstructOptions` takes `faces` and `canopy`. `googleMask` became `let` (canopy re-crops it); hardening's cut
  counters are taken before the re-crop, so they measure Google's part as it came. The canopy topology guard runs after
  the faces cleanup loop, so it judges the cleaned topology.
- **canopy failed the runtime gate after faces (fixed, `f11135ac`).** First run: dev canopy-heavy runtime p95
  1.57x (limit 1.5x), held-out low-slope 1.70x, with every quality metric unchanged. Cause: completion cost about 70 ms
  on every house with a building box, and an undone completion (6 of the 8 dev houses that bridged) ran a whole second
  reconstruction. Fix, output byte-identical (54 dev houses x 3 seeds compared against the merge commit):
  - an undone completion restores the state saved before step 2a and runs steps 3-4 again (nothing after step 2 draws
    on the RNG, so this is the same roof as reconstructing with completion off);
  - the crown map and the completion share one plane-RMS map instead of computing it twice;
  - the per-pixel `resid`/`inBox` closures no longer allocate an object per call;
  - the guard's 1.05 slack is now `CanopyParams.topologyEdgeSlack` (same value) so a test can force an undo.
  New test: with the slack at 0, the undone roof equals the completion-off roof byte for byte (seeds 7, 8, 9, with the
  weak-face cleanup in the loop).
- **confidence x hardening, `apps/api/src/estimator/roof-3d.ts`:** the roof gets `maskCut` first and then
  `withEdgeEvidence`, so a stored roof carries both (new pure test on a ground-cut roof). `Roof3d` keeps both optional
  fields. `confidence.test.ts` expected a base-commit snapshot to be *fresh*; with versioning it is stale (it still
  reads and renders), and a current-version stamp of it is fresh. The test now says so.
- **outline x canopy:** the outline is traced from the roof mask after completion, so it already follows completed
  roof; there is no outline code from the outline track to wire in.

### Investigated and not shipped

- **The canopy guard is absolute, not relative.** It undoes a completion whenever the completed topology has a face
  drawn from its pixels or edge lines over 1.05x the perimeter. On the 5 undone dev houses I traced, the roof
  *without* completion has the same pixel faces and the same edge excess: the bridges did not break the topology, it
  was already in that state. A relative guard ("no worse than without completion", same cost) kept the bridges on
  5 dev houses. Dev result: median area error 4.1 -> 3.8%, but aligned outline IoU 0.927 -> 0.924, low-slope IoU
  0.797 -> 0.793 and the one EagleView house it changed (ev-51882178) got a worse outline (IoU 0.813 -> 0.801,
  rectilinearity 0.84 -> 0.68, 16 -> 22 corners) while its area got better (-5.3 -> -2.4%). A more jagged outline is
  the opposite of this round's goal, so it is not shipped; the canopy track's "topology breaks on bridged roofs" open
  issue should be re-read as "pixel faces exist on these roofs anyway".
- **maskCut as a review reason** and **canopy's occluded points in the edge evidence** were left out: the mask-cut
  reason fires on 0 dev houses at its 10% line, and bridging is kept on only 2 dev houses (0.5-0.8 m2 each).

## Metrics: base (`e3ae9615`) vs merged (`ce6cc303`)

Same harness (`roof3d:bench --split all`), seeds 7, 8, 9 (mean), same manifest (`91e97810c22b`). Base aligned IoU and
the independent checker did not exist in the base harness; the hardening merge (same reconstruction as base) gives
the base values: dev aligned IoU 0.927, independent checker 31.0/54; held-out 0.913, 18.0/30.

Dev split (54 houses, 18 with an EagleView key):

| cohort | n | IoU | aligned IoU | area err % | pitch exact | pitch +-1 | face pitch MAE | checker | thin faces | >18/12 | flag rate | flag precision | flag recall |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| all | 54 | 0.782 -> 0.782 | 0.927 -> 0.927 | 4.0 -> 4.1 | 12 -> 14 /18 | 15.3 -> 15 | 0.62 -> 0.53 | 33.7 -> 34 | 62.3 -> 32 | 3 -> 2 | 0.69 -> 0.78 | 0.28 -> 0.31 | 1.00 -> 0.80 |
| canopy-heavy | 10 | 0.721 -> 0.721 | 0.923 -> 0.923 | 1.0 -> 1.1 | 2 -> 2 /2 | 2 -> 2 | 0.23 -> 0.22 | 5.7 -> 6 | 10 -> 3 | 0 -> 0 | 0.77 -> 0.90 | 0.00 -> 0.00 | - |
| canopy-light | 31 | 0.782 -> 0.782 | 0.915 -> 0.915 | 4.0 -> 4.1 | 6.7 -> 8 /12 | 9.3 -> 9 | 0.64 -> 0.66 | 18.7 -> 19 | 33.3 -> 21 | 2.3 -> 1 | 0.61 -> 0.74 | 0.31 -> 0.33 | 1.00 -> 0.75 |
| canopy-none | 13 | 0.820 -> 0.820 | 0.932 -> 0.932 | 6.7 -> 5.5 | 3.3 -> 4 /4 | 4 -> 4 | 0.91 -> 0.88 | 9.3 -> 9 | 19 -> 8 | 0.7 -> 1 | 0.82 -> 0.77 | 0.28 -> 0.33 | 1.00 -> 1.00 |
| simple | 13 | 0.740 -> 0.740 | 0.832 -> 0.832 | 13.8 -> 13.8 | 0 -> 0 /1 | 1 -> 1 | 0.49 -> 0.49 | 12 -> 12 | 4.3 -> 0 | 1.3 -> 0 | 0.31 -> 0.54 | 1.00 -> - | 1.00 -> 0.00 |
| complex | 41 | 0.784 -> 0.784 | 0.931 -> 0.931 | 3.9 -> 4.0 | 12 -> 14 /17 | 14.3 -> 14 | 0.68 -> 0.56 | 21.7 -> 22 | 58 -> 32 | 1.7 -> 2 | 0.81 -> 0.85 | 0.23 -> 0.31 | 1.00 -> 1.00 |
| lowslope | 22 | 0.797 -> 0.797 | 0.924 -> 0.924 | 2.9 -> 3.5 | 6.3 -> 7 /8 | 7.3 -> 7 | 0.65 -> 0.47 | 11.3 -> 13 | 29.7 -> 18 | 1 -> 0 | 0.76 -> 0.68 | | |
| steep | 15 | 0.797 -> 0.797 | 0.927 -> 0.927 | 3.5 -> 3.5 | 6 -> 7 /10 | 7.7 -> 7 | 0.90 -> 0.89 | 5 -> 4 | 35 -> 19 | 1.7 -> 2 | 0.87 -> 0.67 | | |

Dev line totals against EagleView (all): ridge -23.9 -> -22.9%, hip -0.1 -> +0.6%, valley +24.6 -> +22.1%,
eave -23.1 -> -25.2%, rake -2.7 -> +0.8%. Slivers 0 -> 0, steep junk 0 -> 0, failures 0 -> 0.

Held-out split (30 houses, 13-14 with a key; aggregates only, no per-house output was looked at):

| cohort | n | IoU | aligned IoU | area err % | pitch exact | pitch +-1 | face pitch MAE | checker | thin faces | >18/12 | flag rate | flag precision | flag recall |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| all | 30 | 0.797 -> 0.794 | 0.913 -> 0.910 | 3.1 -> 3.6 | 9 -> 8 | 12.7 -> 13 | 0.75 -> 0.74 | 20 -> 20 | 27.7 -> 18 | 0.3 -> 0 | 0.67 -> 0.73 | 0.35 -> 0.36 | 0.78 -> 0.80 |
| canopy-heavy | 11 | 0.740 -> 0.741 | 0.938 -> 0.938 | 1.9 -> 2.0 | 3.3 -> 3 | 6 -> 6 | 0.65 -> 0.63 | 8.3 -> 8 | 5 -> 5 | 0 -> 0 | 0.70 -> 0.82 | 0.28 -> 0.25 | 1.00 -> 1.00 |
| canopy-none | 13 | 0.816 -> 0.816 | 0.910 -> 0.910 | 4.4 -> 4.3 | 4 -> 3 | 5 -> 5 | 0.86 -> 1.02 | 8 -> 8 | 17.3 -> 8 | 0 -> 0 | 0.59 -> 0.69 | 0.33 -> 0.33 | 1.00 -> 1.00 |
| complex | 21 | 0.809 -> 0.809 | 0.924 -> 0.924 | 2.6 -> 3.1 | 6.3 -> 5 | 9 -> 9 | 0.78 -> 0.79 | 12.7 -> 13 | 24.3 -> 15 | 0.3 -> 0 | 0.62 -> 0.67 | 0.30 -> 0.29 | 0.67 -> 0.67 |
| lowslope | 10 | 0.859 -> 0.859 | 0.878 -> 0.878 | 22.0 -> 22.0 | 3 -> 3 | 3 -> 3 | 0.60 -> 0.64 | 5.3 -> 6 | 5.7 -> 5 | 0.3 -> 0 | 0.83 -> 0.80 | | |

Held-out cohorts under 10 houses are not gated: canopy-light (6; 1-2 key houses depending on the seed, base IoU range 0.685-0.859 across seeds) IoU 0.745 -> 0.686,
area 18.7 -> 17.5%; simple (9)
IoU 0.703 -> 0.703, area 5.8 -> 7.2%, flag rate 0.78 -> 0.89.
Held-out line totals (all): ridge -13.1 -> -12.7%, hip -27.1 -> -31.7%, valley -7.4 -> -10.2%, eave -27.1 -> -28.7%,
rake +10.4 -> +12.8%.

Gates: dev 174 pass / 0 fail; held-out 109 pass / 0 fail (144 and 29 skipped as small cohorts), after every merge
except the first canopy run (fixed above).

Determinism: 0 of 54 dev and 0 of 30 held-out houses differ on a same-seed rerun (as before); houses whose result
changes with the seed went from 28/54 to 0/54 (dev) and 16/30 to 0/30 (held-out): seeds 7, 8 and 9 now give
byte-identical roofs, so the "variance across seeds" is zero.

Runtime (bench, ms, p50/p95, machine shared with other agents, calibration loop 20 -> 23 ms): dev 208/664 -> 291/840,
held-out 171/524 -> 235/731. About +40% at p50 before calibration; the calibrated runtime gate (1.5x p95) passes.
Most of the rise is the canopy completion and the edge evidence.

Review reasons (houses carrying each, dev): differs-from-google 20.3 -> 3 (the rest are notes now), edges-unverified
0 -> 23, faces-patchy 18.3 -> 19, low-attachment 9 -> 10, roof-hidden 7 -> 7. Held-out: differs-from-google
10 -> 1, edges-unverified 0 -> 11, faces-patchy 7 -> 10.

### What got worse (all of it)

- Held-out median area error 3.1 -> 3.6% (gate allows +0.5 points); complex 2.6 -> 3.1%; dev low-slope 2.9 -> 3.5%.
- Held-out main pitch exact 9 -> 8 of about 14; canopy-none 4 -> 3; held-out canopy-none face pitch MAE 0.86 -> 1.02.
- Held-out IoU 0.797 -> 0.794, aligned 0.913 -> 0.910; held-out canopy-light (6 houses, ungated) IoU 0.745 -> 0.686,
  simple (9) area 5.8 -> 7.2%.
- Line totals: eave -23.1 -> -25.2% (dev), -27.1 -> -28.7% (held-out); held-out hip -27.1 -> -31.7%, valley
  -7.4 -> -10.2%; dev canopy-heavy hip -4.1 -> -24.7% (2 houses).
- Dev steep checker 5 -> 4 of 15; dev main pitch within 1/12 15.3 -> 15.
- Flags: dev flag rate 0.69 -> 0.78 and recall 1.00 -> 0.80 (ev-51881820, a +13.8% attachment, lost its only
  catching reason; 22% unverified, under the 25% line); simple roofs flagged 0.31 -> 0.54; canopy-heavy 0.77 -> 0.90;
  held-out flag rate 0.67 -> 0.73. Clean simple roofs now get a review more often, the opposite of one of the stated
  issues, because the unverified-edge review fires on tree houses.
- Runtime about +40% p50.

## Flags and switches

- `ROOF_3D_MODE` (`apps/api/src/config.ts`, default `on`): `off` measures every home the old way (footprint, no 3D
  roof); `shadow` reconstructs and keeps the roof as `shadowRoof` but prices the old way; `on` uses it.
- Reconstruction options (code, not env): `faces: { enabled: false }` turns the weak-face cleanup off;
  `planes: { lattice: false }` restores the random plane search; `canopy: { complete: false }` turns completion off.
- `ROOF_3D_ALGORITHM_VERSION = 2` covers this whole release. Any later change to reconstruction output must bump it.

## Rollback

1. Fastest: set `ROOF_3D_MODE=off` (or `shadow`) and restart the API. No data migration; stored snapshots stay.
2. Per change: `git revert -m 1 <merge>` for one track (merge commits above: `6fce95f7` hardening, `50d2b626` faces,
   `51014ad1` + fix `f11135ac` canopy, `11328cb0` outline, `ce6cc303` confidence). Reverting faces or canopy changes
   output: bump `ROOF_3D_ALGORITHM_VERSION` with it so snapshots made by this release are rebuilt. Snapshots written by
   this release carry extra optional JSON fields (`schemaVersion`, `algorithmVersion`, `maskCut`, `edges`,
   `quality.notes`/`edgeSupport`, face `confidence`) that older readers ignore.
3. Note the cost of a rebuild: each version bump re-buys Data Layers once per home re-measured within 30 days (raw
   layers are not kept).

## Risks and open issues

- 305 Ridgeway still shows 4 faces and a jagged outline; the outline itself did not move on any EagleView house (median
  aligned IoU 0.927 both sides). "Outlines much more accurate" is not delivered by this release; uncertainty is now
  shown instead.
- Edge confidence numbers (0.865/0.582) are pooled from all 54 original houses, including today's held-out ones.
- The bench gates do not yet cover aligned IoU, the independent checker or `quality.notes`; a new baseline and
  `gates.json` change are needed to gate them.
- Raw Data Layers are not stored, so a version bump costs a purchase per re-measured home.
- `npm audit` (outside this round): maplibre-gl (critical, XSS in DOM.sanitize), uuid via exceljs (moderate).
- See each track note for its own open issues.
