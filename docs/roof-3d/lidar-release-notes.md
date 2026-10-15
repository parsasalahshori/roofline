# Lidar round: release notes (algorithm 6)

Thursday Oct 15 2026. Branch `lidar/merge` from `fb0b63db` (real-lookups, algorithm 5), worktree
`/Users/parsasalahshori-a/RooflineWork/wt-l-merge`. Not pushed, real-lookups not moved.

## What ships, in one paragraph

The default roof changes in one way only: the eave-support sampling bug is fixed (the second half of every edge was
read at its midpoint), so per-edge evidence, edge confidence and the `edges-unverified` reason are now measured over
the whole edge. That is why `ROOF_3D_ALGORITHM_VERSION` is 6. Leaf-off USGS lidar is fully built and wired end to
end (lookup, download, decode, per-house crop, fusion into the reconstruction, provenance, flags, USGS credit), but it
stays **OFF by default** (`USGS_LIDAR_MODE=off`): the evidence that it helps is consistent but thin, and running it
live has open operational risks (below). No free footprint provider was built (the free track found none that beats
our outline on independent truth), so there is nothing to switch on there.

## Merged, in order

| track | branch head | what | default |
|---|---|---|---|
| truth | 920ed9d2 | cross-flight lidar truth (crossflight.py, `--fusion-flight`), edge_points.py feet bug fix, 10 extra AR houses outside the frozen manifest | bench only |
| free | 8987fe0d | county planimetric truth grade (14 houses, `truth-county` cohort), free-provider comparison | bench only |
| support | 7d7a5a22 | eave-support whole-edge sampling, 3-class edge confidence (strong 0.87 / weak 0.71 / unverified 0.51), version 6 | **on** |
| fusion | c1e845ab | lidar-fusion.ts: roof leaf-off lidar sees under crowns, 'lidar' provenance on faces/edges, `roof-from-lidar` review reason | off |
| service | 6bd51d99 | USGS 3DEP lookup + LAZ/EPT reader + crop store + prefetch/area job, `USGS_LIDAR_MODE` off/prefetch/on | off |

Merge conflicts (resolved by keeping both sides): `roof-3d-bench.ts` (cross-flight and county flags; `--lidar-fusion`
crop loader now honours `--lidar-edges-dir` and implies cross-flight truth), `lidar-edges.ts`, and
`withEdgeEvidence` in `apps/api/src/estimator/roof-3d.ts` (support's 3-class `edgeConfidence` plus fusion's per-edge
`source: 'lidar'`).

Integration (this branch, f536e62d): with `USGS_LIDAR_MODE=on`, Measure now hands the service's crop to the **fusion**
step (`usgs-lidar-roof.ts` `fusionOf` / `flightOf` -> `lidarFusionFromEvidence`), not to the older outline-lidar.ts
hidden-edge prototype, which stays a benchmark-only option. The fused roof carries `lidarFusion.flight` (work unit,
dates, QL, leaf-off, USGS credit) and the Measure card shows the USGS credit when fusion applied.

## Switches (kill switches)

- `ROOF_3D_MODE=off`: no 3D roof at all (unchanged).
- `USGS_LIDAR_MODE=off` (default): USGS is never contacted, no lidar field is written, the roof is algorithm 6
  without lidar. `prefetch`: lidar is fetched and its provenance recorded, the roof is unchanged (a lidar-specific
  kill switch that keeps the cache warm). `on`: the crop goes into the fusion step.
- Turning `on` changes reconstruction output for covered houses. Since the remediation (docs/roof-3d/lidar-remediate.md)
  a kept roof the lidar went into is made again whenever the mode is no longer `on`, so switching lidar off withdraws
  fused roofs already measured; fused and unfused roofs both carry algorithm 6, told apart by `lidar.status`.

## The decision: lidar fusion stays off by default

Scored with `roof-3d-fusion-eval.ts` (fusion OFF and ON at the same seed, the key's shift frozen from the OFF
outline), DEV and HELD-OUT together (`--split all --reveal`), on three truths that never come from the flight fused:
EagleView, cross-flight lidar (another flight of the same house), and county planimetric footprints. Outputs:
`/Users/parsasalahshori-a/RooflineWork/roof-bench/merge-l/eval-all-default.{txt,json}` (the crop production would
read: newest leaf-off flight) and `eval-all-xf.{txt,json}` (registry-strict: only flights with a FINE cross-flight
truth).

What the data says:

- **Production-like crops (81 houses with a crop):** fusion applied on 13 (7 DEV, 6 HELD-OUT); the rest declined
  (33 leaf-on flights, 15 sparse, 13 nothing hidden, 5 misaligned, 2 roof changed).
  - **Cross-flight truth:** 26 house pairs, 7 changed, **7 better, 0 worse by IoU** (by |plan error| one is worse:
    305 Ridgeway against the coarse 2017 truth, -17.9% -> +20.1%); median |plan error| over the 26 pairs
    17.9% -> 12.2%. But every one of those 7 truths is a 2016-2017 QL2 flight at 2.4-7 points/m2 (coarse), which the
    truth track found runs about 35% small itself under trees; so "better" is real direction, not a calibrated size.
  - **County footprints (PAgis, walls not eaves):** 9 houses, 7 changed, **7 better, 0 worse**: 305 Ridgeway
    0.744 -> 0.822, lr-tyler 0.652 -> 0.903, nlr-park-hill 0.557 -> 0.632, tr-little-rock-1237040139 0.755 -> 0.819,
    tr-little-rock-951188237 0.805 -> 0.841, tr-little-rock-981790186 0.873 -> 0.889, tr-north-little-rock-1231151303
    0.760 -> 0.861.
  - **EagleView:** 0 scored houses changed (no harm shown, no success shown). The one EagleView house fusion changed,
    ev-51881844 (Hudson WI, held-out), is a 2-structure report the scorer excludes; raw IoU against both structures
    0.27 -> 0.36, so it cannot be read either way.
  - **Applied with no independent truth at all** (added share of the final plan): omaha-roland (+3.9%), tr-austin-379186033 (+20.7%),
    tr-austin-381786736 (+18.9%), tr-nashville-1217412645 (+4.7%), ev-51881844 (+21%, with a 1.2/12 part and
    `rough-heights`), hs-summer (+2.4%). Three of these add about 20% of the roof that nothing independent confirms.
- **Registry-strict (only fine cross-flight truth, 22 houses):** fusion applied on **1** house (305 Ridgeway, fusing
  the 2017 QL2 flight): IoU 0.609 -> 0.794, plan -38.5% -> -17.5%; 0 worse.

Why off:

- **Thin where it matters.** Only one house is scored on a fine, independent lidar truth; zero on EagleView. Every
  other improvement is measured on coarse old-flight truth or on wall-line county footprints, which cannot tell a
  right-sized added wing from an oversized one. Several large additions (about +20%) have no truth at all. The rule
  for this round was "clearly improves ... without regressions beyond noise": the direction is clear (14 of 14
  scored changes better by IoU, none worse by IoU), the size is not. With fusion on, one held-out EagleView house
  (ev-51881844) stops passing the product's own checker (EagleView cohort 'houses passing all targets' 10 -> 9), and
  the canopy-heavy runtime p95 is 1.71x calibrated (gate 1.5x).
- **Operations are not ready for every Measure.** A cold QL1 house takes about 2 minutes, so the first Measure is
  almost always Google-only ('lidar-pending'); the USGS file server refused this machine's connections twice today;
  decoding is 8-28 s of CPU on the API process (no worker thread yet); fusion pushes the canopy-heavy runtime p95 to
  1.70x calibrated (gate 1.5x).
- **Provenance and flags** (after the remediation): fused faces/edges carry `source: 'lidar'` and `lidarShare`, and
  the roof view now draws them in their own colour with the added plan area on the card; every applied roof gets
  `roof-from-lidar`, now a 'block'; lidar roof past Google's building box adds `lidar-past-building` (a 'block': a
  duplex unit and a wing look alike to the box); and a roof made while the lidar is still downloading carries
  `lidar-pending` (a 'block'). Before the remediation lidar edges rendered as Google-'strong' and were invisible.

Recommended next step for the owner: run `USGS_LIDAR_MODE=prefetch` with `USGS_LIDAR_TILE_DIR` set in the Arkansas
service area to warm the tile cache and collect lidar provenance on real jobs at no change to quotes (before the
remediation this silently did nothing in DEMO_MODE, the way the owner's app runs; fixed). Turn `on` only once a handful
of fused Arkansas jobs have been checked against a site measurement or a new fine cross-flight truth, and expect
`lidar-pending` blocks for 5-30 minutes on cold addresses (tiles download one at a time at about 0.5 MB/s).

## 305 Ridgeway Dr, Little Rock AR: before and after

Google's leaf-on data misses a lower east wing under the crowns (about 7.6 m past Google's building box).

| truth (never the fused flight) | released (alg 5/6) | with fusion on |
|---|---|---|
| fine cross-flight lidar (fuse 2017 QL2, score on 2025 QL1) | IoU 0.609, plan -38.5% | IoU 0.794, plan -17.5% |
| coarse cross-flight (fuse 2025 QL1, score on 2017 QL2, which itself misses the wing) | IoU 0.710, plan -17.9% | IoU 0.772, plan +20.1% |
| county PAgis footprint (walls; a correct roof is larger by its eaves) | IoU 0.744, plan -23.2% | IoU 0.822, plan +12.4% |
| debug only, circular (primary lidar truth from the fused flight) | IoU 0.587 | 0.807 |

