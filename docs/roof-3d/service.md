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
  downloaded in 4 MB byte ranges, 16 at once (the rockyweb server gives about 0.3 MB/s per connection). The DERIVED
  product (dx, dy, z float32, flags, class, plus a JSON header with project, work unit, QL, flight dates, point GPS dates,
  density and the USGS credit, about 1-2 MB) goes in the object store under `lidar/v1/crop/<zone>/<e>_<n>.rlc`; never raw
  LAZ, never the database. 'no-coverage' / 'leaf-on-only' / 'too-sparse' answers are kept for 30 days; errors are not.
  One fetch per cell at a time; one derivation at a time.
- Measure (`usgs-lidar-roof.ts` + one hook in `roof-3d.ts`'s `attempt`): reads what is known; else joins or starts the
  fetch and waits at most `USGS_LIDAR_MEASURE_WAIT_MS` (1.5 s). Not ready: Measure proceeds with Google alone and the
  snapshot records `lidar: { status: 'none', reason: 'lidar-pending' }`. Such a snapshot is never shared from the roof
  cache nor reused from the measurement, so the next Measure is made with the lidar.
- Prefetch: the Measure search's prefetch (`prefetchMeasure`) also starts the lidar fetch. Area job:
  `UsgsLidarService.prefetchArea(sw, ne)` downloads every leaf-off tile of an area (sampled every 500 m, at most 25
  lookups and 16 tiles) into the tile cache, so houses there derive without a download.
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
- Entwine EPT first: the public EPT buckets cover older projects only (none of the 2023-2025 QL1 Arkansas flights in
  the bench). The API can probe for a unit's EPT (`eptOf`); reading EPT nodes is not wired yet (see "Not done").
- Reading only part of a LAZ tile: USGS chunks are in flight order, not spatial, so a house's points are spread over the
  whole file.

## Risks

- `USGS_LIDAR_MODE=on` changes reconstruction output (the lidar step moves hidden edges): turning it on must bump
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

## Not done

- EPT node reading (probe only). Older QL2 projects covered by EPT still read from their LAZ tiles.
- A pg-boss job wrapping `prefetchArea` (the method exists and is tested; nothing schedules it yet).
- A worker thread for decoding.
