# Task 7 report: API: search, map pins, map area

Status: DONE_WITH_CONCERNS (the new code and a 16-file neighbouring subset are green; the whole api + db suite could not be run to completion because the machine was saturated, see "Verification gap").

Worktree `/Users/parsasalahshori-a/RooflineWork/wt/t7`, branch `f2-t7`.
Commit: `c2173ff feat(api): search, map pins with server clustering, map area`

## What was implemented

- `packages/db/src/repos/search.ts`: `searchAll(tx, ctx, q, limit)` and the types `SearchCustomer`, `SearchJob`, `SearchAddress`.
  - customers: same match as `listCustomers` (name, or phone digits when 3 or more), `customerScope`, not archived, ordered by `lower(display_name)`. `phone` is the primary number's E.164, else the first, else null.
  - addresses: properties joined to a non-archived customer, `propertyScope` and `customerScope`, matched on address line, city or ZIP, ordered by `lower(address_line)`.
  - jobs: non-archived, `jobScope`, matched on the customer's name or the job address's line, newest first. `stageLabel` from `JOB_STAGE_LABELS`.
  - every pattern goes through `escapeLike`.
- `packages/db/src/repos/map.ts` (new): `mapPins`, `mapArea`, `SERVER_CLUSTER_ABOVE = 2000`, and the types `GeoJsonMultiPolygon`, `Bbox`, `CustomerPin`, `JobPin`, `PinCluster`, `PinLayer`, `PinsResult`.
  - the pin rules are written once (`customerPinWhere`, `jobPinWhere`) and used by the count, the points and the clusters, so they cannot disagree.
  - customer pins: non-archived property with a located point, non-archived customer, `customerScope` + `propertyScope`, `ST_Intersects(geom, ST_MakeEnvelope(...))`.
  - job pins: non-archived job in `lead|inspection|proposal|won`, `jobScope`, property located and inside the box.
  - both layers are counted first; above 2,000 in all, each layer is grouped by `ST_SnapToGrid(geom, (east - west) / 48)`, with `ST_Centroid(ST_Collect(geom))` as the cluster point; `total` is the pin count. Clusters are sorted by lng then lat so the answer is stable.
  - `mapArea`: `ST_AsGeoJSON(service_area)` + its extent; else the extent (`ST_Extent`) of non-archived, located properties the member may see (`propertyScope`); else `{ serviceArea: null, bounds: null }`. Bounds are `[west, south, east, north]`.
- `apps/api/src/routes/search.ts`: `GET /api/search`. `q` missing or under 2 characters (counted as characters a person sees, after trim) answers three empty lists with no query; over 100 is cut to 100 (by code point, so an emoji is never split); NUL characters are dropped (Postgres cannot store them in text); a repeated `q` is a 400 on `q`.
- `apps/api/src/routes/map.ts`: `GET /api/map/pins` and `GET /api/map/area`.
  - bbox: exactly 4 plain decimal numbers (no exponent, `Infinity`, `NaN` or blank part), −180 ≤ w < e ≤ 180, −90 ≤ s < n ≤ 90; any problem (also missing or repeated) is 400 `field: 'bbox'`, "Please give the map area as west,south,east,north."
  - layers: default both; comma list, parts trimmed, case-sensitive; unknown or empty is 400 `field: 'layers'`, "Please pick customers, jobs or both." The bbox is checked first.
- `apps/api/src/app.ts` mounts `/api/search` and `/api/map`; `packages/db/src/index.ts` exports the new functions and types (so Task 9 can import `GeoJsonMultiPolygon` from `@roofline/db`).

## Files changed

- Created: `apps/api/src/routes/search.ts`, `apps/api/src/routes/map.ts`, `packages/db/src/repos/map.ts`, `apps/api/test/search.test.ts`, `apps/api/test/map.test.ts`
- Modified: `packages/db/src/repos/search.ts`, `packages/db/src/index.ts`, `apps/api/src/app.ts`

## Tests (58 new)

`search.test.ts` (21 cases, `test.each` expanded) and `map.test.ts` (37 cases, `test.each` expanded). Beyond the brief's list:
- search: city/ZIP/phone-digit matching, primary-phone choice, newest-first jobs, short/blank queries, repeated `q`, trimming, 100-character cut, NUL character, archived customers/jobs and customer-less addresses left out, a rep's own customer and an unassigned lead, owner/office see all, 401 when signed out, company B isolation both ways.
- map: several addresses per customer, the four open stages and their labels, archived/unlocated/customer-less rows left out, `layers`, a point exactly on the edge, 17 bad-bbox variants, missing/repeated bbox, bad layers, bbox-before-layers, exactly 2,000 points stays `points` and 2,001 turns into clusters, per-layer clusters (customers 2001 + jobs 3 = total 2004), rep counted on what they can see (company has 2,002 pins, the rep gets `points` with 1), company isolation (including a 2,001-point company B not tipping A into clusters), area with empty / unlocated / one / several addresses / service area / cleared, archived addresses ignored, rep gets only the extent of addresses they may see but the company's service area, company B's service area never leaks.