With fusion on, 516.6 ft2 of plan (31% of the final plan) is added as three lidar faces at 8.2/12, 3.5/12 and 7.8/12; review
reasons `roof-hidden` and `roof-from-lidar`. With fusion off (the default) the roof is the same as before apart from
algorithm 6's edge evidence.

## Free-provider comparison verdict

Full report: [/Users/parsasalahshori-a/RooflineWork/roof-bench/free/comparison.md](/Users/parsasalahshori-a/RooflineWork/roof-bench/free/comparison.md)
(design: docs/roof-3d/free-sources.md).

- We beat the free tools overall: against EagleView our median aligned IoU is 0.916 vs Microsoft 0.893 and Overture
  0.883; sloped area error 3.5% vs 6.2% for Google buildingInsights (which runs 5-10% low); pitch within 1/12 on
  38/40 vs 34/40 against lidar.
- We lose on extent on tree-covered houses (mostly Little Rock), about 15-20% small, where free ML footprints are
  2-9% small. Correction (verifier): on tree houses Overture also beats our outline SHAPE (lidar truth 0.909 vs
  0.884 on 21 houses not traced from lidar; county 0.880 vs 0.783); only Microsoft is worse in shape there. No free source fixes 305 Ridgeway (Microsoft 45% small, Pulaski 20% small, ours 39% small).
- No footprint provider was built. The DEV-only "grow to an aligned Overture footprint when >10% larger" experiment
  helped lidar/county but made 2 of 18 EagleView houses worse at 10% (0 at 12%): too sensitive to ship. The product
  already stores Microsoft footprints, so this can be retried off by default later.

## Default-path effects (algorithm 6, the support fix)

See docs/roof-3d/support.md. Geometry, areas, pitches and faces are unchanged; per-edge unverified shares move
(53 of 902 DEV edges by more than 0.25, so dashed edges in the roof view move), edge confidence becomes 3-class, and
the `edges-unverified` flag set on DEV is the same 23 of 54 houses. Benchmark results for this merge (DEV and
HELD-OUT, against baseline-v2 and gates-v3) are in the "Benchmark" section below.

## Benchmark

`npm run roof3d:bench -w @roofline/api -- --split all --reveal --compare baseline-v2.json --gates gates-v3.json`
(output `roof-bench/merge-l/bench-all-off.{txt,json}`; default settings, so fusion and the service are off):

- **DEV: 327 pass, 4 fail.** The 4 are exactly the ones the support track predicted, all lidar hidden-edge
  scores whose default scorer IS the product's eave-support sampler (so the fix changes the ruler, not the roof):
  lowslope share within 0.5 m 0.672 -> 0.606; simple 0.614 -> 0.559 and mean 0.94 -> 1.07 m; steep 0.332 -> 0.234.
- **HELD-OUT: 229 pass, 2 fail**, same kind: canopy-none hidden-edge share 0.745 -> 0.665, mean 0.34 -> 0.39 m.
- **Held-out vs dev gap: 2 pass.**
- Per house against baseline-v2 (DEV, 54 houses): no difference in any outline, area, pitch, face or review-reason
  metric; only the output hash (edge evidence fields), the lidar hidden-edge sample metrics and the new county
  metrics differ. All 84 houses deterministic and seed-identical.
- Per house against the base reconstruction on HELD-OUT (30 houses, base run `merge-l/base-heldout.json` from
  wt-l-truth = fb0b63db reconstruction): geometry identical; 2 houses gain `edges-unverified`
  (ev-50264667, EagleView aligned IoU 0.70, heavy canopy: a fair catch; tr-hot-springs-1549200551, no outline truth).
- New frozen baseline at algorithm 6 (no per-house held-out data): `roof-bench/baseline-v4-alg6.json`
  (made at 1f6456d0, clean tree). Use it instead of baseline-v2 from now on.

## Remediation (after review and verification)

Design note: docs/roof-3d/lidar-remediate.md. Commits adddf7b4..HEAD on `lidar/merge`. All reviewer P1s and both
verifier P1s fixed at the root with tests that fail on 596ca8ab; cheap P2s fixed (kill switch, range/HEAD integrity,
prefetch latency). Fusion stays OFF by default.

- Default path unchanged: the benchmark at HEAD vs the verified 596ca8ab run gives 0 geometry, 0 reason, 0 truth
  metric and 0 output-hash differences on all 84 houses, at 0.1 m and at 0.25 m; all deterministic and seed-identical.
  So `ROOF_3D_ALGORITHM_VERSION` stays 6 and the gate results above stand (DEV 327/4, HELD-OUT 229/2 against
  baseline-v2, the 6 known hidden-edge scorer gates).
