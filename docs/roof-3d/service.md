# Leaf-off USGS lidar at Measure time (track: service)

## Problem

Google's Data Layers are photogrammetry flown with leaves on: under a crown there is no roof in the height map, and
against lidar truth canopy-heavy roofs come out about 15% too small. Leaf-off airborne lidar (USGS 3DEP) sees the roof
between bare branches, and Arkansas is nearly all QL1 flown January to March 2025. The reconstruction already has a
lidar step (`outline-lidar.ts`, off unless a cloud is passed); what was missing is getting the right lidar for an
address into a Measure request fast, safely and with its provenance.

## Approach

- `apps/api/src/providers/usgs-lidar.ts`: the network side. Coverage from the 3DEP Elevation Index (WESM layer 8:
  work unit, project, QL, collect_start/collect_end) and TNM Access (the LAZ tiles over the point). `chooseUnit`: QL2 or
  better with tiles; leaf-off (every flight day in Nov..Apr) first; newest; name as the tie-break; a leaf-on-only
  answer is typed `leaf-on-only` rather than used. Bounded reads (timeout, byte cap, `redirect: 'error'`, an https host
  allowlist of USGS and the AWS open-data bucket). Variants: `RealUsgsLidarApi`, `FakeUsgsLidarApi` (fixtures, a gate to
  hold reads open, `failNext`), `UnconfiguredUsgsLidarApi`.
- `usgs-lidar-las.ts`: LAS 1.2-1.4 header, VLR WKT / GeoKeys, UTM zone in metres only (state plane or feet is refused,
  `not-utm`), decompression with laz-perf (WebAssembly, no native code), a crop by integer bounds, noise (class 7/18)
  and withheld points dropped, last-return and ground flags. Limits on bytes, points scanned and points kept. Yields to
  the event loop every 100k points (a 15.7 M point AR QL1 tile decodes in about 4.8 s on this Mac).
