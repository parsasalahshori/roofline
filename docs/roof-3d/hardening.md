# Roof 3D hardening

Track: hardening (failure modes FM01, FM05, FM11, FM13 of the October 2026 taxonomy, plus input guards, a kill
switch, secrets and data retention). One section per change, in the order they were committed.

## 1. Versioned 3D snapshots (FM01)

**Problem.** A measurement keeps the 3D roof it was priced from (`measurements.roof_3d`), and `roof3dForHome` reuses
the newest one for 30 days. Nothing recorded which reconstruction made it (`Roof3d.version = 1` is the shape, not the
algorithm), so an improved algorithm never showed on a home already measured: the owner's 305 Ridgeway Dr screenshot
(four sliver faces) was a snapshot from before the sliver cleanup, served again on five later measurements, and with no
quality block, so no review banner could show either.

**Approach.** Every snapshot is stamped with `schemaVersion` (its layout, now 2) and `algorithmVersion`
(`ROOF_3D_ALGORITHM_VERSION`, now 2) before it is kept. `roof3dSnapshotFresh` treats any algorithm version other than
the running one (older, newer, absent = 1, or garbled) as stale, so the home is reconstructed again (one Data Layers
request, inside the free quota) and the new measurement keeps the new snapshot. A kept "no imagery" is Google's answer,
not the algorithm's, so it stays fresh across versions (no needless purchase). Readers ignore fields they do not know;
legacy rows still read and render exactly as before (`isRoof3d` is unchanged).

**Rule for every later change:** bump `ROOF_3D_ALGORITHM_VERSION` with any change that changes what a reconstruction
returns. A pure refactor leaves it.

**Alternatives rejected.** Hashing the reconstruction source files at build time (changes on comment edits, so every
deploy would re-buy every roof); a date cut-off (cannot express a rollback); keeping the raw layers to re-run without a
purchase (the right next step, see open issues, but a storage change that cannot be cherry-picked on its own).

**Risks.** Each version bump costs one Data Layers request per re-measured home within 30 days (free quota today).
Two servers running different versions side by side would each treat the other's snapshots as stale and re-buy.

**Rollback.** Revert the commit: snapshots stamped meanwhile carry two extra JSON fields that older readers ignore.

## 2. No "no roof" from clipped layers (FM05)

**Problem.** Layers bought in this process were reused for any point at least 6 m inside them. A roof reaching past
their edge came back clipped, `roof3dAt` kept `none: 'no-roof'`, and that covered the 3 m round the point for 30 days:
the home was measured from a footprint rectangle with nothing saying why (most likely 205 Ridgeway Dr, and 310 Ridgeway
Dr's good 3D roof hidden behind a later no-roof). The analysis simulated it on the 54 houses: with the reused layers'
edge 6 m from the point, 87% of (house, side) cases clipped.

**Approach.**
- Reused layers must cover Google's box for the building (when it is this home's) plus the 6 m margin, or, with no
  building, the point plus 20 m (`NO_BUILDING_REACH_M`: a 28 m square house's half-diagonal; a request round a bare
  point asks for 30 m, so its own layers always qualify).