- Remediation tests: typecheck clean, eslint clean; shared 1810 pass; API pure 108 pass; API bench 158 pass; web 1500
  pass (from the repo root); DB-backed measure suites (measurements, measurement-preview, roof-3d, roof-3d-real,
  map-estimate, estimator-fakes, google-solar-layers; Testcontainers) 101 pass, 3 skipped (real-key tests). The full API
  Postgres suite was not re-run. Secret scan of the diff from fb0b63db: 0 hits. Bench outputs:
  `roof-bench/remediate-l/rem-all{,-025}.{txt,json}`.
- 0.25 m effects of algorithm 6 not reported before (verifier): 2 held-out houses gain `edges-unverified`
  (ev-50264667, tr-hot-springs-1549200551) and 2 DEV houses lose it (irvine-99-briar, lidar IoU 0.95, benign;
  tr-portland-354678699); hidden-edge gates vs the base at 0.25 m: DEV 2 fail, HELD-OUT 2 fail (same scorer change).
- Fusion eval re-run at HEAD (`roof-bench/remediate-l/fe-all.{txt,json}`, `--split all --reveal`): the scoring table is
  identical to 596ca8ab (13 applied). On the 13 fused roofs `edges-unverified` is now present on all 13 (it had
  dropped off 5 when lidar edges were judged on the lidar's own ground); `lidar-past-building` fires on 2 (305
  Ridgeway and lr-tyler, both real wings past Google's box: the review costs a look, nothing is refused); every one
  carries `roof-from-lidar`, now a block.
- New review reasons (both 'block', both only with lidar on): `lidar-past-building`, `lidar-pending`.
  `roof-from-lidar` moved from 'check' to 'block'. New lidar none reason `unreadable`.
- Not fixed, listed: EPT reads bypass the daily budget/cooldown/decode queue; bench crops differ from the service's
  crops (score fusion on service crops); thin false additions (spurs, ~1 m overshoot; `openM` 0.75 helps on DEV but
  is in-sample); `Roof3dLidarNote.status` is 'used' when fusion declined; `gpsDate` ignores the LAS global-encoding
  bit; ledger.jsonl and orphaned `.part` files grow unbounded; `maxPointsKept` 2,000,000 vs fusion `maxPoints`
  400,000; unfused version-6 snapshots are reused when lidar is turned on (deliberate, an existing guard test);
  lidar faces are shaded by share, not by the exact lidar pixels; no parcel/footprint bound on lidar parts.

## Tests

- Typecheck (`tsc -b && tsc -p scripts`): clean. `eslint .`: clean.
- packages/shared: 64 files, 1809 tests pass.
- API pure: 14 files, 98 pass. API bench: 15 files, 157 pass.
- Web: 1498 of 1499 pass from apps/web; the one failure (d1-t23-on-call-list, a stylesheet read by a relative path)
  fails the same way on the base and passes when run from the repo root (9/9): a working-directory artifact.
- ui + scripts projects: 37 pass. Python: roof-bench-lidar 14 OK, roof-bench-free 8 OK.
- DB suite (packages/db, Testcontainers): 671 pass.
- API Postgres suite: 4802 pass, 4 failed, 3 skipped on the single end-of-round run:
  - known, unrelated: approvals-approve 'a signed-out request is refused before its body is read' (the 1.1 MB EPIPE);
    front-desk stats-routes 'today' (2 tests).
  - caused by this round, fixed: front-desk-skeleton 'JOB_NAMES gain the Front Desk names' located the Front Desk
    names by position from the end; the service's new 'lidar-area' job shifted them. The test now allows for it
    (re-run with jobs.test.ts: 104 pass).
  - the known web failure e1-job-proposals did not appear in this run.
- Secret scan of the full diff from fb0b63db: no value from .env.keys, no Google/AWS/OpenAI-shaped keys, no
  `key=` URLs, no private keys.

## Not done / unsure

- No live Measure with Google data was run end to end with `USGS_LIDAR_MODE=on` (free quota); the end-to-end path is
  covered by hermetic tests with a synthetic tile, where the fusion declines ('misaligned'), so no hermetic test
  shows an applied fusion through the service (the shared fusion tests do, on synthetic layers).
- The shared `ROOF_BENCH_DIR/lidar-edges` crops for ev-50332002 and ev-51882178 still carry the feet-unit bug
  (heights x0.3048); both decline, but they should be regenerated with the fixed edge_points.py.
- baseline-v2 was frozen at algorithm 5; the default-scorer lidar hidden-edge gates need re-freezing at 6.
- The 10 extra AR houses (xf-extra) stay outside the frozen manifest.
- Hidden-edge share gates in outline-planes/outline-photo (both off) were not recalibrated.
- Lidar leaf-off is judged by months (Nov-Apr); late-March Arkansas flights may have early leaf-out.
- Lidar is USGS 3D Elevation Program data, public domain (credit USGS).