- `usgs-lidar-service.ts`: the per-house product. A house is cropped on a 10 m grid cell, 40 m each side of the cell
  centre (so at least 35 m round any point in it), from every tile of the chosen unit (at most 4). Tiles come from a disk
  cache (`USGS_LIDAR_TILE_DIR`, size-bounded, oldest evicted, `ledger.jsonl` with URL, bytes, sha256, time) or are
  downloaded in 4 MB byte ranges, 8 at once (the rockyweb server gave 0.14-0.3 MB/s per connection on Oct 15 2026),
  each range retried 3 times with backoff; after a failed download no download starts for 5 minutes ('usgs:cooldown':
  with 16 connections rockyweb refused this machine's connections for minutes after ~230 MB). At most 10 GB a day per
  process ('usgs:budget'). When the usgs-lidar-public bucket holds the work unit as Entwine EPT (probed under its own
  name and USGS's `USGS_LPC_<unit>_LAS_<year>` names), only the octree nodes meeting the house are read (usgs-lidar-ept.ts:
  a few MB from S3, hierarchy sub-files followed, nodes, files, bytes and points bounded), Web Mercator converted to the
  house's UTM zone; a failed EPT read falls back to the tiles (logged). The DERIVED
  product (dx, dy, z float32, flags, class, plus a JSON header with project, work unit, QL, flight dates, point GPS dates,
  density and the USGS credit, about 1-2 MB) goes in the object store under `lidar/v1/crop/<zone>/<e>_<n>.rlc`; never raw
  LAZ, never the database. 'no-coverage' / 'leaf-on-only' / 'too-sparse' answers are kept for 30 days; errors are not.
  One fetch per cell at a time; one derivation at a time.
- Measure (`usgs-lidar-roof.ts` + one hook in `roof-3d.ts`'s `attempt`): started before Google's layers are fetched
  (the budget overlaps them), it reads what is known; else joins or starts the fetch and waits at most
  `USGS_LIDAR_MEASURE_WAIT_MS` (1.5 s). Not ready: Measure proceeds with Google alone and the
  snapshot records `lidar: { status: 'none', reason: 'lidar-pending' }`. Such a snapshot is never shared from the roof
  cache nor reused from the measurement, so the next Measure is made with the lidar.
- Prefetch: the Measure search's prefetch (`prefetchMeasure`) also starts the lidar fetch, and queues a `lidar-area`
  job (pg-boss, singleton per 0.01 degree square, box validated and capped at 0.03 degrees) whose handler
  (`runLidarAreaJob` -> `UsgsLidarService.prefetchArea`) downloads that square's leaf-off tiles (at most 16 lookups and
  4 tiles) into the tile cache, so neighbours derive without a download.
- Provenance: `Roof3dSnapshot.lidar` (`Roof3dLidarNote`: used / kept / none + typed reason, work unit, project, QL, flight
  days, leaf-off, age vs Google's imagery, point count, credit). What the reconstruction did with the points is the
  roof's own `lidarEdges` (applied, moved edges); the web shows "Edges under trees placed from leaf-off lidar: USGS 3D
  Elevation Program (3DEP)" whenever `lidarEdges.applied`.
- Config: `USGS_LIDAR_MODE` off (default) | prefetch | on; `USGS_LIDAR_TILE_DIR`; `USGS_LIDAR_MEASURE_WAIT_MS`;
  `USGS_LIDAR_TILE_CACHE_GB`.

## Alternatives rejected

- Python/PDAL sidecar: a second runtime in production for one decoder; laz-perf is the reference LAZ decoder compiled
  to wasm and decodes a tile in seconds.
- Raw tiles or points in Postgres: hundreds of MB per tile, no query need. Only the derived crop is kept, in the
  object store.
- Waiting for lidar inside Measure: a cold tile is 60-300 MB at about 5 MB/s with 16 ranges, far past a person's
  patience. Measure never waits more than the budget.
- EPT only: the public EPT bucket covers older projects only (none of the 2023-2025 QL1 Arkansas flights), so tiles
  stay the main path and EPT the fast one when it exists.
- The hobu resources.geojson index of EPT names: 8.7 MB to fetch and keep fresh; probing at most five names with HEAD
  requests (about 0.1 s each) found every Arkansas bench unit that is in the bucket.
- Reading only part of a LAZ tile: USGS chunks are in flight order, not spatial, so a house's points are spread over the
  whole file.

## Risks

- `USGS_LIDAR_MODE=on` changes reconstruction output (since the merge, the crop goes to the lidar FUSION step,
  lidar-fusion.ts, not to the outline-lidar.ts prototype; see lidar-release-notes.md): turning it on must bump
  ROOF_3D_ALGORITHM_VERSION and be scored on EagleView and cross-flight lidar truth (never the flight it read). Default
  off: output is byte-identical to version 5 (guard test `roof-3d-lidar.test.ts` 'off by default').
- Memory: a tile is held whole (up to `maxTileBytes`, 400 MB) plus its copy in the wasm heap during a derivation; one
  derivation at a time bounds it.
- CPU on the API process: decoding is cooperative (yields), but a busy server deriving many houses should move it to a
  worker process (the area job is the natural place).
- Leaf-off is judged from the work unit's collect dates (Nov..Apr). Spring green-up in the deep south starts in March;
  the reconstruction also checks density and registration.
- The USGS index services change shape now and then: an unreadable answer is 'bad-answer' -> `error`, not kept.

## Rollback

`USGS_LIDAR_MODE=off` (the default): nothing is asked of USGS, nothing is recorded, the roof is exactly version 5's.
Derived products under `lidar/v1/` can be deleted at any time; they are rebuilt on demand.

## Measured (Oct 15 2026, this Mac, real USGS servers, no Google call)

`npm exec -w @roofline/api -- tsx src/scripts/usgs-lidar-timing.ts <tile dir> [--seed <dir>] slug=lng,lat ...`. Cold
Measure = Measure right after the search with nothing cached (the 1.5 s budget, then 'lidar-pending'); ready after =
from that Measure until the product is kept; from cached tile = the area job already downloaded the tile; warm =
a later Measure (product read from the object store).

| House (testset) | Read from | Cold Measure | Ready after (cold) | From cached tile | Warm Measure | Points, last returns/m2 |
| --- | --- | --- | --- | --- | --- | --- |
| lr-305-ridgeway | tile, AR_Western_4_B24 QL1, 99 MB | lidar-pending at 1.50 s | 105.6 s (an earlier run: index timeout at 20 s, then 95 s) | 8.2-18.4 s | 0.5-1.3 ms | 193,996, 17.6 |
| lr-tyler | 2 tiles, AR_Western_4_B24 QL1, 232 MB | lidar-pending at 1.50 s | 159.6 s | 23.6 s | 1.0 ms | 226,637, 18.3 |
| hs-summer | tile, AR_Western_5_B24 QL1, 96 MB | lidar-pending at 1.50 s | 121.0 s | 9.1-13.5 s | 0.6 ms | 211,853, 18.3 |
| nlr-park-hill | 3 tiles, AR_Western_4_B24 QL1 | lidar-pending at 1.50 s | not measured: four tries 07:16-07:49 PDT failed typed (index timeout once; rockyweb refused connections, then was unreachable even at its root; later tries got usgs:cooldown) | 25.3-28.5 s | 0.8 ms | 235,891, 17.9 |
| fs-hendricks | EPT, AR_Ouachita_B7_2016 QL2, 22 nodes, 11.8 MB | lidar-pending at 1.51 s | 2.5 s | 2.0 s (re-read) | 0.2 ms | 45,723, 5.4 |
| rogers-pecan | EPT, AR_Benton_Co_2015 QL2, 13 nodes, 7.1 MB | lidar-pending at 1.59 s | 1.9 s | 1.7 s (re-read) | 0.2 ms | 18,034, 2.4 |
| springdale-horseshoe (extra) | EPT, AR_R6_WashingtonCO_2015 QL2, 16 nodes, 7.7 MB | lidar-pending at 1.63 s | 2.1 s | 1.8 s (re-read) | 0.1 ms | 21,239, 2.8 |

What this means for a person: a QL1 house searched cold is ready about 2 minutes later (tile downloads at 0.9-1.6 MB/s
over 8 connections, plus 8-28 s to decode 20-60 M points); an EPT house is ready in about 2 s, just past the Measure
budget; once ready, or once the area job has the tile, a Measure reads it in about a millisecond. The first Measure right
after a search is therefore usually Google-only ('lidar-pending'); the next is made with the lidar.

Failures met during these runs (each typed, none crashed, none kept): the TNM index timing out at 20 s once
('usgs:timeout'); rockyweb refusing this machine's connections for minutes, twice (with 16 connections after ~230 MB, with
8 after ~195 MB; other tracks on this machine were downloading too), which the 5 minute cooldown now turns into fast
'usgs:cooldown' answers instead of a stream of retries. The process-wide cooldown and one-download-at-a-time are why.

Cross-checks against the bench's own Python/laspy/pyproj crops (`roof-bench/lidar/<slug>/units/<unit>/points.npz`), same
50 m square: lr-305-ridgeway (LAZ tile) 74,934 points in both, z median 129.17 m in both, ground share 14.85% and
last-return share 58.32% in both, mean offset equal to 0.1 mm; fs-hendricks (EPT) 20,513 points in both, z median
185.31 m in both, mean offset equal to 0.1 mm.

## Sensitivity of the constants (+/-20%)

- `measureWaitMs` 1500: 1200-1800 changes no outcome above (tiles take 60-160 s cold, EPT 1.9-2.5 s, warm under 2 ms).
- `minLastPerM2` 1.0 (half the QL2 minimum): the houses measured have 17.6-18.3 (QL1) and 2.4-5.4 (QL2) last returns per
  m2; 0.8-1.2 changes nothing. QL3 (0.5/m2) is excluded by the unit choice anyway.
- Crop: 10 m cell, 40 m half-side, so at least 35 m round any point (the bench crops are 35 m). A half-side 20% smaller
  (32 m) would break that guarantee; 20% larger costs only bytes.
- `rangeParallel` 8 / `rangeBytes` 4 MB / timeouts / cooldown: operational, not accuracy; 16 connections triggered the
  server's refusal, 8 did not during these runs.

## Not done

- A worker thread (or process) for decoding: a 100 MB QL1 tile takes 8-15 s of CPU on the API process (cooperative,
  it yields every 100k points). The area job is the natural place to move it.
- Leaf-off is judged twice: the work unit's collect window picks the unit, and the house's own points (their median
  GPS day) must fall in November..April too, else 'leaf-on-only'. The Little Rock / Hot Springs houses were flown March
  22-26 2025 and pass; early leaf-out in late March is possible in Arkansas, and a stricter month rule is a constant away.
- A newer unit whose window is not all leaf-off (fs-hendricks, rogers-pecan: AR_Western_1/3_B24, March 2024 to March
  2025) is never read, even though this house may have been flown in winter: the 2015-2017 QL2 leaf-off unit is used.
  Reading the newer one to check its point days would cost a tile download per house.
- Turning `USGS_LIDAR_MODE=on`: needs the fusion/truth tracks' scoring (EagleView and cross-flight truth), a
  ROOF_3D_ALGORITHM_VERSION bump and the owner's decision.
- The Postgres suites (jobs.test.ts gained the new queue name only) were not run here: integrator and verifiers.
