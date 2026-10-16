# Measure windows: the floors bench

`apps/api/src/scripts/windows-floors-bench.ts` (no network) reads the roof benchmark's houses with cached Google
heights (`~/RooflineWork/roof-bench`, `ROOF_BENCH_DIR`), takes the Microsoft footprint at each house's point
(`free/ms`), and compares the walls' floors and the window count before and after the per-wall heights against the
storeys in `floors-bench-labels.csv`.

    npx tsx apps/api/src/scripts/windows-floors-bench.ts            # labelled houses and the score
    npx tsx apps/api/src/scripts/windows-floors-bench.ts --all      # every house
    npx tsx apps/api/src/scripts/windows-floors-bench.ts --png DIR  # each house's heights (1 m colour bands) beside its photo

## Labels

48 of the 84 bench houses, labelled by eye (Oct 16 2026) from the height map in 1 m colour bands next to Google's aerial
photo, and only where the storeys were clear: the eaves round the main block, the ridge, a one-storey wing beside a
taller block. 305 Ridgeway Dr (Little Rock) is the owner-verified two-storey house. Houses under trees, on steep lots,
with damaged heights, split-levels and walk-outs were left out (36). Caveat: the labels come from the same height map
the algorithm reads, so the bench checks that the main block is read (not a porch or garage), not the height map itself.
Real counts (WinChoice's measured jobs) are the next check: see WINDOW_TO_WALL_RATIO in windows-estimate.ts.

## Before and after (Oct 16 2026)

Before: the whole outline's 10th-percentile eave (0.2-0.8 m in), one floor below 4.5 m, wall area = perimeter x eave.
After: each wall's own eave (25th percentile of its band), the outline first moved onto Google's roof mask (Microsoft
footprints sit up to 3 m off Google's heights), the main block's eave, the ridge for one and a half storeys, and
9 ft of window wall a floor with low one-storey wings of taller houses left out (the range's top puts them back).

| storeys | houses | floors right before | floors right after |
|---|---|---|---|
| 1 | 30 | 30 | 30 |
| 2 | 17 | 8 | 17 |
| 3 | 1 | 1 | 1 |

Every miss before was a two-storey house read as one floor: a one-storey porch, garage or back wing (kc-brookside,
omaha-roland, ev-51881922, tr-portland, ev-47926585), or a footprint sitting 1.5-2 m off the height map so one side's
band read the ground (lr-305-ridgeway: 2.2 m, 7 ft walls).

Per house (`windows before -> after`; a range when the estimate is unsure):

```
dallas-lakewood                   label=1  before=1 (2.8 m)  now=1 (3.2 m, ridge 4.9, shift 0.0)  windows 8 -> 8
dc-lowell                         label=2  before=2 (5.4 m)  now=2 (6.2 m, ridge 9.1, shift 0.0)  windows 30 -> 31
fs-hendricks                      label=1  before=1 (2.9 m)  now=1 (2.9 m, ridge 5.3, shift 0.0)  windows 13 -> 12
houston-heights                   label=1  before=1 (2.4 m)  now=1 (2.5 m, ridge 5.1, shift 0.0)  windows 30 -> 34
kc-brookside                      label=2  before=1 (3.4 m)  now=2 (6.3 m, ridge 9.4, shift 0.0)  windows 17 -> 14 (14-20)  low wing 85 ft
lr-305-ridgeway                   label=2  before=1 (2.2 m)  now=2 (6.1 m, ridge 8.5, shift 1.5)  windows 8 -> 14 (14-16)  low wing 31 ft
lr-tyler                          label=1  before=1 (3.6 m)  now=1 (4.2 m, ridge 6.2, shift 1.5)  windows 13 -> 10
omaha-roland                      label=2  before=1 (4.1 m)  now=2 (6.7 m, ridge 9.1, shift 1.0)  windows 28 -> 28
orlando-college-park              label=1  before=1 (2.4 m)  now=1 (3.9 m, ridge 9.8, shift 0.0)  windows 16 -> 19 (19-25)
phx-arcadia                       label=1  before=1 (2.4 m)  now=1 (2.6 m, ridge 3.9, shift 0.0)  windows 12 -> 14
rogers-pecan                      label=1  before=1 (2.8 m)  now=1 (2.8 m, ridge 5.4, shift 0.0)  windows 16 -> 16
seattle-wallingford               label=1  before=1 (- m)  now=1 (2.1 m, ridge 3.6, shift 0.0)  windows 13 -> 13
springdale-horseshoe              label=1  before=1 (2.6 m)  now=1 (2.9 m, ridge 4.2, shift 0.0)  windows 13 -> 14
ev-47737198                       label=2  before=2 (4.7 m)  now=2 (4.9 m, ridge 13.0, shift 0.0)  windows 39 -> 46
ev-47747994                       label=2  before=2 (6.8 m)  now=2 (7.2 m, ridge 11.4, shift 0.0)  windows 66 -> 53
ev-47926585                       label=2  before=1 (2.8 m)  now=2 (5.6 m, ridge 7.0, shift 0.0)  windows 14 -> 20 (20-24)  low wing 49 ft
ev-49607192                       label=2  before=2 (5.8 m)  now=2 (6.4 m, ridge 11.4, shift 0.0)  windows 52 -> 49
ev-49611661                       label=1  before=1 (2.8 m)  now=1 (2.8 m, ridge 5.4, shift 1.3)  windows 12 -> 11
ev-50264667                       label=1  before=1 (3.2 m)  now=1 (3.1 m, ridge 5.1, shift 1.7)  windows 18 -> 16
ev-50319630                       label=1  before=1 (3.4 m)  now=1 (3.6 m, ridge 7.3, shift 0.0)  windows 22 -> 17
ev-50332002                       label=1  before=1 (2.6 m)  now=1 (2.9 m, ridge 3.5, shift 0.0)  windows 13 -> 13
ev-51881663                       label=1  before=1 (3.1 m)  now=1 (3.5 m, ridge 6.8, shift 0.0)  windows 30 -> 26
ev-51881820                       label=1  before=1 (2.4 m)  now=1 (3.1 m, ridge 5.0, shift 1.4)  windows 13 -> 15
ev-51881922                       label=2  before=1 (3.4 m)  now=2 (6.4 m, ridge 9.2, shift 0.0)  windows 23 -> 15 (15-25)  low wing 142 ft
ev-51881964                       label=3  before=3 (9.7 m)  now=3 (9.4 m, ridge 12.0, shift 2.8)  windows 86 -> 73
ev-51882232                       label=2  before=2 (4.8 m)  now=2 (5.1 m, ridge 11.4, shift 0.0)  windows 29 -> 34
ev-51883109                       label=2  before=1 (4.3 m)  now=2 (6.7 m, ridge 11.0, shift 0.0)  windows 57 -> 61 (61-64)  low wing 45 ft
ev-52191132                       label=2  before=2 (5.2 m)  now=2 (5.9 m, ridge 7.2, shift 0.0)  windows 30 -> 32
ev-52191985                       label=1  before=1 (2.3 m)  now=1 (2.6 m, ridge 4.7, shift 0.0)  windows 13 -> 15
ev-52192220                       label=2  before=2 (5.4 m)  now=2 (7.5 m, ridge 9.5, shift 2.1)  windows 31 -> 32
ev-53863159                       label=2  before=2 (4.5 m)  now=2 (4.7 m, ridge 9.8, shift 1.0)  windows 38 -> 46
tr-atlanta-1289767665             label=1  before=1 (2.5 m)  now=1 (2.6 m, ridge 4.1, shift 0.8)  windows 11 -> 13
tr-austin-379185718               label=1  before=1 (4.0 m)  now=1 (4.2 m, ridge 6.7, shift 0.8)  windows 18 -> 13
tr-austin-379186033               label=1  before=1 (3.5 m)  now=1 (2.9 m, ridge 5.3, shift 2.5)  windows 15 -> 12
tr-fayetteville-466556470         label=1  before=1 (3.2 m)  now=1 (3.5 m, ridge 6.9, shift 0.0)  windows 12 -> 10
tr-fort-smith-1311370290          label=1  before=1 (3.2 m)  now=1 (3.4 m, ridge 7.3, shift 2.0)  windows 20 -> 17
tr-houston-910102897              label=1  before=1 (2.2 m)  now=1 (3.1 m, ridge 5.6, shift 0.0)  windows 11 -> 13
tr-little-rock-1232985555         label=1  before=1 (2.9 m)  now=1 (3.0 m, ridge 5.1, shift 0.0)  windows 13 -> 13
tr-little-rock-981790186          label=1  before=1 (3.1 m)  now=1 (3.3 m, ridge 7.5, shift 0.0)  windows 26 -> 23
tr-nashville-1217412740           label=1  before=1 (3.6 m)  now=1 (4.5 m, ridge 6.8, shift 0.0)  windows 19 -> 15
tr-north-little-rock-1231151303   label=1  before=1 (2.3 m)  now=1 (2.4 m, ridge 4.0, shift 2.3)  windows 11 -> 14
tr-north-little-rock-1231176703   label=1  before=1 (3.2 m)  now=1 (3.0 m, ridge 4.3, shift 1.3)  windows 12 -> 10
tr-portland-354678699             label=2  before=1 (3.4 m)  now=2 (6.9 m, ridge 8.8, shift 0.0)  windows 20 -> 14 (14-22)  low wing 111 ft
tr-raleigh-47735197               label=2  before=1 (2.9 m)  now=2 (5.8 m, ridge 9.2, shift 1.5)  windows 13 -> 22
tr-raleigh-47735779               label=2  before=1 (3.4 m)  now=2 (6.5 m, ridge 9.7, shift 0.0)  windows 14 -> 14 (14-17)  low wing 39 ft
tr-seattle-220924176              label=1  before=1 (3.8 m)  now=1 (3.8 m, ridge 6.1, shift 0.0)  windows 17 -> 13
tr-seattle-220966568              label=1  before=1 (2.5 m)  now=1 (2.6 m, ridge 4.4, shift 0.0)  windows 12 -> 13
tr-seattle-222155638              label=1  before=1 (- m)  now=1 (1.9 m, ridge 3.5, shift 0.0)  windows 12 -> 12

floors right: before 39/48, now 48/48
  1 storey: before 30/30, now 30/30
  2 storey: before 8/17, now 17/17
  3 storey: before 1/1, now 1/1
```
