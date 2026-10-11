import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import type { Clock } from '../src/clock.ts';
import { NwsWeatherSource, weatherIcon } from '../src/weather/nws.ts';
import { NullWeatherSource } from '../src/weather/source.ts';

/*
 * The National Weather Service source, against canned responses. Nothing here reaches the network:
 * every test hands the source its own `fetch`, so a test that forgot to would fail on a missing
 * route, not call api.weather.gov.
 */

const POINTS = readFileSync(new URL('./fixtures/nws-points.json', import.meta.url), 'utf8');
const HOURLY = readFileSync(new URL('./fixtures/nws-hourly.json', import.meta.url), 'utf8');
const HOURLY_URL = 'https://api.weather.gov/gridpoints/OAX/80,63/forecast/hourly';
const USER_AGENT = 'Roofline (https://app.roofline.test)';

type Call = { url: string; init: RequestInit | undefined };

/** A `fetch` that answers from `answer` and records every request. A route it does not know is a 599. */
function fakeFetch(answer: (url: string) => Response | Promise<Response> | undefined) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return (await answer(url)) ?? new Response('unexpected request', { status: 599 });
  }) as typeof fetch;
  return { fetch: fn, calls };
}

/** Serves the two fixtures, or `hourly` in place of the hourly one. */
function serving(hourly: string = HOURLY) {
  return fakeFetch((url) => {
    if (url.startsWith('https://api.weather.gov/points/')) return new Response(POINTS, { status: 200 });
    if (url === HOURLY_URL) return new Response(hourly, { status: 200 });
    return undefined;
  });
}

/** An hourly forecast whose first period is `period`. */
const hourlyWith = (period: Record<string, unknown>) => JSON.stringify({ properties: { periods: [period] } });

const base = { temperature: 64, temperatureUnit: 'F', shortForecast: 'Mostly Sunny', isDaytime: true, startTime: '2026-10-12T09:00:00-05:00' };

const OMAHA = [41.2565, -95.9345] as const;

