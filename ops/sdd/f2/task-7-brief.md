### Task 7: API: search, map pins, map area

**Files:**
- Create: `apps/api/src/routes/search.ts`, `apps/api/src/routes/map.ts`, `packages/db/src/repos/map.ts`
- Modify: `packages/db/src/repos/search.ts` (add `searchAll`), `packages/db/src/index.ts`, `apps/api/src/app.ts` (mount `/api/search`, `/api/map`)
- Test: `apps/api/test/search.test.ts`, `apps/api/test/map.test.ts`

**Interfaces:**
- Search types:
```ts
export type SearchCustomer = { id: string; displayName: string; phone: string | null };            // primary phone, E.164
export type SearchJob = { id: string; stage: JobStage; stageLabel: string; customerId: string;
                          customerName: string; propertyId: string | null; addressLine: string | null };
export type SearchAddress = { id: string; addressLine: string; city: string | null; state: string | null;
                              zip: string | null; customerId: string; customerName: string };
export async function searchAll(tx: Tx, ctx: TenantContext, q: string, limit: number):
  Promise<{ customers: SearchCustomer[]; jobs: SearchJob[]; addresses: SearchAddress[] }>;
```
- **`GET /api/search?q=`** → `{ customers, jobs, addresses }`, each at most 8.
  - `q` is trimmed. Fewer than 2 characters returns three empty lists. More than 100 characters are cut to 100. `q` missing is treated as empty.
  - **Matching:**
    - customers: as `GET /api/customers?q=` (name, or phone digits when there are 3 or more digits)
    - addresses: properties that have a customer, matching address line, city or zip
    - jobs: jobs whose customer name or address line matches
  - **Ordering:** customers by `lower(display_name)`; addresses by `lower(address_line)`; jobs by `created_at desc`.
  - **Exclusions:** archived rows are left out, and the rep scope helpers apply to all three. Use `escapeLike` for every pattern.
- Map types:
```ts
export type GeoJsonMultiPolygon = { type: 'MultiPolygon'; coordinates: number[][][][] };
export type Bbox = { west: number; south: number; east: number; north: number };
export type CustomerPin = { propertyId: string; customerId: string; lng: number; lat: number; name: string; addressLine: string };
export type JobPin = { jobId: string; customerId: string; propertyId: string; stage: JobStage; stageLabel: string;
                       lng: number; lat: number; name: string; addressLine: string };
export type PinCluster = { layer: 'customers' | 'jobs'; lng: number; lat: number; count: number };
export type PinsResult = { mode: 'points'; customers: CustomerPin[]; jobs: JobPin[] }
                       | { mode: 'clusters'; clusters: PinCluster[]; total: number };
export const SERVER_CLUSTER_ABOVE = 2000;
export async function mapPins(tx: Tx, ctx: TenantContext, bbox: Bbox, layers: ReadonlySet<'customers'|'jobs'>): Promise<PinsResult>;
export async function mapArea(tx: Tx, ctx: TenantContext): Promise<{ serviceArea: GeoJsonMultiPolygon | null; bounds: [number, number, number, number] | null }>;
```
- **`GET /api/map/pins?bbox=w,s,e,n&layers=customers,jobs`**
  - **Validation:**
    - `bbox` must be 4 finite numbers with −180 ≤ w < e ≤ 180 and −90 ≤ s < n ≤ 90. Otherwise 400 with `field: 'bbox'` and "Please give the map area as west,south,east,north."
    - `layers` defaults to both; an unknown layer is a 400 with `field: 'layers'`.
    - The antimeridian is not supported.
  - **Points:**
    - Customer pins: non-archived properties with `geom` and a non-archived customer. The customer must be visible (`customerScope`) and the property visible (`propertyScope`). The point is the property's.
    - Job pins: non-archived jobs in stages `lead`, `inspection`, `proposal` or `won`, visible (`jobScope`), whose property has `geom`.
    - Both use `ST_Intersects(geom, ST_MakeEnvelope(w,s,e,n,4326))`.
  - **Clustering:** first count both layers. When customers + jobs > `SERVER_CLUSTER_ABOVE`, return clusters instead.
    - Group per layer by `ST_SnapToGrid(geom, cell)` with `cell = (east - west) / 48`.
    - The cluster point is `ST_Centroid(ST_Collect(geom))`.
- **`GET /api/map/area`**
  - `serviceArea`: the company's `service_area` as GeoJSON (`ST_AsGeoJSON`), or null.
  - `bounds`: `ST_Extent` of the service area, else the extent of the company's visible located properties, else null.
- **Roles:** any member may call these, with rep scoping.

- [ ] **Step 1: Write the failing tests** (`crm-helpers.ts` actors; create rows through the F1 API or the repos)

`search.test.ts`:
- `it('finds customers, jobs and addresses')`: customer "Maria Lopez" with a property "1200 Pine St" and a job → `q=lop` returns her in customers, the job in jobs (customerName "Maria Lopez"), and the address in addresses. `q=pine` finds the address and the job.
- `it('caps each list at 8')`: 10 matching customers → 8.
- `it('returns empty lists for a 1-character query')`.
- `it('survives LIKE characters, quotes and emoji')`: `q` in `['%', '_', "o'neil", '"', '🏠', 'x'.repeat(150)]` → 200, and `%` does not match everything.
- `it('scopes a rep to what they may see')`: rep sees the customer of their assigned job and not another rep's.
- `it('stays inside the company')`: company B's names never appear.

`map.test.ts`:
- `it('returns customer and open-job pins inside the box')`: properties at (−95.93, 41.25) and (−90, 30). The box `-96.2,41.1,-95.8,41.4` returns only the first. A job in stage `lost` gives no job pin; a `proposal` job does, with `stageLabel: 'Proposal'`.
- `it('clusters on the server above 2,000 points')`: insert 2,001 located properties with customers in one transaction via SQL `generate_series` → `mode: 'clusters'`, the sum of counts is 2,001, and `total: 2001`.
- `it('refuses a bad box')`: `bbox=1,2,3`, `bbox=10,0,5,1` and `bbox=a,b,c,d` → 400 with `field: 'bbox'`.
- `it('scopes a rep')`.
- `it('area: service area, else address extent, else null')`:
  - With no service area and no located addresses → `{ serviceArea: null, bounds: null }`.
  - Add a located property → bounds is the point's extent.
  - Set `service_area` with SQL `ST_Multi(ST_GeomFromText('POLYGON((...))', 4326))` → `serviceArea.type === 'MultiPolygon'` and the bounds equal the polygon's extent.

- [ ] **Step 2: Run them and see them fail**.
- [ ] **Step 3: Implement** (signatures above; raw `sql` from drizzle for the PostGIS parts).
- [ ] **Step 4: Run the tests, lint and typecheck**. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(api): search, map pins with server clustering, map area`

---

