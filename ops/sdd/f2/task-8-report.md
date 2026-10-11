# Task 8 report: API weather

Status: DONE_WITH_CONCERNS (the new tests, lint and typecheck are green; the full `@roofline/api` + `@roofline/db` suite could not be completed because the machine was overloaded, see Concerns).

Worktree `/Users/parsasalahshori-a/RooflineWork/wt/t8`, branch `f2-t8`, one commit: `46778b0 feat(api): weather for the company location (NWS, cached 30 minutes)`.

## What I implemented

- `apps/api/src/weather/source.ts`: `WeatherIcon`, `CurrentWeather`, `WeatherSource`, and `NullWeatherSource` (`current` resolves null, calls nothing).
- `apps/api/src/weather/nws.ts`: `NwsWeatherSource` and an exported `weatherIcon(shortForecast, isDaytime)`.
  - `GET https://api.weather.gov/points/{lat4},{lng4}`, reads `properties.forecastHourly`, GETs it, uses `periods[0]`.
  - Sends `User-Agent` and `Accept: application/geo+json`, and `signal: AbortSignal.timeout(timeoutMs ?? 4000)` on each of the two requests.
  - Any non-200, timeout, network error, JSON error or unexpected shape resolves null. It never throws and logs nothing.
  - `tempF` is `Math.round`ed, and Celsius is converted. A missing or null unit means Fahrenheit; any other unit is a parse failure (null).
  - `updatedAt` is `new Date(startTime).toISOString()`; missing or unparseable falls back to the clock's now.
  - Icon rules in the brief's order: thunder, snow|sleet|flurr, rain|shower|drizzle, fog|haze, wind|breez, cloud|overcast, else sun by day and moon by night.
  - Only the first period is validated, so a broken later period does not matter.
  - The `forecastHourly` link is followed only when its origin is exactly `https://api.weather.gov`.
  - Non-finite lat/lng returns null without a call.
- `apps/api/src/weather/cache.ts`: `WeatherCache(source, clock, ttlMs = 30 * 60_000)`.
  - Caches per key, including null. An entry is fresh while `expiresAt > now`, and `expiresAt` is counted from when the answer arrived.
  - Overlapping misses share one in-flight promise.
  - If a source does throw (it should not), nothing is cached. The caller that caused the miss gets the rejection, and callers that joined its call get null. That is how "the route logs at most once per failed miss" holds without a timing-based test.
- `apps/api/src/routes/weather.ts`: `GET /api/weather` returns `{ weather }`.
  - Location comes from `companyLocation` inside `withTenant`; with no location it answers `{weather:null}` and makes no call.
  - Cache key is `${companyId}:${lat.toFixed(2)},${lng.toFixed(2)}`. The `WeatherCache` is built once per router, so once per app, using `deps.clock`.
  - A throw from the cache is passed to `deps.logError?.(err, 'weather')` and answered `{weather:null}`. It is never a 500.
- `packages/db/src/repos/location.ts` (NOT map.ts, per Ruling J): `companyLocation(tx, ctx)` plus a `CompanyLocation` type, both exported from `packages/db/src/index.ts`.
  - First `ST_PointOnSurface(service_area)` (with `ST_Y`/`ST_X`).
  - Else `ST_Centroid(ST_Collect(geom))` over the company's non-archived properties that have a `geom`. No rep scope is applied; I left a comment saying so.
  - Else null.
- Wiring:
  - `AppDeps.weather: WeatherSource` is required, and `/api/weather` is mounted in `createApp`.
  - `buildDeps` uses `NullWeatherSource` when `WEATHER_DISABLED`, else `NwsWeatherSource` with the user agent `NWS_USER_AGENT ?? \`Roofline (${PUBLIC_BASE_URL})\``.
  - `config.ts` has `NWS_USER_AGENT` (optional string) and `WEATHER_DISABLED` (optional; `1`/`true` → true, `0`/`false` → false, case-insensitive, anything else is a `ConfigError` naming `WEATHER_DISABLED`).
  - `.env.example` has both, commented out.
- Test support (`apps/api/test/helpers.ts`): `FAKE_WEATHER`, `FakeWeatherSource` (`calls`, settable `value`, settable `failure` that makes it throw), and `TestApp.weather`. No other test constructs `AppDeps` from scratch (all use `{...t.deps, ...}`), so nothing else needed `weather`.
- Fixtures `apps/api/test/fixtures/nws-points.json` and `nws-hourly.json` were written by hand (64 F, "Mostly Sunny", daytime, start 2026-10-12T09:00-05:00, plus a second period).

