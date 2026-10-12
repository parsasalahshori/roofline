### Task 8: Spotter reports and the map storm layer API

**Base:** `s1-storm` after Task 7 is merged. v1 reference (read-only): `v1/server/storms.ts` (SPC CSV header `Time,Size,Location,County,State,Lat,Lon,Comments`, size in hundredths or `UNK`). Real: `routes/map.ts` (F2 map routes), `@roofline/db/system` in `jobs/scheduler/**`.

Read first: `ops/sdd/s1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-storm-scout-design.md`. Names marked **[C1]** / **[E1]** come from the C1/E1 plans and briefs (`ops/sdd/c1/`, `ops/sdd/e1/`), not from built code: check each against `c1-crm`/`e1-estimator` before starting and report any difference.

**Split:** Builder 1 port v1's SPC parser to `storm/spotter.ts` + `system/spotter.ts` upsert; Builder 2 `repos/storm-layer.ts` (swaths and spots in a bbox, simplified per zoom); Builder 3 `GET /api/map/storm-layer` in `routes/storms.ts`, tests.

**Files:** Create/fill `apps/api/src/storm/spotter.ts`, `apps/api/src/jobs/scheduler/spotter-sync.ts`, `packages/db/src/system/spotter.ts`, `packages/db/src/repos/storm-layer.ts`, `apps/api/test/fixtures/spc-hail.csv` (from v1's tests or a recorded day); Modify `apps/api/src/routes/storms.ts`; Test `apps/api/test/{spotter,storm-layer}.test.ts`.

**Interfaces:**
```ts
export function parseSpcHailCsv(csv: string, reportDate: string): SpotterReport[];   // v1 rules: exact header, size hundredths or UNK (skipped), lat/lon numbers; HHMM → time
export async function syncSpotter(deps, now: Date): Promise<{ inserted: number }>;   // today's and yesterday's convective days (UTC yymmdd), timeout 10 s, 404 → 0
storm-layer repo: stormLayer(tx, { bbox: [w,s,e,n], days: number, zoom: number }) → { swaths: FeatureCollection /* per storm, per level, ST_SimplifyPreserveTopology by zoom */, spots: FeatureCollection, newestRunAt: Date | null }
GET /api/map/storm-layer?bbox=&zoom=&days=7  → 200 { swaths, spots, newestRunAt, stale: boolean }   // stale = newestRunAt older than HAIL_STALE_MINUTES
```

**Tests:**
- parser (header mismatch → [], UNK skipped, ≥ 1 row); sync upserts idempotently; layer returns only features in the bbox and of the last N days; `stale` flag; tenant isolation trivially holds (global) but the route requires a session.

**Carries and rulings:**
- Spotter data is global; `app_system` writes it from the scheduler.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): NOAA spotter reports and the storm map layer`
