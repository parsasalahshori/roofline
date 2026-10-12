# S1 Task I4 report: phone routes against the real door API

## Built
- P1-my-routes: MyRoutes.tsx reads route.stops / route.doneStops (progress text, link label, ProgressBar); RouteMap.module.css .you uses var(--stage-lead); fixtures moved to the API shape (my-routes, route-api, s1-routes tests); new test for '3 of 12 doors'.
- P2-route-view: RouteView.tsx renders stop.address ?? doors.noAddress (current stop and list); hail line only when hailIn !== null; route-view.test.tsx fixtures in API shape plus null-address and hail-known tests.
- P3-outcome-errors: DoorOutcome.tsx uses DOOR_OUTCOMES from @roofline/shared and passes an ApiError to the sheet; WantsCheckSheet takes error: ApiError | null (duplicate phone, field lead.phoneE164, shows on the phone field; status 0 shows the not-saved/try-again text); door-outcome.test.tsx updated.
- Shared: types.ts and copy/doors.ts updated for the API shapes (stops/doneStops, nullable address/hailIn, doors.noAddress).

## Reviews
- Review 1: verify failed, 2 findings; contact check 1: F1 amended, F2 approved; both addressed.
- Review 2: verify passed, 0 findings.

## Minors
- A server phone error stays on the phone field until the next submit clears it; not covered by a test.

## Verify (slot-wrapped)
typecheck, lint, lint:css clean; vitest --project @roofline/web: 88 files, 830 tests passed.
