# Release notes: hidden roof edges under trees (outline round, ROOF_3D_ALGORITHM_VERSION 4)

Branch `outline/merge`, from the lidar-truth commit `ca305cb6` (itself on `c606b7a4`). Not pushed; `real-lookups` is
untouched. Integrator and judge: this note is the decision record. Track notes: [truth.md](truth.md),
[planes.md](planes.md), [photo.md](photo.md), [lidar.md](lidar.md).

## What changed for the user

- **Measure now repairs outline edges that a tree crown hides** (`roofOnLayers` runs `DEFAULT_HIDDEN_EDGE =
  { method: 'photo+planes' }`):
  1. *Photo:* an edge the heights cannot vouch for, hidden by a crown, moves to where Google's photo clearly shows the
     roof ending (rarely: 3 of 902 DEV edges).
  2. *Planes:* a hidden eave is put on the line where its face's plane comes down to the eave height that face's visible
     eaves show; a hidden chamfer at a hip corner becomes the hip corner.
- **Only hidden edges move.** Edges the heights see are never touched; a roof with nothing hidden is byte-identical to
  version 3 (tested). 17 of 54 DEV and 11 of 30 held-out roofs change; plan area changes by -0.2 % to +14.3 % (median
  +3.7 % DEV, +0.9 % held-out), almost always adding roof that the mask lost under a crown.
- **Inferred edges stay "unverified".** Eave support is computed on the final outline, so an edge moved under a crown
  still reads `support: 'none'` in `Roof3d.edges` and the existing unverified-edge cue shows it. There is no separate
  "inferred" tag on `Roof3d` yet (see "Not done").
- **305 Ridgeway Dr, Little Rock AR** (the owner's report): the tree-side south-east chamfer becomes the hip corner.
  Against lidar truth, IoU 0.587 -> 0.635 and hidden samples within 0.5 m 16/69 -> 35/78. The roughly 7-8 m of roof
  east of Google's mask under the tree is **still missing**: no method this round recovers a wing the mask never saw.
- `ROOF_3D_ALGORITHM_VERSION` 3 -> 4: snapshots made by version 3 read as stale and are reconstructed on the next
  request; they still parse and render (the snapshot tests are unchanged and pass).

## The decision

Priorities, in order: (1) hidden-edge boundary error against lidar truth (planes and photo only; the lidar method is
never scored on lidar truth), (2) aligned outline IoU and area against EagleView, (3) no regression on houses with
verified eaves, (4) runtime and determinism. Everything below is the same scorer before and after: harness `ca305cb6`
plus this branch, seeds 7/8/9, `--split all --reveal`.

### Decision table (held-out split first; DEV in brackets)

"truth-hidden" is the fixed set of lidar-outline stretches Google's heights cannot vouch for, measured to our outline;
it does not move with the method, so it is the fairest comparison. "EV fixed set" is the same idea on EagleView's
outline with the key's offset frozen from the option-off outline's strong edges (`roof-3d-lidar-eval.ts --method`).

| approach | lidar truth-hidden <= 0.5 m | lidar hidden <= 0.5 m | lidar IoU median | EV fixed set <= 0.5 m | EV aligned IoU median | EV abs area median | houses changed | product-ready |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| off (version 3) | 40.4 % (35.0 %) | 40.8 % (42.2 %) | 0.908 (0.870) | 47 % (44 %) | 0.910 (0.927) | 2.3 % (4.0 %) | - | - |
| planes | **47.1 %** (38.8 %) | **55.9 %** (47.8 %) | **0.934** (0.864) | **57 %** (45 %) | **0.924** (0.927) | 2.3 % (4.4 %) | 10 (15) | yes |
| photo | 40.4 % (35.1 %) | 40.8 % (41.9 %) | 0.908 (0.870) | 48 % (44 %) | 0.910 (0.927) | 2.3 % (4.0 %) | 2 (3) | yes |
| **photo+planes (chosen)** | **47.1 %** (38.8 %) | **55.9 %** (47.5 %) | **0.934** (0.867) | **57 %** (45 %) | **0.924** (0.927) | 2.3 % (4.4 %) | 11 (17) | yes |
| planes+photo | 47.1 % (38.8 %) | 55.9 % (47.5 %) | 0.934 (0.867) | not run | 0.924 (0.927) | 2.3 % (4.4 %) | 11 (17) | yes |
| lidar | not scored (circular) | not scored | not scored | 46 % (44 %): 1 house changed, worse | 0.910 (0.927) | 2.3 % (4.0 %) | EV houses: 1 (0) | no: needs a lidar fetch per request |

With the dense eave-support scorer (below) the held-out gain is smaller but holds: truth-hidden 40.6 % -> 47.0 %,
hidden 45.7 % -> 52.7 % (DEV 34.0 % -> 38.1 %, 43.5 % -> 47.7 %).

Why each lost or won:

- **planes** carries all of the lidar gain. It is the only method that moves many edges (it needs no evidence beyond
  the heights it already has), and the gain holds on held-out (larger there than on DEV).
- **photo** is safe but nearly inert: Google's photo is mostly leaf-on, so under real canopy it sees no more than the
  heights. It never changed a held-out lidar house. It improves the two worst held-out EagleView misses a little
  (ev-52191132 IoU 0.684 -> 0.722 aligned, area -54.5 % -> -52.0 %; ev-49611661 0.604 -> 0.623).
- **photo+planes** is planes plus photo's few moves: identical to planes on every lidar house on held-out, slightly
  better on DEV (seattle-wallingford 0.880 -> 0.885, tr-little-rock-981790186 +0.003), and on ev-49611661 photo's move
  first leaves planes a smaller step, so the house no longer trips the checker's `outline-off` (held-out gate failures
  12 -> 4). planes+photo gives the same lidar numbers but keeps that checker failure. Chosen: **photo+planes**.
