### Task 7: Measurements API

**Base:** `e1-estimator` after Tasks 2, 5 and 6 are merged. From T2: `instantEstimate`, `outlineProblem`, `Ring`, `LngLat`. From T6: `footprintStateStatus` (system). Real (F1): `createProperty`, `getProperty` (`repos/properties.ts`), `propertyScope`, `jobScope`, `deps.geocoder`. **[C1]** C1 T7 geocodes inside `routes/properties.ts` (route code, not a reusable function) — Ruling EB: `measureProperty` calls `deps.geocoder.geocode` itself and then F1's `createProperty`, without editing C1's route. **[C1]** `company_settings` columns from T1 (`default_pitch_x12`, `overhang_ft`).

Read first: `ops/sdd/e1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-estimator-design.md`. Names marked **[C1]** come from the C1 plan/briefs (`ops/sdd/c1/`), not from built code: check each against `c1-crm` before starting and report any difference.

**Split:** Builder 1 `repos/measurements.ts` (create, get, update, `footprintsNear` tenant read, lock rule); Builder 2 `estimator/measure.ts` (geocode → footprints → estimate; draw mode; footprint queueing) and `routes/measurements.ts`; Builder 3 tests.

**Files:** Modify `packages/db/src/repos/measurements.ts`, `apps/api/src/estimator/measure.ts`, `apps/api/src/routes/measurements.ts`; Test `apps/api/test/measurements.test.ts`.

**Interfaces:**
```ts
// repos/measurements.ts
export async function footprintsNear(tx: Tx, point: LngLat, radiusM: number): Promise<{ id: string; ring: Ring; areaSqFt: number; contains: boolean; distanceM: number }[]>;
export async function createMeasurement(tx: Tx, ctx: TenantContext, m: NewMeasurement, now: Date): Promise<MeasurementView>;
export async function getMeasurement(tx: Tx, ctx: TenantContext, id: string): Promise<MeasurementView | null>;
export async function updateMeasurement(tx: Tx, ctx: TenantContext, id: string, p: MeasurementPatch, now: Date): Promise<MeasurementView | 'locked' | null>;
export async function setPropertyFootprint(tx: Tx, ctx: TenantContext, propertyId: string, footprintId: string): Promise<void>;
// estimator/measure.ts
export async function measureProperty(deps: AppDeps, ctx: TenantContext, i: { propertyId?: string; address?: string; jobId?: string | null }): Promise<MeasurementView>;
```
- **`measureProperty`:** resolve or create the home (address → C1's server geocoding path); state not `ready` → queue `footprints-load` (singleton) and return a draw-mode measurement (`outline: null`, `drawMode: true`, estimate zeros); else `footprintsNear(point, 40)`: the containing one (or nearest ≤ 30 m) is the main structure (included), others listed excluded; compute `instantEstimate` with the company's `default_pitch_x12` and `overhang_ft`; set the property's `footprint_id` (Decision 9); `method 'outline'`, `kind 'estimate'`.
- **Routes (spec §7):** `POST /api/measurements` (201), `GET /:id`, `PATCH /:id` (outline via `outlineProblem` → 400 field `outline` with "Corners must form a closed shape without crossing lines." / "That outline is too large for a house." / "Add at least three corners."; pitch 0–24; overhang 0–3; valley ≥ 0; included structures by id), lock → 409 per spec. Rep visibility through the property/job scope.

**Tests:**
- a showcase home inside a fixture footprint → estimate equals `instantEstimate` on that ring; nearest within 30 m; none → draw mode; state not loaded → draw mode + one `footprints-load` in `t.jobs.sent`; PATCH outline/pitch recomputes; invalid outlines' messages; locked after a sent proposal (seed status sent) → 409; rep scope; company B 404.

**Carries and rulings:**
- **Ruling EB** (see Base).
- Rep visibility through `propertyScope`/`jobScope`.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(estimator): instant roof measurements from building outlines`