- A roof still clipped (reused or freshly bought layers alike, e.g. a roof bigger than Google's box) buys one more
  request, 1.5x wider (capped at Google's 100 m), and is reconstructed on that. Still clipped: a typed `clipped`.
- `Roof3dSnapshot.none` is typed: `no-imagery`, `no-building`, `no-roof`, `clipped`, `unusable`, `timeout`, `shadow`.
  Only `no-imagery` (Google's imagery is per area) and `no-building` (no Google building and no roof) are ever reused;
  every other negative is about one attempt and the next Measure tries again. Older rows' catch-all `no-roof` is no
  longer reused either.
- The in-process roof cache key includes the building box the request was sized by, and attempt-specific negatives are
  dropped from it at once.
- Layers that do not come within 40 s (`LAYERS_BUDGET_MS`) are a typed `timeout`; any other Data Layers failure is
  null as before (not kept), counted with its reason (`SolarLayersUnavailableError.reason`).
- `roofOnLayersResult` returns the reason with no roof (`clipped`, `not-found`, `bad-crs`, or the input guard's
  reason) and never throws; `roofOnLayers` keeps its signature for the benchmark and checker.

**Tests.** `apps/api/test/pure/roof-3d-clipped.test.ts` (no database): the Ridgeway sequence (a neighbour's layers hold
the point 7.5 m inside but cut 5 m of the roof) and a seeded property test over 10 random roofs cut off at random sides
by 1 to 5 m (with and without Google's building) all return the roof; all six tests fail on the commit before.

**Alternatives rejected.** Never reusing layers (doubles purchases for a prefetch followed by a Measure); a larger
point margin alone (still fails for long houses, and buys more for small ones than the box rule).

**Risks.** A roof clipped twice costs two purchases where it used to cost none (it used to cost a wrong measurement).
`no-building` is decided by the reconstruction too, so it is version-checked like a roof.

**Rollback.** Revert; snapshots with the new `none` values read as "no roof" under the old code (never reused for
`clipped`/`unusable`/`timeout`/`shadow`... the old reader reuses any non-imagery negative within 3 m, the old behaviour).

## 3. Kill switch, counters and input guards

- `ROOF_3D_MODE=off|shadow|on` (default on). off: no Data Layers request, Measure goes the outline way. shadow: the roof
  is reconstructed and kept on the measurement as `shadowRoof` (`roof: null, none: 'shadow'`), so Measure prices from
  the outline as before; switching to on reuses that kept roof without a new purchase. Tested in
  `apps/api/test/pure/roof-3d-mode.test.ts`. `GOOGLE_SOLAR_DATA_LAYERS=0` still removes the provider altogether.
- Counters (`estimator/roof-3d-events.ts`): one typed outcome per attempt (`built`, `reused`, `stale-snapshot`,
  `no-imagery`, `no-building`, `no-roof`, `clipped-retry`, `clipped`, `unusable`, `timeout`, `unavailable`,
  `fallback`, `off`, `shadow`, `shadow-diff`), counted per app and written as one JSON line
  `{"event":"roof-3d","outcome":...}` with numeric or enum details only (never a URL, address or key).
  `shadow-diff` compares the shadow roof's plan area with Google's segments (more than 10% apart, the benchmark's
  "bad" line); the comparison with the outline the measurement actually used is not made here (see open issues).
- `rasterProblem` (`roof-reconstruct/guard.ts`, a new file; one added export line in `roof-reconstruct/index.ts`):
  dimensions, a 2,400 x 2,400 pixel cap (Google's 100 m radius cap at 0.1 m plus 20%), pixel size 0.05 to 1 m, array
  lengths, all no-data, empty mask, non-finite point. `roofOnLayersResult` checks it before reconstructing and catches
  anything thrown inside, so a Measure never sees an exception from the reconstruction.
- The benchmark's output is byte-identical on all 54 dev houses (every house's result hash equal to the run before).

## 4. GeoTIFF decoding, the Data Layers client, secrets

- `readGeoTiff` reads the grid size first and refuses more than 2,400 x 2,400 pixels before decoding (a small
  compressed file can declare a huge grid), checks the decoded length, and every failure is
  `SolarLayersUnavailableError` with a reason (`decode`, `too-large`). `layersFrom` refuses a mask in another UTM
  zone or skewed pixels (`mismatch`) and a grid in no UTM zone (`bad-crs`).
- The client's timeout now covers the body as well as the headers (a body that trickles in used to be waited for
  forever), timeouts are typed `timeout`, the JSON answer is capped at 64 KB, coordinates off the globe are refused
  before any request, and **file URLs from Google's answer are only fetched (with the key) when they are https on the
  API's own host**; anything else is `bad-answer` and never sent the key.
- Tests (`apps/api/test/pure/geotiff-fuzz.test.ts`, seeded): 60 truncations, 30 random byte strings, 30 corrupted
  files, empty, 1-pixel, 4000 x 4000, NaN/Infinity heights, mismatched zones, a non-RGB photo; at the reconstruction
  entry: holes, a mask touching every edge, two roofs, a checkerboard, NaN and 1e30 spikes, 1-pixel and 3 x 3 grids,
  the southern hemisphere and both sides of three UTM zone boundaries (the same 4-face hip roof is found).
- Secrets (`apps/api/test/pure/secrets.test.ts`): the real client against a fake Google in six modes (ok, HTTP 500
  with the URL in the body, fetch throwing with the URL in its message, a bad file, no imagery, a hang); every console
  channel, the app's error log, the outcome counters, the snapshot and the thrown error are captured and grepped for
  the key, its URL-encoding and `googleapis.com`. A static check fails if the provider or estimator code passes a URL
  or key to a console call or an error, or sets a `cause`.
- Dependency audit (`npm audit --omit=dev`, 2026-10-14): `geotiff@3.0.5` (MIT) and its runtime dependencies
  (`@petamoriken/float16` MIT, `lerc` Apache-2.0, `pako` MIT AND Zlib, `parse-headers` MIT, `quick-lru` MIT, `web-worker`
  Apache-2.0, `xml-utils` CC0-1.0, `zstddec` MIT AND BSD-3-Clause) have no advisories and no copyleft licence. The audit
  does report `maplibre-gl` (critical, XSS in DOM.sanitize) and `uuid` via `exceljs` (moderate), both outside this
  track.
- Not changed: redirects. A redirect from Google would be followed with the key in the URL; refusing redirects might
  break the live app if Google's file endpoint ever redirects, and that cannot be checked without a paid call.

## 5. The mask cut, typed and visible (FM11)

**Problem.** Before fitting, the reconstruction removes mask parts lying on the ground (`groundParts`) and, for a
terrace home, the neighbours' part, and clears both from the mask the outline is then checked against, so
`outlineIoU` cannot see the loss (one ablation lost 42% of a roof with a clean quality block).

**Approach (additive only).** `reconstructRoof` counts what each cut removed from Google's mask part (`LocalRoof.cuts`,
three counters added in `roof-reconstruct/index.ts`, no decision changed) and the server attaches
`Roof3d.maskCut = { maskSqFt, groundSqFt, terraceSqFt, removedShare, reason }`, with reason `ground-cut` or
`terrace-cut` when more than 10% (`ROOF_MASK_CUT_SHARE`, the benchmark's "bad" area line) was removed. It is not a
review reason here: turning it into one (and choosing its tier) belongs to the confidence track, which can read it.
The benchmark's metrics are identical on all 54 dev houses (only the result hashes change, by the new field).

**Not done.** Falling back to the uncut roof when the ground fit has too few band pixels (an algorithm change in
`ground.ts`, owned elsewhere).

## 6. Benchmark blind spots (FM13), bench code only

- **Alignment-aware EagleView scoring.** `bestTranslation` (geometry.ts) finds the translation of the key, within
  3 m on each axis (twice the analysis's 1.46 m median offset), that maximises IoU: a 0.5 m grid, then 0.1 m round the
  best cell; deterministic. `TruthMetrics.aligned` holds IoU, mean boundary distance and HD95 after it, and the shift.
  The raw numbers stay as they were. Dev split, mean over seeds 7/8/9: raw IoU 0.782 becomes 0.927 aligned, boundary
  0.91 m becomes 0.31 m, HD95 1.92 m becomes 1.22 m, median shift 1.33 m (the analysis found 0.784 to 0.918 and
  1.46 m on all 54 original houses).
- **An independent outline check.** The checker's outline target compares the outline with the mask it was traced
  from, after the reconstruction's own cuts (IoU >= 0.939 and edge fit 100% on every house). `outlineCheck` uses the
  aligned EagleView outline where the house has a comparable key, else Google's raw mask part as downloaded (before the
  ground and terrace cuts, so FM11 losses show; still Google's mask, so labelled a proxy), ok at IoU >= 0.85 (the
  analysis's aligned-IoU "bad" line). `checkerIndependentPassed` is the checker with that target in place of the
  circular one. Dev: 50 of 54 outlines pass the independent check; the checker passes 33.7 of 54 (old) and 31 of 54
  (independent), mean over seeds.
- **Seeds.** The gates already compare the mean over seeds 7, 8 and 9 with the baseline's seed range as tolerance
  (commit b7c97f76, before this round); nothing to change. The new numbers are reported but not gated: the frozen
  baseline does not have them, and adding a gate changes `gates.json`, which belongs to the integrator with a new
  baseline.
- Bench runtime with the alignment: the dev split runs in about 2 minutes 12 s (gate on p95 passes).

## 7. Size and time budgets, latency, retention

- **Roof size budget.** `MAX_ROOF_PART_M2 = 3000` (`roof-reconstruct/guard.ts`): the mask part under the point is
  measured by a bounded flood fill before reconstructing; bigger is a typed `too-large` (`none: 'unusable'`). A 200 m
  square roof used to take 15 s and 570 MB of one synchronous run (stalling every other request); it is now refused
  in 25 ms. The largest roof allowed (a 54 m square, about 2,900 m2) on the largest grid takes 1.7 s; the perf budget
  test (`apps/api/test/pure/retention-perf.test.ts`) holds it under 6 s. The grid itself is capped at 2,400 x 2,400.
- **Time budget.** Fetching: 40 s overall (`LAYERS_BUDGET_MS`), on top of the client's per-request timeouts which now
  cover the body. Reconstruction: bounded by the two size caps (it is synchronous and cannot be pre-empted without a
  worker thread; see open issues).
- **Latency and memory** (`npm run roof3d:perf -w @roofline/api`, dev houses only, aggregates): decode p50 46 ms,
  p95 59 ms; reconstruct p50 286 ms, p95 811 ms, max 894 ms; total p50 333 ms, p95 857 ms; peak RSS 324 MB, peak heap
  64 MB (shared machine with four other agents running).
- **Retention** (`npm run solar:retention -w @roofline/api [-- --root DIR] [--now DATE] [--delete]`): lists the
  development folders holding Google's files (`dsm.tif`, `mask.tif`, `rgb.tif`, `bi.json`) past their 30 days, by the
  benchmark manifest's `deleteBy`, else `info.json`'s `downloadedAt`, else the files' times; deletes only those
  files, only with `--delete`. Today: 138 folders, none past their date (earliest 2026-11-10). Stored measurements
  are out of its reach (see open issues): the server already stops showing a kept photo after 30 days
  (`solarDataCurrent`), but the rows and photo objects stay.

## Sensitivity (+-20% on each constant this track adds; dev split)

| constant (value) | -20% | +20% | what moves |
| --- | --- | --- | --- |
| `OUTLINE_CHECK_IOU` (0.85) | 0.68: 52 of 54 outlines pass | 1.02 is impossible; 0.90: 48, 0.95: 32 | the independent outline check; 0.85 sits on a plateau (50) between 0.80 and 0.90 |
| `ALIGN_MAX_SHIFT_M` (3 m) | 2.4 m: one key house's 2.5 m shift is cut short | 3.6 m: no change (largest shift 2.5 m on an axis, 2.88 m overall) | aligned IoU medians |
| `ROOF_MASK_CUT_SHARE` (0.10) | 0.08: 1 of 54 houses gets a reason (a 9.0% ground cut) | 0.12: 0 | maskCut.reason |
| `MAX_ROOF_PART_M2` (3,000) | 2,400: 0 dev houses refused | 3,600: 0 | largest dev mask part is 651 m2; only the worst-case time moves (about 1.4 s to 2.0 s) |
| `NO_BUILDING_REACH_M` (20 m) | 16 m: a reused grid can still cut a house over 32 m across | 24 m: more purchases for houses near another grid's edge | purchases vs clipping; the property test passes at both (its houses are 25 by 22 m) |
| `RETRY_GROWTH` (1.5) | 1.2 | 1.8 | the retry's radius; the retry test passes at both; the cap is Google's 100 m |
| `LAYERS_BUDGET_MS` (40 s) | 32 s | 48 s | only how long a Measure can wait; Measure's own `ROOF_3D_WAIT_MS` stops waiting first |

The reconstruction's output is unchanged by this track (bench metrics identical on all 54 dev houses at every commit),
so there is no seed variance of this track's own: the dev numbers at seeds 7/8/9 are the baseline's (area median
error 4.0 [3.9-4.1] %, checker 33.7 [33-35] of 54, independent checker 31 [30-32] of 54, main pitch exact
12 [11-13] of 18).

## 8. What the screen can say

`MeasurementView` gains two optional fields (`packages/db/src/repos/measurements.ts`, `roof3dStatus`; additive):
`roof3dMissing`, the typed reason a measurement has no 3D roof (so "no 3D roof: the roof runs off Google's map" can be
shown instead of a silent rectangle), and `roof3dOutdated`, true when the 3D roof shown was made by an older
reconstruction (every row stored before this round, such as the six 305 Ridgeway Dr rows), so the screen can offer to
measure again. Unknown stored values are left out, never thrown on. The web copy and display are left to the
confidence track, which owns the review banner (see open issues).