- **lidar** cannot be a default: the product has no lidar fetch (EPT reads only; key Arkansas leaf-off projects are
  whole 100-235 MB tiles), runtime p95 fails its gate, and on EagleView it changed one held-out house (ev-47747994) and
  made it worse (hidden within 0.5 m 65 % -> 59 %, fixed set 53 % -> 47 %). It stays an option for development.

**Verdict: turned on.** On held-out it clearly beats the version-3 outline on the hidden-edge measure (+6.7 points on
the fixed lidar set, +15 points on our own hidden samples, IoU median +0.026, boundary median 0.34 -> 0.25 m) and on
EagleView's outline (fixed set +10 points, aligned IoU median +0.014), and no edge the heights see is moved (the visible
share moves 89.9 % -> 89.6 % because moved outlines bring new samples; the largest cohort drop is 1.1 points, held-out
simple). The regressions below are real and listed in full; on held-out they are
one lidar house slightly worse and one EagleView area number that moves for a pitch reason, not an outline reason.
A stricter reading of "no regression beyond noise" would count seattle-wallingford (DEV) and leave it off; rollback is
one line (below).

### Before / after by cohort (chosen default vs version 3; midpoint scorer, comparable with baseline-v2)

Held-out:

| cohort | lidar houses | hidden mean | hidden <= 0.5 m | truth-hidden mean | truth-hidden <= 0.5 m | visible <= 0.5 m | lidar IoU med | lidar bnd med | lidar abs sloped med | EV aligned IoU med | EV abs area med | EV area <= 5 % | checker |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| all | 14 | 1.06 -> 0.90 m | 40.8 -> 55.9 % | 1.14 -> 1.04 m | 40.4 -> 47.1 % | 89.9 -> 89.6 % | 0.908 -> 0.934 | 0.34 -> 0.25 | 2.6 -> 2.5 % | 0.910 -> 0.924 | 2.3 -> 2.3 % | 9 -> 8 /14 | 21 -> 21 /30 |
| canopy-heavy | 7 | 1.13 -> 0.86 | 37.1 -> 61.3 % | 1.17 -> 1.02 | 38.8 -> 47.3 % | 91.7 -> 91.1 % | 0.875 -> 0.937 | 0.40 -> 0.22 | 7.9 -> 2.6 % | 0.938 -> 0.946 | 2.0 -> 2.0 % | 5 -> 4 /6 | 8 -> 8 /11 |
| canopy-light (2 houses) | 2 | 1.67 -> 1.63 | 14.3 -> 16.6 % | 1.58 -> 1.55 | 26.8 -> 29.6 % | 84.2 -> 84.3 % | 0.823 -> 0.823 | 0.80 -> 0.79 | 12.4 -> 12.1 % | 0.865 -> 0.865 | 18.5 -> 18.5 % | 0 -> 0 /2 | 5 -> 5 /6 |
| canopy-none | 5 | 0.34 -> 0.30 | 74.5 -> 79.0 % | 0.67 -> 0.61 | 57.6 -> 63.1 % | 90.4 -> 90.4 % | 0.948 -> 0.948 | 0.15 -> 0.15 | 2.2 -> 2.2 % | 0.910 -> 0.910 | 2.3 -> 2.3 % | 4 -> 4 /6 | 8 -> 8 /13 |
| tree set | 6 | 1.31 -> 1.23 | 31.7 -> 41.1 % | 1.37 -> 1.36 | **32.9 -> 31.1 %** | **94.5 -> 93.8 %** | 0.857 -> 0.858 | 0.52 -> 0.51 | 11.3 -> 9.7 % | - | - | - | 7 -> 7 /10 |
| lowslope | 3 | 1.13 -> 1.08 | 35.5 -> 38.9 % | **1.21 -> 1.29** | **37.9 -> 32.9 %** | 84.3 -> 84.4 % | 0.882 -> 0.882 | 0.71 -> 0.70 | 4.8 -> 4.9 % | 0.878 -> 0.879 | 22.0 -> 22.0 % | 1 -> 1 /3 | 7 -> 7 /10 |
| simple | 4 | 1.38 -> 0.90 | 25.6 -> 69.5 % | 1.24 -> 0.86 | 35.0 -> 58.5 % | 91.3 -> 90.2 % | 0.873 -> 0.912 | 0.40 -> 0.27 | 11.4 -> 8.8 % | 0.892 -> 0.927 | **7.3 -> 9.2 %** | 2 -> 1 /4 | 7 -> 7 /9 |
| complex | 10 | 0.94 -> 0.90 | 46.7 -> 50.3 % | 1.11 -> 1.12 | 42.6 -> 42.5 % | 89.4 -> 89.4 % | 0.934 -> 0.934 | 0.25 -> 0.25 | 2.3 -> 2.3 % | 0.924 -> 0.924 | 2.1 -> 2.0 % | 7 -> 7 /10 | 14 -> 14 /21 |

