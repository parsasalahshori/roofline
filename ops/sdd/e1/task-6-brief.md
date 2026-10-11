### Task 6: Footprints: loader job and lookup

**Base:** `e1-estimator` after Task 5 is merged. From T5: `FootprintSource`, `FootprintFeature`, stub `providers/ms-footprints.ts`, `JOB_NAMES` `footprints-load`, schedule `footprints-ensure`. From T1: `building_footprints`, `building_footprint_states`, `system/footprints.ts` placeholder. Real: `companies.address_state` (F1 global table; `app_system` reads it).

Read first: `ops/sdd/e1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-estimator-design.md`. Names marked **[C1]** come from the C1 plan/briefs (`ops/sdd/c1/`), not from built code: check each against `c1-crm` before starting and report any difference.

**Split:** Builder 1 `providers/ms-footprints.ts` (download + streaming parse); Builder 2 `system/footprints.ts` (batch insert, state status, `footprintsNear`) and the two job/schedule handlers; Builder 3 fixtures and tests.

**Files:** Modify `apps/api/src/providers/ms-footprints.ts`, `packages/db/src/system/footprints.ts`, `apps/api/src/jobs/scheduler/footprints-ensure.ts`, `apps/api/src/jobs/handlers.ts` (`footprints-load` → `loadFootprintState`), create `apps/api/src/estimator/footprints-load.ts`; Test `apps/api/test/footprints.test.ts`, fixtures `apps/api/test/fixtures/footprints/NE.geojson.zip` (≤ 200 buildings, made by a script in the test folder from the Omaha showcase area).

**Interfaces:**
```ts
// providers/ms-footprints.ts
export class MicrosoftFootprints implements FootprintSource { constructor(o: { baseUrl: string; fetch?: typeof fetch }) }
// stateFileUrl('NE') → `${baseUrl}Nebraska.geojson.zip` (full state names map; DC → 'DistrictofColumbia'); features() streams: fetch → yauzl (from a temp file under os.tmpdir, deleted after) → stream-json pick 'features' → each Polygon's outer ring
// system/footprints.ts
export async function footprintStateStatus(system: Db, state: string): Promise<FootprintStateStatus | null>;
export async function claimFootprintState(system: Db, state: string, sourceUrl: string, now: Date): Promise<boolean>;   // insert or move failed→loading; false when loading/ready
export async function insertFootprints(system: Db, state: string, batch: readonly FootprintFeature[]): Promise<number>;   // multi-row insert, ST_MakeValid, area in sq ft via geography
export async function finishFootprintState(system: Db, state: string, buildings: number, now: Date): Promise<void>;
export async function failFootprintState(system: Db, state: string, errorPlain: string, now: Date): Promise<void>;   // deletes the partial rows for the state
export async function statesNeedingFootprints(system: Db): Promise<string[]>;   // distinct companies.address_state and properties' states (via app_system grants on companies) not ready/loading
// repos (tenant read) — in repos/measurements.ts (Task 7 owns the file; this task exports from system only)
// estimator/footprints-load.ts
export async function loadFootprintState(deps: AppDeps, state: string, meta: JobMeta): Promise<void>;   // claim → stream → insert batches of 2,000 → finish; throw → fail on lastAttempt
```
- **Decision note:** properties' states are tenant data; `statesNeedingFootprints` reads `companies.address_state` only (global table) plus a per-company "measured state" queue: Task 7 enqueues `footprints-load` directly when a measurement finds its state not ready (Ruling 3).

**Tests:**
- the fixture zip loads (count, areas positive, state ready); a second claim while loading is refused; a failing stream marks failed and leaves no rows; `statesNeedingFootprints` after a company in NE signs up; the schedule queues one job per state (singleton).

**Carries and rulings:**
- Provider text (Microsoft download errors) is never stored; `error_plain` is our own words.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(estimator): load building footprints by state from Microsoft's open data`
