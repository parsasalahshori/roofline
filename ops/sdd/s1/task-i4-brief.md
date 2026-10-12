### Task I4: Phone routes against the real door API (from the contact-229 group check)

**Base:** branch `s1-i4` = s1-storm (with T15's door API) + T26 merged. Web only. The real API (T15, `packages/db/src/repos/door-routes.ts`, `apps/api/src/routes/door-routes.ts`, `storm/doors.ts`) is the contract; the web follows it.

**Fixes:**
1. **(critical) Route summary fields.**
   - T15's `DoorRouteRow` (from `GET /api/routes/mine` and `GET /api/routes/:id`) is `{ id, companyStormId, stormId, userId, name, status, stops, doneStops }`. T26's `RouteSummary` expects `stopCount`/`doneCount`.
   - In `features/storm/routes/types.ts`, match the API names and add the missing fields.
   - Update `MyRoutes.tsx` and the fixtures in `my-routes.test.tsx`, `door-outcome.test.tsx`, `route-view.test.tsx` and `route-api.test.tsx`.
   - Add a test that renders the progress text from an API-shaped fixture.
2. **(important) Null address and hail.**
   - `DoorStopRow.address` and `hailIn` are `string | null` / `number | null`; a footprint-only home has no saved address. Type them that way, along with the other fields the API sends (`routeId`, `footprintId`, `propertyId`, `outcomeAt`, `outcomeBy`, `createdCustomerId`, `createdJobId`).
   - Add copy in `copy/doors.ts` for a missing address (for example `noAddress: 'Home with no saved address'`). `RouteView` renders it when `address` is null and leaves out the hail line when `hailIn` is null. No letter literals in JSX.
   - Tests: a fixture with a null address and a null hail size.
3. **(important) Wants-a-check errors.** Pass the `ApiError` to `WantsCheckSheet`:
   - status 0 (network) → `doors.notSaved`;
   - any other status → `error.message`;
   - `field === 'lead.phoneE164'` → attach the message to the phone field.
   - Test: a 409 duplicate phone shows T15's message on the phone field, not "try again".
4. **(minor) Shared types.** Use `DoorOutcome`/`DoorRouteStatus`/`DOOR_OUTCOMES` from `@roofline/shared` instead of redeclaring the unions and the ordered list in `types.ts` and `DoorOutcome.tsx`.
5. **(minor) Colour token.** `RouteMap.module.css` has a raw `#1a73e8`. Use an existing token (the accent or link colour), or add a token in the shared token file if the design kit has none.

**Verify:** typecheck, lint, lint:css, `npx vitest run --project @roofline/web` (slot-wrapped); ci-check with `CI_JOBS="Platform E2E Hail"`.
**Commit:** `fix(web): phone routes read the real door API (stops/doneStops, null addresses, duplicate-phone errors)`
