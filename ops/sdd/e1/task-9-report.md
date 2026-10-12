# Task 9: EagleView adapters (orders, reports, Property Data)

Branch e1-t9, commit e1a52a3 (base fcaced6).

## Built
- P1-http-propertydata: providers/eagleview/http.ts (EagleViewHttp: token, fixed error kinds, no provider text; 204 maps to not_found with status 204), providers/eagleview/property-data.ts.
- P2-orders-normalize: providers/eagleview/orders.ts (ExactReports; PlaceOrder 204 and any ambiguous result throw ExactOrderUncertainError; 401/403/404/422 are a clear refusal), providers/eagleview/normalize.ts.
- P3-fixtures-tests: apps/api/test/eagleview.test.ts (41 tests, stubbed fetch) and fixtures in apps/api/test/fixtures/eagleview/.

## Reviews
- Review 1: verify passed, 1 finding (F1), contact check outcome: amend (amended).
- Review 2: verify passed, 0 findings.

## Minors / open items
- Onboarding comment on the production Measurement Orders auth flavor in http.ts was asked for by the brief; builder 1 did not add it. Still open.
- Non-'Complete' 200 on Property Data still maps structures (literal brief rule).
- Unparseable report cost becomes costCents 0 (silent); decide whether it should fail instead.
- Order payload shape follows v1 wire format; DELIVERY_PRODUCT_ID 8 and MeasurementInstructionType 1 to confirm at onboarding. Fixtures are best-effort from v1.
- Test run locally used a config without the DB globalSetup (no Docker); a few test lines exceed 120 chars but lint passes.

## Verify
- npm run typecheck: pass. npm run lint: pass.
- ci-check: PASSED, run 38200640806 (Platform job passed) for e1-t9@e1a52a3.