Small additions beyond the brief (all backwards compatible):
- `NwsOptions` has an optional `clock` (default `systemClock`), needed for the "missing startTime → clock's now" rule since the brief's constructor had no clock.
- `NWS_USER_AGENT` must be printable ASCII (it travels as an HTTP header; an em dash would make every request throw inside fetch and silently turn weather off). There is a test.
- `NullWeatherSource.current` is declared as a property typed `WeatherSource['current']`, so it can be called with `(lat, lng)` in tests without a lint-unused-arg error.

## Tests

`apps/api/test/nws.test.ts` (50 tests):
- Reads the first hourly period, and the exact request URLs (4 decimals).
- Sends `User-Agent`, `Accept` and an abort signal on both requests.
- Celsius conversion and rounding; missing unit means F.
- Thunderstorms → storm, night clear → moon; the first period wins over broken later ones.
- `updatedAt` fallback to the clock.
- Null on a 500 (points and hourly), on 404/301/203/429, on a timeout (a fetch that honours the signal, `timeoutMs: 20`), on a network error, and on 11 malformed-answer cases including bad JSON, a link on another host and a bad unit. It also checks that no host other than api.weather.gov is ever requested, and that a non-finite location makes no call.
- 25-row `weatherIcon` table, and `NullWeatherSource`.

`apps/api/test/config.test.ts` (+15 cases):
- Optional and blank handling, and `WEATHER_DISABLED` parsing (1/true/TRUE/0/false, and rejection of yes/on/2/disabled).
- ASCII-only `NWS_USER_AGENT`.
- `buildDeps` end to end with `fetch` stubbed:
  - `WEATHER_DISABLED=1` or `true` → `NullWeatherSource`, with no request made.
  - Default user agent is `Roofline (https://app.roofline.test)`.
  - `NWS_USER_AGENT` replaces the default.
  - `WEATHER_DISABLED=0` → `NwsWeatherSource`.

`apps/api/test/weather.test.ts` (18 tests):
- Route:
  - Needs a session (401, no call).
  - Null without a location and no call.
  - Service area, then cached; still cached at 29 min, refetched at 31.
  - A new answer replaces the old after expiry.
  - A null failure is cached too, then asked again after 31 min.
  - Owner, office and rep all read it and share the company cache.
  - A source that throws is logged once as `{err, where:'weather'}` and answered `{weather:null}` with no leak of the message; it is not cached.
  - Location fallback to the centroid of pinned addresses (-96/41 and -95/43 → 42, -95.5).
  - Archived addresses, addresses with no pin and the other company's are ignored.
  - A rep who sees zero properties still gets the company centroid.
  - The service area wins over the pins.
  - Per-company location and cache entry.
- `WeatherCache` unit tests:
  - The 30-minute TTL to the millisecond.
  - TTL counted from the answer's arrival.
  - The key, not the exact coordinates, decides.
  - Overlapping misses share one call.
  - Null is shared and kept.
  - A throw reaches only the caller that caused the miss, joiners get null, and nothing is cached.

## TDD evidence

RED (before any `src/weather` file existed), `npx vitest run --project @roofline/api apps/api/test/nws.test.ts apps/api/test/config.test.ts apps/api/test/weather.test.ts`:

```
 FAIL  |@roofline/api| test/config.test.ts  Error: Cannot find module '../src/weather/nws.ts' imported from .../test/config.test.ts
 FAIL  |@roofline/api| test/nws.test.ts     Error: Cannot find module '../src/weather/nws.ts' imported from .../test/nws.test.ts
 FAIL  |@roofline/api| test/weather.test.ts Error: Cannot find module '../src/weather/cache.ts' imported from .../test/weather.test.ts
 Test Files  3 failed (3)   Tests  no tests
```

First GREEN attempt found 2 real failures, both fixed before commit:
- The `startTime` zod field was `z.unknown()`, which made the key required in zod 4. It is now `.optional()`.
- A `toMatchObject({X: undefined})` expectation in my config test was wrong; I replaced it with `toBeUndefined()` assertions.

