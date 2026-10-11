### Task 8: API: weather

**Files:**
- Create: `apps/api/src/weather/source.ts`, `apps/api/src/weather/nws.ts`, `apps/api/src/weather/cache.ts`, `apps/api/src/routes/weather.ts`, `packages/db/src/repos/map.ts` (add `companyLocation`), `apps/api/test/fixtures/nws-points.json`, `apps/api/test/fixtures/nws-hourly.json`
- Modify: `apps/api/src/app.ts` (`AppDeps.weather`, mount), `apps/api/src/deps.ts` (`NwsWeatherSource` / `NullWeatherSource`), `apps/api/src/config.ts` (`NWS_USER_AGENT`, `WEATHER_DISABLED`, both optional), `apps/api/test/helpers.ts` (`FakeWeatherSource` in `TestApp`), `.env.example`
- Test: `apps/api/test/weather.test.ts`, `apps/api/test/nws.test.ts`

**Interfaces:**
```ts
export type WeatherIcon = 'sun' | 'moon' | 'cloud' | 'rain' | 'storm' | 'snow' | 'fog' | 'wind';
export type CurrentWeather = { tempF: number; summary: string; icon: WeatherIcon; isDaytime: boolean; updatedAt: string };
export interface WeatherSource { current(lat: number, lng: number): Promise<CurrentWeather | null> }
export class NwsWeatherSource implements WeatherSource { constructor(opts: { userAgent: string; fetch?: typeof fetch; timeoutMs?: number }) }
export class WeatherCache { constructor(source: WeatherSource, clock: Clock, ttlMs = 30 * 60_000); get(key: string, lat: number, lng: number): Promise<CurrentWeather | null> }
export async function companyLocation(tx: Tx, ctx: TenantContext): Promise<{ lat: number; lng: number } | null>;
```
- **`NwsWeatherSource`**
  - Calls `GET https://api.weather.gov/points/{lat4},{lng4}` (4 decimals), reads `properties.forecastHourly`, GETs it, and uses `properties.periods[0]`.
  - Maps the fields: `temperature` (°F; convert when `temperatureUnit` is `C`), `shortForecast` → `summary`, `isDaytime`.
  - Picks the icon from keyword matches on `shortForecast`: thunder → storm; snow, sleet or flurr → snow; rain, shower or drizzle → rain; fog or haze → fog; wind or breez → wind; cloud or overcast → cloud; otherwise sun by day and moon by night.
  - Sends `User-Agent` and `Accept: application/geo+json`, with a 4 s timeout through `AbortSignal.timeout`.
  - **Any non-200, timeout or parse failure resolves `null`.** It never throws.
- **`WeatherCache`**
  - Caches per key for 30 minutes, including a `null` result, so an outage is not hammered.
  - Concurrent misses share one in-flight promise.
- **`companyLocation`:** `ST_PointOnSurface(service_area)`, else `ST_Centroid(ST_Collect(geom))` of the company's located, non-archived properties (rep scope does not apply; this is the company's location), else null.
- **`GET /api/weather`** → `{ weather: CurrentWeather | null }`. With no location, `weather` is null and no fetch is made. Cache key: `${companyId}:${lat.toFixed(2)},${lng.toFixed(2)}`.
- **Config:**
  - `NWS_USER_AGENT` is optional. Default: `Roofline (${PUBLIC_BASE_URL})`.
  - `WEATHER_DISABLED` is optional. `1` or `true` makes `buildDeps` use `NullWeatherSource`, which always returns null. The e2e stack sets it, so the suite never touches the network.
- **Deps:** `AppDeps.weather: WeatherSource`. `buildDeps` uses `NwsWeatherSource`; tests use `FakeWeatherSource`, which records calls and returns a set value.

- [ ] **Step 1: Write the failing tests**

`nws.test.ts` (an injected `fetch` that serves the two fixture files; no network):
- `it('reads the first hourly period')` → `{ tempF: 64, summary: 'Mostly Sunny', icon: 'sun', isDaytime: true }`. Write the fixtures with those values.
- `it('converts Celsius')`.
- `it('maps thunderstorms to storm and night clear to moon')`.
- `it('returns null on a 500, a timeout and bad JSON')`.
- `config.test.ts`: `WEATHER_DISABLED=1` makes `buildDeps(...).weather` a `NullWeatherSource`.
- `it('sends a User-Agent')`.

`weather.test.ts`:
- `it('is null without a location and makes no call')`.
- `it('uses the service area, then caches for 30 minutes')`: set the service area; two GETs give one source call. `clock.advance(31 min)`, then GET → two calls.
- `it('caches a failure too')`: the source returns null → `{weather:null}`, and a second GET makes no call.
- `it('needs a session')`.

- [ ] **Step 2: Run them and see them fail**.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run the full suite and lint**. Expected: PASS.
- [ ] **Step 5: Commit** — `feat(api): weather for the company location (NWS, cached 30 minutes)`

---