describe('NwsWeatherSource', () => {
  test('reads the first hourly period', async () => {
    const { fetch, calls } = serving();
    const weather = await new NwsWeatherSource({ userAgent: USER_AGENT, fetch }).current(...OMAHA);
    expect(weather).toEqual({
      tempF: 64,
      summary: 'Mostly Sunny',
      icon: 'sun',
      isDaytime: true,
      // The period's start time, as an ISO instant (09:00 at -05:00).
      updatedAt: '2026-10-12T14:00:00.000Z',
    });
    expect(calls.map((c) => c.url)).toEqual(['https://api.weather.gov/points/41.2565,-95.9345', HOURLY_URL]);
  });

  test('asks for the location to four decimals', async () => {
    const { fetch, calls } = serving();
    await new NwsWeatherSource({ userAgent: USER_AGENT, fetch }).current(41.256_512_345, -95.934_549_9);
    expect(calls[0]!.url).toBe('https://api.weather.gov/points/41.2565,-95.9345');
    await new NwsWeatherSource({ userAgent: USER_AGENT, fetch }).current(41.1, -96);
    expect(calls[2]!.url).toBe('https://api.weather.gov/points/41.1000,-96.0000');
  });

  test('sends a User-Agent and the geo+json Accept header on both requests', async () => {
    const { fetch, calls } = serving();
    await new NwsWeatherSource({ userAgent: USER_AGENT, fetch }).current(...OMAHA);
    expect(calls).toHaveLength(2);
    for (const { init } of calls) {
      const headers = new Headers(init?.headers);
      expect(headers.get('User-Agent')).toBe(USER_AGENT);
      expect(headers.get('Accept')).toBe('application/geo+json');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
  });

  test('converts Celsius, and rounds to a whole degree', async () => {
    const celsius = serving(hourlyWith({ ...base, temperature: 18, temperatureUnit: 'C' }));
    expect((await new NwsWeatherSource({ userAgent: USER_AGENT, fetch: celsius.fetch }).current(...OMAHA))?.tempF).toBe(64); // 64.4
    const freezing = serving(hourlyWith({ ...base, temperature: -10, temperatureUnit: 'C' }));
    expect((await new NwsWeatherSource({ userAgent: USER_AGENT, fetch: freezing.fetch }).current(...OMAHA))?.tempF).toBe(14);
    const fractional = serving(hourlyWith({ ...base, temperature: 64.6 }));
    expect((await new NwsWeatherSource({ userAgent: USER_AGENT, fetch: fractional.fetch }).current(...OMAHA))?.tempF).toBe(65);
  });

  test('a missing unit means Fahrenheit (what the service sends for the US)', async () => {
    const { fetch } = serving(hourlyWith({ ...base, temperatureUnit: undefined })); // JSON leaves it out
    expect((await new NwsWeatherSource({ userAgent: USER_AGENT, fetch }).current(...OMAHA))?.tempF).toBe(64);
  });

  test('maps thunderstorms to storm and night clear to moon', async () => {
    const thunder = serving(hourlyWith({ ...base, shortForecast: 'Showers And Thunderstorms Likely' }));
    expect(await new NwsWeatherSource({ userAgent: USER_AGENT, fetch: thunder.fetch }).current(...OMAHA)).toMatchObject({
      icon: 'storm',
      summary: 'Showers And Thunderstorms Likely',
    });
    const night = serving(hourlyWith({ ...base, shortForecast: 'Mostly Clear', isDaytime: false }));
    expect(await new NwsWeatherSource({ userAgent: USER_AGENT, fetch: night.fetch }).current(...OMAHA)).toMatchObject({
      icon: 'moon',
      isDaytime: false,
    });
  });

  test('the first period wins even when later ones are broken', async () => {
    const { fetch } = serving(JSON.stringify({ properties: { periods: [base, { nonsense: true }, null] } }));
    expect(await new NwsWeatherSource({ userAgent: USER_AGENT, fetch }).current(...OMAHA)).toMatchObject({ tempF: 64 });
  });

  test("without a start time, 'updated' is the source's own clock", async () => {
    const clock: Clock = { now: () => new Date('2026-10-12T15:30:00.000Z') };
    const { fetch } = serving(hourlyWith({ ...base, startTime: undefined })); // JSON leaves it out
    expect(await new NwsWeatherSource({ userAgent: USER_AGENT, fetch, clock }).current(...OMAHA)).toMatchObject({
      updatedAt: '2026-10-12T15:30:00.000Z',
    });
    const garbled = serving(hourlyWith({ ...base, startTime: 'sometime soon' }));
    expect(await new NwsWeatherSource({ userAgent: USER_AGENT, fetch: garbled.fetch, clock }).current(...OMAHA)).toMatchObject({
      updatedAt: '2026-10-12T15:30:00.000Z',
    });
  });

  describe('returns null (and never throws)', () => {
    const source = (fetch: typeof globalThis.fetch, timeoutMs?: number) =>
      new NwsWeatherSource({ userAgent: USER_AGENT, fetch, timeoutMs });

    test('on a 500', async () => {
      const points = fakeFetch(() => new Response('oops', { status: 500 }));
      expect(await source(points.fetch).current(...OMAHA)).toBeNull();
      expect(points.calls).toHaveLength(1);

      const hourly = fakeFetch((url) => new Response(url === HOURLY_URL ? 'oops' : POINTS, { status: url === HOURLY_URL ? 500 : 200 }));
      expect(await source(hourly.fetch).current(...OMAHA)).toBeNull();
      expect(hourly.calls).toHaveLength(2);
    });

    test('on any other status, including a 404 for a place outside the US and a 203', async () => {
      for (const status of [404, 301, 203, 429]) {
        const { fetch } = fakeFetch(() => new Response(POINTS, { status }));
        expect(await source(fetch).current(51.5, -0.12)).toBeNull();
      }
    });

    test('on a timeout (the request is aborted after timeoutMs)', async () => {
      const hang = ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        })) as unknown as typeof fetch;
      expect(await source(hang, 20).current(...OMAHA)).toBeNull();
    });

    test('on a network failure', async () => {
      const down = (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch;
      expect(await source(down).current(...OMAHA)).toBeNull();
    });

    test.each([
      ['bad JSON from the points call', () => new Response('<html>', { status: 200 }), undefined],
      ['bad JSON from the hourly call', undefined, () => new Response('{"properties":', { status: 200 })],
      ['no forecastHourly link', () => new Response('{"properties":{}}', { status: 200 }), undefined],
      ['a forecastHourly link that is not a string', () => new Response('{"properties":{"forecastHourly":7}}', { status: 200 }), undefined],
      ['a forecastHourly link on another host', () => new Response('{"properties":{"forecastHourly":"https://evil.example/hourly"}}', { status: 200 }), undefined],
      ['no periods', undefined, () => new Response('{"properties":{"periods":[]}}', { status: 200 })],
      ['a first period with no temperature', undefined, () => new Response(hourlyWith({ ...base, temperature: undefined }), { status: 200 })],
      ['a temperature that is text', undefined, () => new Response(hourlyWith({ ...base, temperature: 'warm' }), { status: 200 })],
      ['an unknown temperature unit', undefined, () => new Response(hourlyWith({ ...base, temperatureUnit: 'K' }), { status: 200 })],
      ['a first period with no summary', undefined, () => new Response(hourlyWith({ ...base, shortForecast: '' }), { status: 200 })],
      ['a first period with no day/night flag', undefined, () => new Response(hourlyWith({ ...base, isDaytime: 'yes' }), { status: 200 })],
    ])('on %s', async (_name, points, hourly) => {
      const { fetch, calls } = fakeFetch((url) => {
        if (url.startsWith('https://api.weather.gov/points/')) return points?.() ?? new Response(POINTS, { status: 200 });
        if (url === HOURLY_URL) return hourly?.() ?? new Response(HOURLY, { status: 200 });
        return undefined;
      });
      expect(await source(fetch).current(...OMAHA)).toBeNull();
      // A forecast link on another host is never followed.
      expect(calls.every((c) => c.url.startsWith('https://api.weather.gov/'))).toBe(true);
    });

    test('without calling anything for a location that is not a place', async () => {
      const { fetch, calls } = serving();
      expect(await source(fetch).current(Number.NaN, -95.9)).toBeNull();
      expect(await source(fetch).current(41.2, Number.POSITIVE_INFINITY)).toBeNull();
      expect(calls).toHaveLength(0);
    });
  });
});