DEV:

| cohort | lidar houses | hidden mean | hidden <= 0.5 m | truth-hidden mean | truth-hidden <= 0.5 m | visible <= 0.5 m | lidar IoU med | lidar bnd med | lidar abs sloped med | EV aligned IoU med | EV abs area med | EV area <= 5 % | checker |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| all | 26 | 0.88 -> 0.77 m | 42.2 -> 47.5 % | 1.42 -> 1.31 m | 35.0 -> 38.8 % | 85.6 -> 85.8 % | **0.870 -> 0.867** | 0.49 -> 0.48 | 7.9 -> 7.5 % | 0.927 -> 0.927 | **4.0 -> 4.4 %** | **11 -> 10 /18** | **33 -> 32 /54** |
| canopy-heavy | 4 | 0.96 -> 0.90 | 51.9 -> 53.1 % | 1.57 -> 1.46 | **46.4 -> 45.1 %** | **95.4 -> 94.8 %** | **0.821 -> 0.803** | **0.54 -> 0.59** | 15.0 -> 13.2 % | 0.923 -> 0.922 | **1.0 -> 2.8 %** | **2 -> 1 /2** | **6 -> 5 /10** |
| canopy-light | 13 | 0.89 -> 0.73 | 33.9 -> 43.6 % | 1.04 -> 0.84 | 32.4 -> 40.5 % | 84.6 -> 85.1 % | 0.896 -> 0.896 | 0.42 -> 0.42 | 7.7 -> 7.4 % | 0.915 -> 0.915 | 4.0 -> 4.0 % | 8 -> 8 /12 | 18 -> 18 /31 |
| canopy-none | 9 | 0.78 -> 0.76 | **52.8 -> 51.6 %** | 1.86 -> 1.85 | 32.4 -> 33.2 % | 84.3 -> 84.3 % | 0.848 -> 0.848 | 0.62 -> 0.62 | 8.2 -> 8.2 % | 0.932 -> 0.932 | 6.4 -> 6.4 % | 1 -> 1 /4 | 9 -> 9 /13 |
| tree set | 10 | 1.03 -> 0.94 | 35.3 -> 37.8 % | 1.34 -> 1.20 | 28.9 -> 31.4 % | 80.4 -> 81.0 % | 0.807 -> 0.823 | 0.64 -> 0.56 | 17.1 -> 13.6 % | - | - | - | 13 -> 13 /20 |
| lowslope | 10 | 0.50 -> 0.50 | **67.2 -> 64.7 %** | **1.44 -> 1.48** | **52.5 -> 50.5 %** | 81.1 -> 81.1 % | **0.905 -> 0.890** | **0.30 -> 0.34** | 5.1 -> 3.1 % | 0.924 -> 0.923 | **3.3 -> 3.5 %** | **7 -> 6 /8** | **11 -> 10 /22** |

MEDIUM (0.25 m, every house resampled; no MEDIUM house exists in the benchmark): no throws, no lost roofs, byte-identical
reruns. Against lidar truth on the resampled grid: held-out IoU median 0.901 -> 0.921, truth-hidden within 0.5 m
38.0 % -> 46.1 %, abs sloped median 3.5 % -> 2.6 %; DEV 0.872 -> 0.874, 35.8 % -> 38.9 %, 8.2 % -> 8.1 %.

