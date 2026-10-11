### Task 15: Sign-up with company details; locate and service area

**Base:** `f3-setup` after Task 9 is merged. From T9: `deps.geocoder` (`Geocoder`, `GeocodeResult`, `GeocoderUnavailableError`, `FakeGeocoder` on `TestApp.geocoder`). From T1: `companies.location` (`geometry(Point,4326)`) and `service_area_miles` (CHECK 10/20/40/60), tenant `UPDATE (location, service_area_miles)` (0011) on top of F1's `UPDATE (… phone_e164, address_*, timezone, service_area …)` (0002); placeholder `packages/db/src/repos/company-location.ts` (in the barrel). `toE164`, `isTimeZone` in `@roofline/shared`. Do not confuse with F2's `packages/db/src/repos/location.ts` (`companyLocation`, the weather's point) — leave that file alone.

**Split:**
- Builder 1: `apps/api/src/company/location.ts` and `packages/db/src/repos/company-location.ts`.
- Builder 2: `apps/api/src/auth/routes.ts` (sign-up and Google bodies, `GET /config`), `apps/api/src/auth/middleware.ts`, `apps/api/test/helpers.ts` (`SIGNUP_COMPANY`), and `SIGNUP_COMPANY` spread into every sign-up body in `apps/api/test/auth-{password,email,google}.test.ts`.
- Builder 3: `apps/api/src/routes/company.ts` endpoints and the three new test files.

**Files:**
- Create: `apps/api/src/company/location.ts`, `apps/api/test/{signup-company,company-location,auth-config}.test.ts`
- Modify: `packages/db/src/repos/company-location.ts`, `apps/api/src/auth/routes.ts`, `apps/api/src/auth/middleware.ts`, `apps/api/src/routes/company.ts`, `apps/api/test/helpers.ts`, `apps/api/test/auth-{password,email,google}.test.ts`
- Do not touch: `packages/db/src/system/auth.ts` and `apps/api/src/auth/sessions.ts` (T21 edits them in parallel), `repos/location.ts`.

**Interfaces:**
```ts
// company/location.ts
export type LocateOutcome = { kind: 'located'; result: GeocodeResult } | { kind: 'not_found' } | { kind: 'unavailable' };
export async function locateAddress(geocoder: Geocoder, text: string): Promise<LocateOutcome>;   // null → not_found; GeocoderUnavailableError (or configured === false) → unavailable
export const DEFAULT_SERVICE_AREA_MILES = 40; export const SERVICE_AREA_CHOICES = [10, 20, 40, 60] as const;
// repos/company-location.ts
export async function setCompanyLocation(tx: Tx, ctx: TenantContext, i: { street: string | null; city: string | null; state: string | null;
  zip: string | null; phoneE164?: string; timezone: string | null; point: { lng: number; lat: number } | null; serviceAreaMiles: number | null }): Promise<void>;
export async function setServiceAreaRadius(tx: Tx, ctx: TenantContext, miles: number): Promise<boolean>;   // false when the company has no location
export async function companyLocationFacts(tx: Tx, ctx: TenantContext): Promise<{ addressText: string | null; located: boolean; serviceAreaMiles: number | null }>;
```
- **`setCompanyLocation`:** writes `address_street/city/state/zip`, `phone_e164` when given, `timezone` only when `i.timezone` passes `isTimeZone`, `location = ST_SetSRID(ST_MakePoint(lng, lat), 4326)` when `point`, `service_area_miles`, and — when both point and miles — `service_area = ST_Multi(ST_Buffer(location::geography, miles * 1609.344)::geometry)`; `updated_at = now()`.
- **`setServiceAreaRadius`:** same buffer from the stored `location`; false (no write) when `location` is null.
- **`SIGNUP_COMPANY`** (exported from `test/helpers.ts`): `{ companyPhone: '(402) 555-0199', companyAddress: '1200 Farnam St, Omaha, NE 68102' }`.
- **Sign-up and Google bodies** gain `companyPhone` and `companyAddress`, both required for a new company:
  - `companyPhone` through `toE164` → field `companyPhone`, "That doesn't look like a US phone number."
  - `companyAddress`: trimmed, 1–300 characters → field `companyAddress`, "Please enter your business address."
  - **Google, new user:** validate `companyName`, then `companyPhone`, then `companyAddress` (same rules), so a bare credential gets field `companyName`.
- **Geocoding happens before the account is created** (in `createCompanyAccount`'s callers, before `createAccount`):
  - `not_found` → 400, field `companyAddress`, "We couldn't find that address. Check the street, city and state." Nothing is created.
  - `located` → after `createAccount`, in the **same tenant transaction as `insertDefaultSettings`**: `setCompanyLocation` with the result's parts (falling back to the typed text for `street` when the result has none), `phoneE164`, the result's timezone, the point and `DEFAULT_SERVICE_AREA_MILES`.
  - `unavailable` → the account is still created; `setCompanyLocation` with `street` = the typed text, the phone, no point, no timezone, `serviceAreaMiles: null`.
- **`GET /api/auth/config`:** public → `{ googleClientId: string | null }` from `GOOGLE_CLIENT_ID`. `PUBLIC_ROUTES` in `middleware.ts` gains the entry `'GET /auth/config'` (the set holds `"METHOD /path"` strings; add it outside the POST `map`).
- **Company endpoints** (`routes/company.ts`, `requireCapability('company_admin')`, i.e. owner only):
  - `POST /api/company/locate`: geocodes the saved address (`address_street, city, state zip` joined). → 200 `{ located: true }` (writes location, timezone, keeps an existing `service_area_miles` else 40, rebuilds the area); not found → 400, field `addressStreet`, the not-found message; unavailable → 503 "We couldn't reach the map service. Try again in a minute."; audit `company.located`.
  - `PUT /api/company/service-area { radiusMiles }`: not in `SERVICE_AREA_CHOICES` → 400, field `radiusMiles`, "Pick 10, 20, 40 or 60 miles."; no location → 409 "Place your address on the map first."; audit `company.service_area { radiusMiles }`; → 200 the company body.
  - `GET /api/company` body gains `located: boolean` and `serviceAreaMiles: number | null`.

**Tests:**
- `signup-company.test.ts`:
  - `test('sign-up sets the company up from the address')`: POST `/api/auth/signup` with `SIGNUP_COMPANY` → 201; the row has `phone_e164 '+14025550199'`, `address_street '1200 Farnam St'`, `address_city 'Omaha'`, `address_state 'NE'`, `address_zip '68102'`, `timezone 'America/Chicago'`, `service_area_miles 40`; `ST_Contains(service_area, location)` true; `ST_Area(service_area::geography)` within 2% of `Math.PI * 64373.76 ** 2`.
  - `test('a New York address gets the New York time zone')`: `'1 Main St, Albany, NY 12207'` → `America/New_York`.
  - `test("an address we can't find is a field error and creates nothing")`: `'1 Nowhere Rd, Omaha, NE 68102'` → 400 field `companyAddress`; no user, no company.
  - `test('when the map service is down, sign-up still works')`: `'12 Outage Ave, Omaha, NE 68102'` → 201, `location` null, `address_street` = the typed text.
  - `test('a bad business phone is a field error')`: `'12'` → 400 field `companyPhone`.
  - `test('Google sign-up asks for the company details too')`: a new Google user with only `companyName` → 400, field `companyPhone`.
- `company-location.test.ts`: `locate` as owner → 200; as office → 403; radius 20 → area within 2% of `Math.PI * 32186.88 ** 2`; 25 → 400; before locating (location null by SQL) → 409; `GET /api/company` → `located true`, `serviceAreaMiles 20`.
- `auth-config.test.ts`: answers without a session; gives the client id, or `null` with `makeTestApp({ GOOGLE_CLIENT_ID: undefined })`.

**Verify notes:**
- api suite needs Docker (none here): locally `npm run typecheck && npm run lint`; prove with `ops/bin/ci-check`. All F1 auth tests must pass with `SIGNUP_COMPANY` added.
- Commit: `feat(signup): company phone and address at sign-up; time zone and service area from the map`.
