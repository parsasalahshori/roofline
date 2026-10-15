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
