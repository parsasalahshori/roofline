### Task 9: EagleView adapters (orders, reports, Property Data)

**Base:** `e1-estimator` after Task 5 is merged. From T5: `ExactReports`, `AerialMeasure`, `ExactPrice`, `ExactReport`, `ExactOrderUncertainError`, `ExactReportsUnavailableError`, `AerialUnavailableError`, stubs `providers/eagleview/{orders,property-data}.ts`. v1 reference (read-only): `v1/server/{providers,eagleview-sandbox,jobs}.ts` (`normalizeEagleView`, `evNumber`). No C1 dependency.

Read first: `ops/sdd/e1/global-constraints.md`; spec `docs/superpowers/specs/2026-10-12-roofline-estimator-design.md`. Names marked **[C1]** come from the C1 plan/briefs (`ops/sdd/c1/`), not from built code: check each against `c1-crm` before starting and report any difference.

**Split:** Builder 1 `eagleview/http.ts` (OAuth client credentials token cache, request, errors) and `eagleview/property-data.ts` (ported from `v1/server/eagleview-sandbox.ts`); Builder 2 `eagleview/orders.ts` and `eagleview/normalize.ts` (ported `normalizeEagleView`, `evNumber`); Builder 3 recorded fixtures and tests.

**Files:** Modify/Create `apps/api/src/providers/eagleview/{http,orders,property-data,normalize}.ts`; fixtures `apps/api/test/fixtures/eagleview/{token,price-order,place-order,get-report-pending,get-report-complete,get-report-failed,pd-request,pd-result-pending,pd-result-complete}.json`; Test `apps/api/test/eagleview.test.ts`.

**Interfaces:**
```ts
export class EagleViewHttp { constructor(o: { clientId: string; clientSecret: string; env: 'sandbox' | 'production'; fetch?: typeof fetch; now?: () => number }) }   // token from https://apicenter.eagleview.com/oauth2/v1/token (client_credentials), cached until expiry − 60 s, one in flight; 401 → refresh once
export class EagleViewOrders implements ExactReports { constructor(o: { http: EagleViewHttp; productId: number; deliveryId: number }) }
export class EagleViewPropertyData implements AerialMeasure { constructor(o: { http: EagleViewHttp }) }
export function eagleViewOrdersFor(config: Config): ExactReports | null;           // client id/secret set and EAGLEVIEW_PRODUCT_ID > 0
export function eagleViewPropertyDataFor(config: Config): AerialMeasure | null;     // client id/secret set
export function normalizeEagleView(raw: unknown): ExactReport;                      // ported; unit parsing via evNumber; ReportId → reportRef
```
- **Hosts:** orders and reports on `webservices-integrations.eagleview.com` (sandbox) / `webservices.eagleview.com` (production): `POST /v2/Order/PriceOrder`, `POST /v2/Order/PlaceOrder`, `GET /v3/Report/GetReport?reportId=`; Property Data on `sandbox.apis.eagleview.com` / `apis.eagleview.com`: `POST /property/v2/request`, `GET /property/v2/result/:id` (202 pending). **Confirm the production auth flavor for Measurement Orders during the partner onboarding** (v1 used a bearer token from the account integration); the adapter keeps auth in `EagleViewHttp` so only that class changes (Ruling 5).
- **Order payload** (v1's): `OrderReports[0]` with the address, `PrimaryProductId`, `DeliveryProductId`, `MeasurementInstructionType: 1` (include garage), `ChangesInLast4Years: false`, `ReferenceId`, `Comments: 'Roofline: US imperial roof measurements requested.'`.
- **Errors:** network/timeout/5xx/429 → `…UnavailableError` (no provider text); PlaceOrder without a confirmed `ReportIds[0]` → `ExactOrderUncertainError`; `GetReport` not complete → pending; status failed → `{ status: 'failed', reasonKey: 'provider_failed' }`; `normalizeEagleView` errors → failed with `reasonKey 'unsupported_units'`.

**Tests:**
- token caching (one token for three calls; refresh on 401); price mapping to cents and expiry 10 minutes; place-order success and an ambiguous response → uncertain; get-report pending/complete/failed; normalization of the fixture (area, pitch, ridge = ridge + hip, edge = eave + rake, valley, facets); Property Data pending/complete with the first structure; no secret or address in any error message.

**Carries and rulings:**
- **Ruling 5 (plan):** auth lives only in `EagleViewHttp`.

**Verify notes:**
- api/db suites need Docker (Testcontainers): locally `npm run typecheck && npm run lint`; prove the rest with `ops/bin/ci-check`.
- Commit: `feat(estimator): EagleView measurement orders and Property Data adapters`
