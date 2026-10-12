# G1 Task 9 report: NWS hourly forecast for the weather watch

Commit d0be416 on branch g1-t9.

## Built
- A-nws-impl (apps/api/src/weather/nws.ts, source.ts): `HourlyForecast` type and `hourly(lat, lng, hours)` on WeatherSource; NullWeatherSource returns null; NwsWeatherSource.hourly follows points then forecastHourly, parses probabilityOfPrecipitation.value (absent/null gives 0, clamped 0..100) and gust (windGust, else the higher number in windSpeed as a conservative stand-in, documented in a comment). Null on any failure, never throws.
- B-fake-and-stubs (test/helpers.ts, test/weather.test.ts): FAKE_HOURLY, FakeWeatherSource.hourly with hourlyCalls/hourlyValue, hourly stubs in the WeatherSource literals, two new tests.
- C-nws-tests-fixture (test/nws.test.ts, test/fixtures/nws-hourly-forecast.json): new fixture (existing nws-hourly.json lacks precip and wind fields) and NwsWeatherSource.hourly tests including the null cases.

## Reviews
- Review 1: verify passed, 1 finding F1; contact check ruled amend (amended).
- Review 2: verify passed, 0 findings.

## Minors
- Tests were written after the implementation, so not observed failing first.
- Empty periods gives null, not [].
- windSpeed/windGust accept null as well as absent.
- Scratch vitest config ran nws tests outside the worktree; API tests needing PostGIS (helpers/weather.test.ts describe) were not run locally (no Docker, Ruling AS).

## Verify
`slot npm run typecheck && slot npm run lint`: both exit 0 (tsc -b, eslint . clean, no output after the script banners).
