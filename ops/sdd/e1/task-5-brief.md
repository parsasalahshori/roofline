### Task 5: API skeleton: seams, fakes, config, jobs, schedules, mounts

**Base:** `e1-estimator` after Tasks 1 and 4 are merged. Real (F3): `config.ts`, `deps.ts` (`AppDeps`, `buildDeps`), `providers/geocoder.ts` factory pattern, `jobs/queue.ts` (`JOB_NAMES`, `JobData`), `jobs/worker.ts` (`SCHEDULES`), `tasks/handlers.ts` (`builtInHandlers`, and `registerStepHandler` in `tasks/runner.ts`), `auth/middleware.ts` (`isPublicRoute(method, path)`, private), `billing/read-only.ts` (`readOnlyGuard`), `rate-limit.ts` (pattern: `loginRateLimit()` etc.), `public/policies.ts`. **[C1]** C1 T5 already appended `calendar-push`/`calendar-pull` and `JobData.appointmentId` and owns the C1 mounts — append after them.

Read first: `ops/sdd/e1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-estimator-design.md`. Names marked **[C1]** come from the C1 plan/briefs (`ops/sdd/c1/`), not from built code: check each against `c1-crm` before starting and report any difference.

**Split:** Builder 1 config, deps, test helpers, env docs; Builder 2 the four seams and fakes + `estimator-fakes.test.ts`; Builder 3 job names, schedules, step handler registration (stubs), route stubs and mounts, public prefix in `middleware.ts`.

**Files:**
- Create: `apps/api/src/providers/{footprints,aerial,exact-reports,object-store}.ts`, `apps/api/src/providers/fakes/{footprints,aerial,exact-reports,object-store}.ts`, stubs `apps/api/src/providers/ms-footprints.ts` (`msFootprintsFor(config): FootprintSource | null`), `apps/api/src/providers/eagleview/{orders,property-data}.ts` (`eagleViewOrdersFor`, `eagleViewPropertyDataFor` → null), `apps/api/src/providers/r2.ts` (`r2For` → null), `apps/api/src/estimator/{measure,build,reprice,exact-report,send-proposal,signed-pdf}.ts` (stubs), `apps/api/src/routes/{measurements,tier-templates,estimator-settings,proposals}.ts`, `apps/api/src/public/{proposals,proposal-sign}.ts`, `apps/api/src/jobs/scheduler/{footprints-ensure,exact-report-poll}.ts`, `apps/api/test/estimator-fakes.test.ts`
- Modify: `apps/api/src/{config,deps,app,index}.ts`, `apps/api/src/auth/middleware.ts` (public prefix), `apps/api/src/jobs/{queue,handlers,worker}.ts`, `apps/api/src/tasks/handlers.ts` (register `send_proposal`, `order_exact_report` stubs that throw "not yet"), `apps/api/test/helpers.ts`, `.env.example`, `README.md` env table