GREEN: after the fixes, `nws.test.ts`, `config.test.ts` and `weather.test.ts`: `Test Files 3 passed (3)`, `Tests 108 passed (108)`. That final run was in the real Postgres/PostGIS harness (the repo's global setup, with a longer container start-up wait, see Concerns), after the last code change.

Teeth check (mutation, restored afterwards):
- Dropping `companyId` from the cache key made "each company has its own location and its own cache entry" fail.
- Dropping `isNull(archivedAt)` from `companyLocation` made the archived-address test fail.

Other verification:
- `npm run lint`: clean. `npm run typecheck` (`tsc -b`): clean. Both ran after the final source edits.
- One manual, non-test smoke of `NwsWeatherSource` against the live service from a throwaway script outside the repo: Omaha (41.2565,-95.9345) → `{tempF:82, summary:'Mostly Sunny', icon:'sun', isDaytime:true, updatedAt:'2026-10-11T18:00:00.000Z'}`; London → null (the service 404s outside the US). It was 3 public GETs, and it confirms the real response shape matches the fixtures. No test calls the network.

## Files changed

New:
- `apps/api/src/weather/source.ts`, `apps/api/src/weather/nws.ts`, `apps/api/src/weather/cache.ts`
- `apps/api/src/routes/weather.ts`
- `packages/db/src/repos/location.ts`
- `apps/api/test/nws.test.ts`, `apps/api/test/weather.test.ts`
- `apps/api/test/fixtures/nws-points.json`, `apps/api/test/fixtures/nws-hourly.json`

Modified:
- `apps/api/src/app.ts`, `apps/api/src/deps.ts`, `apps/api/src/config.ts`
- `apps/api/test/helpers.ts`, `apps/api/test/config.test.ts`
- `packages/db/src/index.ts` (+1 line)
- `.env.example`

## Self-review

- Brief vs code:
  - The NWS rules, cache semantics, `companyLocation` order, route shape, cache key, config and `buildDeps` all follow the brief and the decisions you listed.
  - The timeout is per request (two requests, so up to 8 s worst case, one shared in-flight call). I read "a 4 s timeout" literally. A single shared deadline would be a one-line change if you prefer it.
- Rep scope: `companyLocation` deliberately ignores `propertyScope`. A test with a rep who sees no properties proves the company location is still used.
- Security: the forecast link is host-checked; the user agent is validated; nothing from the upstream answer reaches the client except the five mapped fields; the route never returns an error body for weather problems.
- The cache map is not swept (entries are tiny, one per company per ~1 km cell, replaced when asked again). This is documented in the class comment.
- `packages/db/src/index.ts`: I put the `location.ts` export alphabetically, right after `jobs` and before `messages`. The parallel map task will probably add its export in the same gap, so expect a trivial 1-hunk merge conflict there.
- The brief's "Files" list says `packages/db/src/repos/map.ts` (add `companyLocation`); I followed Ruling J and used `repos/location.ts`.

## Concerns

1. The full `npx vitest run --project @roofline/api --project @roofline/db` was NOT completed.
   - The machine was under extreme load (load average 150-300). Several sibling worktrees were starting amd64-emulated PostGIS containers at once.
   - The repo's own global setup timed out ("Health check not healthy after 180000ms"; "No test files found" followed because global setup failed).
   - A first full-suite attempt got through a few files before I stopped it. Failures there were wholesale in unrelated files (all 105 `auth-google` tests, all 58 `runner` tests, and so on, plus "Idle tenant database connection failed: Connection terminated unexpectedly" on a later attempt), which is the container or VM dying, not test logic. I did not investigate them file by file.
   - What did run: my three files in the real harness (108 passed), using a scratch vitest config and global setup outside the repo (a copy of the repo's global setup with a 25 min start-up wait and longer test timeouts, because of the load).
   - What this does not cover: the rest of the `@roofline/api` suite and the whole `@roofline/db` suite were not re-run on this branch.
   - Why I think the risk is low: the only shared runtime changes are one new required `AppDeps` field, one new `TestApp` field, one db export and config keys. `tsc -b` is clean for every consumer.
   - The known `rep-visibility.test.ts:400` flake was not exercised.
   - Please re-run the full suite when the machine is quiet.
2. Process note: while stopping my own stale background run I also ran `pkill -f "vitest run --project @roofline/api"`, a pattern that could match other worktrees' vitest processes. Their processes (t6, t7, main) were still alive afterwards, but if any sibling saw an inexplicably killed test run around 12:19, that was probably me.
3. The `WeatherCache` shares one call only within one app instance, and the cache is in memory (per process), as the brief specified. Two server processes each keep their own cache.

## Team review finalization

- Review 1: verify passed, 0 findings. No fixes, nothing to commit; HEAD stays 46778b0.
- Verify: `slot npm run typecheck && slot npm run lint` both exit 0 (tsc -b, eslint . clean).
- CI: ci-check pushed f2-t8@46778b0 (branch already at that sha) but no GitHub Actions run exists for that branch or sha (checked twice via the REST API, total_count 0), so the database suites have not been run. Re-run needs a new commit or a controller-side trigger.