describe('weatherIcon', () => {
  test.each([
    ['Mostly Sunny', true, 'sun'],
    ['Sunny', true, 'sun'],
    ['Clear', false, 'moon'],
    ['Mostly Clear', false, 'moon'],
    ['Partly Cloudy', true, 'cloud'],
    ['Mostly Cloudy', false, 'cloud'],
    ['Overcast', true, 'cloud'],
    ['Slight Chance Light Rain', true, 'rain'],
    ['Chance Rain Showers', false, 'rain'],
    ['Light Drizzle', true, 'rain'],
    ['Freezing Rain', true, 'rain'],
    ['Thunderstorms', true, 'storm'],
    ['Showers And Thunderstorms', false, 'storm'],
    ['Heavy Snow', true, 'snow'],
    ['Sleet', false, 'snow'],
    ['Snow Flurries', true, 'snow'],
    ['Rain And Snow', true, 'snow'],
    ['Patchy Fog', false, 'fog'],
    ['Haze', true, 'fog'],
    ['Windy', true, 'wind'],
    ['Breezy', false, 'wind'],
    ['Cloudy And Windy', true, 'wind'],
    ['THUNDERSTORMS', true, 'storm'],
    ['Something New', true, 'sun'],
    ['Something New', false, 'moon'],
  ] as const)('%s (daytime: %s) is %s', (summary, isDaytime, icon) => {
    expect(weatherIcon(summary, isDaytime)).toBe(icon);
  });
});

describe('NullWeatherSource', () => {
  test('always answers null', async () => {
    expect(await new NullWeatherSource().current(...OMAHA)).toBeNull();
  });
});
