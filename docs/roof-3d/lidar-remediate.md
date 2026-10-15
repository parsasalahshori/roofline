# Lidar round: remediation (review and verification findings)

Thursday Oct 15 2026, branch `lidar/merge` on top of 596ca8ab. Fixes for the reviewer's three blocking P1s, the
verifier's two P1s and the cheap P2s. Lidar fusion stays **OFF by default** (`USGS_LIDAR_MODE=off`); every change below
is either on the lidar-on path or in the roof view, and the default reconstruction is byte-identical to 596ca8ab
(output hashes equal on all 84 benchmark houses at 0.1 m and 0.25 m), so `ROOF_3D_ALGORITHM_VERSION` stays 6.

## Problems and fixes

| finding | root cause | fix | regression test (fails on 596ca8ab) |
|---|---|---|---|
| P1 duplex: the unit next door under one crown is added in full, flagged only 'check' | `reconstructRoof`'s joined-buildings test skips every lidar pixel, and `roof-from-lidar` was a 'check' | lidar roof past Google's building box by more than `JOINED_SHARE` (the terrace test's own 15 %) raises `lidar-past-building` (a 'block'); `roof-from-lidar` is a 'block' like `roof-inferred` | shared `roof-reconstruct-lidar-fusion.test.ts` 'an attached unit next door ... (a duplex)' |
| P1 provenance invisible | edge evidence read the FUSED heights (lidar ground), so lidar edges came out 'strong' with Google's 0.87; the web never read `source` | edge support and confidence always from Google's heights and crowns; web draws lidar edges in their own colour whatever their support, shades faces by `lidarShare`, states the added plan area on the card; credit text fixed | web `lift-roof.test.tsx` 'lidar provenance reaches the roof view'; API `confidence.test.ts` 'lidar provenance reaches the stored edges'; shared duplex test asserts a face with source 'lidar' |
| P1 tiles re-downloaded forever | deterministic LAS failures were never kept; the area job downloaded without a tile dir | 'not-las', 'unsupported-format', 'no-crs', 'not-utm', 'too-large' kept as new none reason `unreadable` (noneTtlMs); a 'decode' failure drops the cached tile and is not kept; area job skipped (`skipped: 'no-tile-dir'`) without a tile dir | `usgs-lidar-service.test.ts` three new cases |
| P1 (verifier) DEMO_MODE builds the fake USGS | `createUsgsLidarApi` had no DEMO_MODE exception (solar-layers has one) | DEMO_MODE with a lidar mode set builds `RealUsgsLidarApi` | `usgs-lidar-service.test.ts` 'createUsgsLidarApi' |
| P1 (verifier) same address prices up to 79 % apart cold vs warm | first Measure is Google-only while lidar downloads | with mode on, a roof made while lidar is pending carries `lidar-pending` (a 'block'); `lidarNowReady` also settles on a kept none, so an uncovered address loses the block | `roof-3d-lidar.test.ts` pending cases |
| P2 kill switch | fused snapshots reused after the mode is turned off | a kept snapshot with `lidar.status === 'used'` is not reused unless the mode is 'on' | `roof-3d-lidar.test.ts` 'the kill switch reaches kept roofs' |
| P2 integrity | ranged reads accepted any 200 of the right length; HEAD accepted an HTML page | ranged reads need 206 and a matching Content-Range; text/* is not a size | new `usgs-lidar-real-http.test.ts` (mocked fetch) |
| P2 prefetch latency | prefetch-mode Measure waited 1.5 s and started downloads | prefetch mode reads only `known()` | `roof-3d-lidar.test.ts` 'prefetch' case rewritten |

## Alternatives rejected

- **Lower `maxAddShare` (the reviewer's other suggestion).** The duplex adds 0.98 of Google's part; real wings add up
  to 0.48 on the bench (305 Ridgeway, lr-tyler) but about 0.8 live at nlr-park-hill (verifier's run, a house the
  lidar truth says is 46 % short). No single share separates a twin unit from a real wing, so a cap would refuse
  correct roofs and still pass a smaller neighbour unit. A block review, not a cap, is the safe answer until free
  parcel or footprint evidence is wired in.
- **Bound each lidar part by the county parcel or a Microsoft/Overture footprint.** The right fix, but it needs those
  layers at Measure time for every county (only PAgis and bench copies exist today). Listed as next work.
- **Keep the fused heights for edge evidence but drop the confidence.** The confidence is calibrated on Google's eave
  drops; a lidar-ground drop is a different sensor. Judging on Google's heights keeps the calibration meaningful
  and brings back the honest 'unverified' cue; `source: 'lidar'` tells the view which sensor placed the edge.
- **Change `openM` (thin spurs).** DEV sensitivity of the fusion eval: 0.4 (current) / 0.6 / 0.75 m. 0.75 helps 305
  Ridgeway (county IoU 0.822 -> 0.845) but drops hs-summer and shrinks other additions; 305 is a DEV house the
  window was already chosen on, so this would be in-sample tuning. Not changed; listed.

## Risks

- `lidar-past-building` also fires on real wings past Google's box (305 Ridgeway's east wing): it is a review, not a
  refusal, so the cost is a person's look before pricing. With fusion on, every fused roof over the inferred
  threshold is a block anyway.
- With mode on, `lidar-pending` blocks quotes for minutes (5-30 min measured live) in covered areas. That is the point
  (the price would change), but it makes `on` usable only with prefetch from the search or an area job.
- Edges placed by lidar are now dashed amber + lidar colour where Google cannot see them: more visible cues on fused
  roofs, and `edges-unverified` returns on those roofs.

## Rollback

`USGS_LIDAR_MODE=off` (default) removes every lidar effect, including kept fused roofs (made again on next read). The
web layers draw nothing for roofs without lidar provenance. Each fix is its own commit on `lidar/merge`.