**Interfaces:**
```ts
// providers/footprints.ts
export type FootprintFeature = { sourceRef: string; ring: Ring };
export interface FootprintSource { readonly configured: boolean; stateFileUrl(state: string): string; features(state: string): AsyncIterable<FootprintFeature> }
export function createFootprintSource(config: Config): FootprintSource;    // FAKE → FakeFootprintSource (a fixture set around the Omaha showcase); else msFootprintsFor ?? unconfigured
// providers/aerial.ts
export type AerialRoof = { areaSqFt: number; pitchX12: number; structureIndex: number };
export interface AerialMeasure { readonly configured: boolean; start(address: string): Promise<{ requestId: string }>; result(requestId: string): Promise<{ status: 'pending' } | { status: 'complete'; roofs: AerialRoof[] }> }
export class AerialUnavailableError extends Error {}
// providers/exact-reports.ts
export type ExactPrice = { minCents: number; maxCents: number; expiresAt: Date };
export type ExactReport = { surfaceSqFt: number; pitchX12: number; ridgeFt: number; edgeFt: number; valleyFt: number; facets: number | null; reportRef: string };
export interface ExactReports { readonly configured: boolean;
  price(i: { address: { street: string; city: string; state: string; zip: string }; productId: number; referenceId: string }): Promise<ExactPrice>;
  order(i: { address: …; productId: number; referenceId: string }): Promise<{ reportId: string }>;     // may throw ExactOrderUncertainError
  report(reportId: string): Promise<{ status: 'pending' } | { status: 'complete'; report: ExactReport; costCents: number } | { status: 'failed'; reasonKey: string }> }
export class ExactReportsUnavailableError extends Error {} ; export class ExactOrderUncertainError extends Error {}
// providers/object-store.ts
export interface ObjectStore { readonly configured: boolean; put(key: string, bytes: Uint8Array, contentType: string): Promise<void>; get(key: string): Promise<Uint8Array | null> }
export function createObjectStore(config: Config, pools: Pools): ObjectStore;   // R2 when configured; else outside production an in-memory store (tests) — spec's "in-database fake" is simplified to memory for dev/test (Ruling 6)
```
- **Fakes:** `FakeFootprintSource` (rings from `apps/api/test/fixtures/footprints-ne.json` for state `NE`; any other state → empty iterable); `FakeAerialMeasure` (`start` → `req-<n>`; `result` pending once then complete with `{ areaSqFt: 2,480, pitchX12: 7 }`; `/outage/i` address → throws); `FakeExactReports` (price `{4200, 6200}` expiring in 10 min; `order` → `rep-<n>`; `orderUncertainNext()`; `report` pending until `complete(reportId)` is called, with a fixed report `{ surfaceSqFt: 2,612, pitchX12: 7, ridgeFt: 62, edgeFt: 188, valleyFt: 24, facets: 9 }` and cost 4,500); `MemoryObjectStore`. Each records `calls` and has `failNext(n)`.
- **Config:** `EAGLEVIEW_CLIENT_ID`, `EAGLEVIEW_CLIENT_SECRET` (both or neither), `EAGLEVIEW_ENV` (`sandbox|production`, default sandbox), `EAGLEVIEW_PRODUCT_ID` (integer; default the Premium Residential id from the partner onboarding — placeholder `0` until known, meaning "ask before ordering"), `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (all or none; **required in production** once any company can sign — a startup warning, not a failure, in E1), `PROPOSAL_LINK_BASE_URL` (http(s) URL, default `APP_ORIGIN`), `FOOTPRINTS_BASE_URL` (default Microsoft's `https://usbuildingdata.blob.core.windows.net/usbuildings-v2/`).
- **`AppDeps` gains** `footprints`, `aerial`, `exactReports`, `objectStore`; `TestApp` gains the four fakes.
- **Jobs:** `JOB_NAMES` gains `'footprints-load'` (data `{ state }`, singletonKey = state; data shape: `JobData` gains `state?: string`, `proposalId?: string`), `'signed-pdf'` (`{ companyId, proposalId }`).
- **Schedules:** `footprints-ensure` `*/15 * * * *` (queues loads for states that companies need), `exact-report-poll` `*/10 * * * *`.
- **Public prefix:** `isPublicRoute` also accepts any path starting with `/public/` (relative to `/api`) for every method; `readOnlyGuard` (F3) exempts `/public/`.
- **Mounts:** `/api/measurements`, `/api/tier-templates`, `/api/estimator/settings`, `/api/proposals`, `/api/public/proposals` (public router: `publicProposalRoutes` + `proposalSignRoutes`), with an IP rate limiter `publicRateLimit()` (60/min/IP) on `/api/public`.

**Tests:**
- config pairs; fakes' documented behaviour; `/api/public/proposals/x` reachable without a session (404 from the stub, not 401); `SCHEDULES` gains the two names; `JOB_NAMES` gains the two; read-only mode doesn't block `/api/public/…` POSTs.

**Carries and rulings:**
- This task owns `app.ts`, `config.ts`, `deps.ts`, `jobs/*`, `tasks/handlers.ts` registrations, `auth/middleware.ts` (public prefix), `test/helpers.ts` and env docs for E1 (plan Ruling 2).
- `isPublicRoute` is a private function in `auth/middleware.ts`; extend it there. `readOnlyGuard` must let `/api/public/` POSTs through (plan Ruling 7).

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(api): E1 skeleton — measurement, aerial, exact-report and storage seams with fakes; public proposal routes`