Runtime (bench p50 / p95 per house, the same machine, not interleaved): DEV 234 / 810 -> 242 / 826 ms, held-out
183 / 593 -> 203 / 578 ms. The planes step costs under 5 ms; the photo step resamples the photo and reads a window
5 m round the crop (tens of ms). Runtime gates pass. Determinism: 0 of 84 houses differ on a rerun, 0 differ across
seeds.

### Every metric that got worse, and why

Per house, with the truth that shows it:

- **seattle-wallingford (DEV, canopy-heavy; lidar):** IoU 0.920 -> 0.885, boundary 0.23 -> 0.36 m, truth-hidden
  within 0.5 m 168/211 -> 135/211. A 19 m north eave is replaced by one plane line; lidar shows the north-west corner
  stepped 1.2 m south under a conifer. Foliage at eave height is indistinguishable from roof in the heights and the
  photo. It gains the `outline-off` review reason (correctly). Its sloped area against lidar moves -6.8 % -> +3.3 %
  (closer in size, wrong in shape). This one house causes the DEV lidar-median-IoU gate failures in canopy-heavy,
  lowslope, simple and set-testset, the DEV lidar boundary failure in simple, and the checker failures.
- **ev-52191985 (DEV, canopy-heavy; EagleView):** sloped area error +1.7 % -> +5.3 %. Planes adds about 8 m2 under a
  dark tree at the south-west; [truth.md](truth.md) records a covered patio there that appeared between captures. On
  EagleView's fixed hidden set the outline is closer (55 % -> 61 % within 0.5 m); the area is not. DEV `complex` median
  area gate fails on it (3.70 -> 4.33).
- **tr-charlotte-1176836651 (held-out, canopy-heavy; lidar):** IoU 0.735 -> 0.728, boundary 1.02 -> 1.08 m,
  truth-hidden 100/318 -> 75/318 (its sloped area improves, -24.3 % -> -19.0 %). This house is the held-out `lowslope`
  truth-hidden gate failure and the held-out tree-set truth-hidden drop. Not investigated house by house (held-out).
