### Task 14: Geocodio geocoder

**Base:** `f3-setup` after Task 9 is merged. From T9: `providers/geocoder.ts` (`Geocoder`, `GeocodeResult`, `GeocoderUnavailableError`), the stub `providers/geocodio.ts` (`geocodioFor(config): Geocoder | null`, already called by `createGeocoder`), config `GEOCODIO_API_KEY`.

**Split:** (two builders, the plan's split)
- Builder 1: `apps/api/src/providers/geocodio.ts`.
- Builder 2: the fixtures and `apps/api/test/geocodio.test.ts`.

**Files:**
- Create: `apps/api/test/fixtures/geocodio/{single.json,low-accuracy.json,batch.json}`
- Modify: `apps/api/src/providers/geocodio.ts` (replace the stub)
- Test: `apps/api/test/geocodio.test.ts`
- Do not touch: `providers/geocoder.ts`, `deps.ts`, `config.ts`.

**Interfaces:**
```ts
export class GeocodioGeocoder implements Geocoder { constructor(o: { apiKey: string; fetch?: typeof fetch; timeoutMs?: number; baseUrl?: string }) }
export function geocodioFor(config: Config): Geocoder | null;   // GEOCODIO_API_KEY set → new GeocodioGeocoder({ apiKey }); else null
```
- `configured = true`. `baseUrl` defaults to `https://api.geocod.io/v1.7` (Ruling 31: the builder checks Geocodio's current version in its docs if reachable; otherwise keep v1.7 and note it in the report). `timeoutMs` defaults to 8000.
- **`geocode(address)`:**
  - `GET {base}/geocode?q=<encoded>&fields=timezone&limit=1&api_key=<key>`.
  - Accept `results[0]` only when `accuracy >= 0.8` and `accuracy_type` is one of `rooftop`, `point`, `range_interpolation`, `nearest_rooftop_match`, `intersection`, `street_center`; otherwise null. No results → null.
  - Mapping: `lng = location.lng`, `lat = location.lat`; `street = \`${address_components.number} ${address_components.formatted_street}\`` (trimmed; null when both missing); `city`, `state`, `zip` from `address_components`; `timezone = fields.timezone.name ?? null`; `accuracy`, `accuracyType = accuracy_type`; `source: 'geocodio'`.
  - 422 → null. 401, 403, 5xx, timeout, network error, unreadable JSON → `GeocoderUnavailableError("Geocodio didn't answer.")`. Other 4xx → the same error.
  - The request URL (which holds the key) is never put in an error or a log line.
- **`geocodeMany(addresses)`:** `POST {base}/geocode?fields=timezone&limit=1&api_key=<key>` with a JSON array body (`content-type: application/json`), in chunks of 1,000; read `results[i].response.results[0]` with the same acceptance rule; output keeps input order; an empty input makes no request.

**Fixtures** (shapes as Geocodio returns them, trimmed to what is read):
- `single.json`: one result `1200 Farnam St, Omaha, NE 68102`, `location { lat: 41.2565, lng: -95.9345 }`, `accuracy 1`, `accuracy_type 'rooftop'`, `address_components { number: '1200', formatted_street: 'Farnam St', city: 'Omaha', state: 'NE', zip: '68102' }`, `fields.timezone.name 'America/Chicago'`.
- `low-accuracy.json`: `accuracy 0.9`, `accuracy_type 'place'`.
- `batch.json`: a template batch answer; the test builds the 2,500-item answers from it.

**Tests (`geocodio.test.ts`)** — an injected `fetch` serving the fixtures and recording requests:
- `single.json` → `toMatchObject({ street: '1200 Farnam St', city: 'Omaha', state: 'NE', zip: '68102', timezone: 'America/Chicago', lng: -95.9345, lat: 41.2565, source: 'geocodio' })`; the request URL has `fields=timezone` and `limit=1`.
- `low-accuracy.json` → null; a 422 → null.
- 500 and a timeout (`timeoutMs: 50`, a fetch that waits on the abort signal) → `GeocoderUnavailableError`, whose `message` contains neither `api_key` nor the key value.
- 2,500 addresses → 3 POSTs (1000, 1000, 500) and 2,500 results in input order (each answer echoes its index in `address_components.number`).
- `geocodioFor` returns null without `GEOCODIO_API_KEY`.

**Verify notes:**
- The api project's globalSetup needs Docker (none here): locally `npm run typecheck && npm run lint`; prove with `ops/bin/ci-check`.
- Commit: `feat(geocode): Geocodio adapter for single and batch addresses`.
