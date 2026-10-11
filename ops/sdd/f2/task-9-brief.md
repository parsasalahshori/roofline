### Task 9: Showcase data, dev seed, richer demo plan, reusable test database

**Files:**
- Create: `apps/api/src/scripts/showcase.ts`, `apps/api/src/scripts/seed-dev.ts`, `packages/db/src/testing/database.ts`
- Modify:
  - `packages/shared/src/steps.ts` (optional demo payload fields)
  - `apps/api/src/tasks/demo.ts` (`demoTask(now, companyName?)`)
  - `packages/db/src/testing/seed.ts` (extract `seedCompany`)
  - `packages/db/src/testing/global-setup.ts` (use `startTestDatabase`)
  - `packages/db/src/testing/index.ts`, `packages/db/src/repos/companies.ts` (add `setServiceArea`), `apps/api/src/index.ts` (export `seedShowcase` and `seedDemoTask`), `apps/api/package.json` (script `seed:dev`), README
- Test: `apps/api/test/showcase.test.ts`, `apps/api/test/seed-demo.test.ts` (update), `packages/shared/test/steps.test.ts` (extend)

**Interfaces:**
- **Demo step payloads** (shared):
  - `demo_message` accepts optional `sample?: string` (≤ 640 characters), `recipientCount?: int ≥ 0` and `sendTime?: string` (≤ 60). Its preview copies them into `messageSample`, `recipientCount` and `sendTime`.
  - `demo_spend` accepts optional `area?: string` (≤ 120). Its preview appends `area` to `lines` after the spend line.
  - **All existing payloads stay valid.**
- **`demoTask(now: Date, companyName = 'your roofer'): NewTask`:** the same three steps and titles as now, plus:
  - the message step: `sample: \`Hi Maria, it's ${companyName}. Tuesday's hail hit your street. Want a free roof check this week? Reply YES to book. Reply STOP to opt out.\``, `recipientCount: 31`, `sendTime: 'Today 10:00 AM'`
  - the spend step: `area: 'North side swath · 4.2 sq mi'`
- **`setServiceArea(tx: Tx, geojson: GeoJsonMultiPolygon | null): Promise<void>`:** app_tenant already has `UPDATE (service_area)`. Uses `ST_Multi(ST_GeomFromGeoJSON($1))`.
- **`seedShowcase(pools: Pools, companyId: string, now: Date, opts?: { companyName?: string }): Promise<{ customers: number; properties: number; jobs: number; taskId: string }>`** runs in one `withTenant` with `systemContext(companyId)`:
  - **Service area:** the polygon `[[-96.20,41.17],[-95.90,41.17],[-95.90,41.37],[-96.20,41.37],[-96.20,41.17]]` (Omaha).
  - **Customers and properties:** 60 customers, with names from fixed first/last lists and a seeded PRNG (mulberry32, seed 42). Each customer has a property inside the polygon (`lat`/`lng` rounded to 5 decimals); 10 customers have a second one, so 70 properties in all. Consent `none`, `source: 'manual'`.
  - **Jobs:** 28 jobs on distinct properties: lead 8, inspection 7, proposal 6, won 4, installed 2, lost 1. The leads are unassigned; the rest are assigned to the company's first rep when there is one.
  - **The plan:** `createTask(demoTask(now, companyName))`. Returns the counts and `taskId`.
  - **Same output every run:** two runs on fresh databases give identical names and coordinates.
- **`seedCompany(ownerUrl: string, spec: { name: string; slug: string; timezone?: string; state?: string; users: { email: string; name: string; role: Role; canApproveSpend?: boolean }[]; password: string }): Promise<SeededCompany>`.** `seedTwoCompanies` becomes two calls to it, with identical output to today.
- **`startTestDatabase(): Promise<{ urls: { owner: string; tenant: string; system: string }; stop(): Promise<void> }>`:** the body of the current global setup. The global setup calls it and `provide`s the URLs.
- **`npm run seed:dev -w @roofline/api`** (`seed-dev.ts`):
  - Refuses unless `NODE_ENV=development`.
  - Needs `DATABASE_URL_OWNER`, `DATABASE_URL_TENANT` and `DATABASE_URL_SYSTEM`.
  - When no company has the slug `summit-roofing`, it creates "Summit Roofing" (`America/Chicago`, NE) with these users, all with password `roofline-demo-2026`:
    - `owner@summit.test` (Dana Park, owner)
    - `office@summit.test` (Chris Lane, office, no spend delegation)
    - `rep@summit.test` (Robin Hale, rep)
  - Then runs `seedShowcase`.
  - Prints the sign-in emails, never the password. The README's local-run section names the password, as dev-only test credentials.

- [ ] **Step 1: Write the failing tests**
  - `steps.test.ts`: a `demo_message` with `sample`, `recipientCount` and `sendTime` previews them; a bare `{label}` is still valid; a 641-character `sample` → an error.
  - `showcase.test.ts`:
    - `it('seeds a believable company')` → `{customers:60, properties:70, jobs:28}`. `GET /api/map/area` gives a MultiPolygon, and its bounds equal the polygon. `GET /api/map/pins` over the bounds → 70 customer pins and 25 job pins (lead + inspection + proposal + won). `GET /api/approvals` → `count:1`, with the message step's `preview.recipientCount === 31`.
    - `it('is the same every run')`: reset, seed twice in a row, and compare the sorted names and coordinates.
  - `seed-demo.test.ts`: update the payload expectations.
- [ ] **Step 2: Run them and see them fail**.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run the full suite and lint**. Expected: PASS, with the F1 tests unchanged.
- [ ] **Step 5: Commit** — `feat: showcase data, dev seed and a richer demo plan`

---