Ambiguity in the brief: it says `q=lop` returns "the address in addresses". Under the stated matching rules (address line, city or ZIP) "lop" cannot match "1200 Pine St", so my test asserts `addresses: []` for `lop` and the address for `pine`. Say so if you meant the address to match through the customer's name.

### TDD evidence

RED (tests written first, no implementation):
```
npx vitest run --project @roofline/api apps/api/test/search.test.ts apps/api/test/map.test.ts
 Test Files  2 failed (2)
      Tests  55 failed | 3 passed (58)
```
(The 3 that passed were the three "needs a signed-in member" 401 cases, which the sign-in gate answers before any route. The others failed with e.g. `expected 404 to be 200` / `Cannot read properties of undefined (reading 'map')`.)

GREEN (after implementing):
```
npx vitest run --project @roofline/api apps/api/test/search.test.ts apps/api/test/map.test.ts
 Test Files  2 passed (2)
      Tests  58 passed (58)
```

Lint and typecheck: `npm run lint` and `npm run typecheck` (tsc -b) both clean from the worktree root.

Mutation check (scratchpad script, always restored by a trap; the committed files are the unmutated ones): with `customerScope`/`propertyScope`/`jobScope` removed from `searchAll`, `mapPins` and the `mapArea` fallback, exactly the four rep tests fail (`search: scopes a rep`, `map: scopes a rep`, `map: a rep is counted on what they can see`, `area: a rep gets...`), so the rep tests do bite.

## Verification gap

The brief asks for `npx vitest run --project @roofline/api --project @roofline/db` before committing. I could not get a clean run of it:
- Machine load average was 100 to 340 for the whole session (about 15 PostGIS containers from parallel agents, emulated amd64).
- Run 1 started its container but it dropped mid-run (`Connection terminated unexpectedly`), so unrelated files such as `auth-google`, `jobs`, `twilio-hooks`, `runner` failed wholesale.
- Runs 2, 3 and 4 (plus a retry loop) died at Testcontainers' 180 s health check (`Health check not healthy after 180000ms`) before any test started; one attempt that did start was at 134/161 failures in `team.test.ts` after 634 s (timeouts).
- A last targeted run did complete once the load eased (about 55 minutes of wall time): `search`, `map`, `customers`, `properties`, `jobs`, `rep-visibility` (the F1 flake at line 400 did not fire), `isolation`, `boundaries`, `app`, `validate` and all of `packages/db/test`:
```
npx vitest run --project @roofline/api --project @roofline/db <those files>
 Test Files  16 passed (16)
      Tests  691 passed (691)
```
The api files not in that subset (approvals, auth, dispatcher, mailer, permissions, pgboss, runner, scheduler, send-batch, seed-demo, sms/twilio hooks, tasks, team, config) were not re-run to a clean result.
None of those failures touch my files; they are the container and timeout symptoms. What changed outside new files is additive: two `app.use` lines, additive exports, and `search.ts` gained imports (`scope.ts` imports neither `search.ts` nor `customers.ts`, so no import cycle). `lint` and `tsc -b` passing cover the type and boundary side. The F1 flake at `rep-visibility.test.ts:400` was not reached. Please run the full api + db projects once when the machine is quiet.

## Self-review

- Tenant rules: every read is inside `withTenant`; all three search lists and both pin layers and the area fallback apply the scope helpers. No `@roofline/db/system` import.
- `customerMatch` in `search.ts` duplicates the name-or-phone-digits condition in `listCustomers` (customers.ts), because the brief's file list does not include `customers.ts` and `customers.ts` already imports `search.ts` (so the shared helper would have to live in `search.ts` and customers.ts be edited to use it). Suggest a follow-up to have `listCustomers` import it so the two cannot drift.
- Jobs of an archived customer still appear in search and as job pins (the job is live; the F1 scope comments say archived records are not hidden through their jobs). Customer pins and search addresses do exclude archived customers, as the brief says. A property archived while holding open jobs cannot happen (archiving an address with jobs is refused), so job pins do not re-check `properties.archived_at`.
- Job pins/clusters join `properties` only (no `customers` join) in the count and cluster queries: the composite FK guarantees the customer exists, and the row set equals the points query's inner join.
- `ST_XMin(service_area)` (geometry auto-casts to box3d) is used for the single-row service-area bounds; the located-address fallback uses `ST_Extent`. Same boxes.
- Cluster grid is anchored at the origin and its cell size follows the box width, so membership shifts as the user zooms or pans (as the brief specifies); the client should treat clusters as a view, not an identity.
- Sequential queries inside the transaction (one connection); no `Promise.all` on a `tx`.

## Concerns

- The verification gap above.
- Task 9 should know that `bounds` for a single located address is a zero-area box (west = east, south = north), as the brief specifies; fitting the map to it needs a minimum zoom.