- **ev-50264667 (held-out, canopy-heavy; EagleView and lidar):** sloped area error -3.2 % -> +7.1 % against EagleView,
  while its outline gets much closer to both truths (EagleView aligned IoU 0.889 -> 0.959, plan-area error against
  EagleView's outline -6.0 % -> +4.1 %; lidar IoU 0.875 -> 0.958, lidar sloped area -7.9 % -> +1.9 %). The area moves
  because the main pitch is 6/12 for us and lidar, 5/12 for EagleView: the old area was right by two wrongs. This one
  house is both held-out area-median gate failures (canopy-any 2.70 -> 4.62, truth-lidar 3.22 -> 7.06: medians of 8
  and 7 houses) and EagleView area within 5 % 9 -> 8.
- **ev-51882459 (held-out):** EagleView area +7.4 % -> +8.1 %, aligned IoU 0.888 -> 0.885 (its fixed set improves
  44 % -> 61 %, lidar IoU 0.885 -> 0.888).
- **Small:** ev-51883255 aligned IoU 0.917 -> 0.916 (area better); held-out visible share 89.9 -> 89.6 % (new samples
  on moved outlines, none on edges that were verified); DEV canopy-none hidden share 52.8 -> 51.6 % (more samples, not
  worse ones: mean 0.78 -> 0.76 m).
- **Review reasons:** added `outline-off` (seattle-wallingford), `roof-hidden` (lr-305-ridgeway), `faces-patchy`
  (tr-austin-381786736, ev-52191132), `edges-unverified` (tr-raleigh-47735779, ev-50264667); removed
  `differs-from-google` (tr-little-rock-951188237). Flagged roofs: DEV 42 -> 43, held-out 21 -> 21.
- **Gates against baseline-v2 + gates-v3:** DEV 315 pass / 16 fail; held-out 227 pass / 4 fail. The DEV checker-pass
  failures (8 cohorts) are seattle-wallingford's `outline-off`: the checker's outline target is overlap with Google's
  mask, i.e. the evidence an inferred edge departs from (the circularity the standards forbid), but it is the contract
  and it is reported as failed. New baseline (below) is frozen with the default on.

Per house, the other way: lidar IoU improves on 11 lidar houses (largest: tr-houston-910102897 0.627 -> 0.713,
ev-50264667 0.875 -> 0.958, tr-little-rock-951188237 0.775 -> 0.827, lr-305-ridgeway 0.587 -> 0.635,
houston-heights 0.914 -> 0.948, tr-north-little-rock-1231151303 0.698 -> 0.730), and lidar sloped area error improves
on 12 of the 14 changed lidar houses.

## The measurement fix found on the way (scorer, not product)

`eaveSupport` (`eave-support.ts`, since `c606b7a4`) computes `tt = Math.min(t, L / 2)`: every sample past an edge's
midpoint is placed at the midpoint, so the second half of every edge is never measured (found by the lidar track,
confirmed here). The bench's hidden/visible/truth-hidden sets inherit it. `ROOF3D_BENCH_SUPPORT=dense` measures the ring
in 0.2 m pieces instead (test: a crown over only the second half of an eave is invisible to the old scorer and seen by
the new one, at 0.1 and 0.25 m). It is opt-in so baseline-v2 stays comparable; both scorers are reported above and the
decision holds on both. **The product's own `eaveSupport` is not fixed** in this round: it feeds the per-edge support
in `Roof3d.edges`, the `edges-unverified` flag, the confidence calibration and both new methods' hidden tests, so the
fix changes product output everywhere and needs its own round (version bump, recalibration, new baselines).

## Alternatives tried and rejected

- **planes alone:** same lidar numbers; loses photo's two EagleView improvements and keeps one more checker failure.
- **planes+photo** (photo after planes): same lidar numbers; ev-49611661 keeps `outline-off`.
- **Crown gate on planes** (a piece moves only when half its hidden samples are crown-hidden, the photo track's
  `not-crown` rule): on DEV it declined almost every good move (tr-houston-910102897, houston-heights,
  tr-little-rock-951188237, hs-summer) and still moved seattle-wallingford. Reverted, never run on held-out.
- **lidar as a default:** no request-time data path, runtime gate, and the one EagleView house it changed got worse.

## Risks

- Foliage, a deck or a covered patio at eave height under a crown is read as roof (seattle-wallingford,
  ev-52191985). Expect a few percent of tree houses to gain a metre-scale wrong corner. The edge stays flagged
  unverified.
- Area against EagleView can move the wrong way where our pitch differs from EagleView's (ev-50264667): the outline
  change exposes a pitch disagreement that the short outline used to hide.
- The held-out split is no longer pristine for these methods: the integrator saw held-out results for planes before
  choosing photo+planes (photo+planes was chosen for its DEV and EagleView behaviour; its held-out lidar numbers equal
  planes'). Small cohorts (DEV canopy-heavy 4 lidar houses, held-out canopy-light 2, lowslope 3) turn on one house.
- Missing wings (305 Ridgeway's east side, ev-52191132, ev-47747994) are not addressed.

## Rollback

`DEFAULT_HIDDEN_EDGE` in `apps/api/src/estimator/roof-3d.ts`: set the call's `hiddenEdge` to `null` (or make the
default `null`) and set `ROOF_3D_ALGORITHM_VERSION` back to 3 or forward to 5; snapshots made by version 4 then read as
stale and are reconstructed. The methods themselves stay behind their options.

## Baselines and how to reproduce

Files outside the repo, in `/Users/parsasalahshori-a/RooflineWork/roof-bench`:

- `baseline-v3.json`: the default on, clean commit `13268915`, lidar truth `8dec0f5758c3`, midpoint scorer; use with
  `gates-v3.json`. `baseline-v3-dense.json`: the same with `ROOF3D_BENCH_SUPPORT=dense`.
- `outline-merge/`: every run of this decision (`off`, `planes`, `photo`, `photo+planes`, `planes+photo`, `lidar`,
  `dense-*`, `merged*`, `ev-*` EagleView evals, `medium.txt`) and the scripts that tabulate them (`tools/`).

```
npm run roof3d:bench -w @roofline/api -- --split all --reveal --compare <bench>/baseline-v2.json --gates <bench>/gates-v3.json
ROOF3D_HIDDEN_EDGE=off npm run roof3d:bench -w @roofline/api -- ...        # version 3 for comparison
npx tsx src/scripts/roof-3d-lidar-eval.ts --split all --reveal --seeds 7,8,9 --method photo+planes   # EagleView only
```

## Not done

- No per-edge "inferred" tag on `Roof3d` (inferred edges read as unverified, which is honest but not specific).
- The product `eaveSupport` midpoint bug (above).
- Missing wings under canopy; per-wing squaring; hidden rakes (planes declines rakes).
- The lidar method's request-time fetch, cache and budget.
- More tree houses with independent truth: DEV canopy-heavy has 4 lidar houses, so its gates are mostly skipped.
