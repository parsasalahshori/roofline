import { sql } from 'drizzle-orm';
import request from 'supertest';
import { beforeEach, describe, expect, test } from 'vitest';
import type { Clock } from '../src/clock.ts';
import { WeatherCache } from '../src/weather/cache.ts';
import type { CurrentWeather, WeatherSource } from '../src/weather/source.ts';
import { Actors, addressFor, inCompany, mustCreate } from './crm-helpers.ts';
import { FAKE_HOURLY, FAKE_WEATHER, FakeWeatherSource, makeTestApp, type TestApp } from './helpers.ts';

const MINUTE = 60_000;

let t: TestApp;
let who: Actors;

/** Draws a service area: a box from (west, south) to (east, north). */
function setServiceArea(companyId: string, box: { west: number; south: number; east: number; north: number }) {
  const { west, south, east, north } = box;
  const ring = `${west} ${south},${east} ${south},${east} ${north},${west} ${north},${west} ${south}`;
  return inCompany(t, companyId, (tx) =>
    tx.execute(
      sql`update companies set service_area = ST_Multi(ST_GeomFromText(${`POLYGON((${ring}))`}, 4326)) where id = ${companyId}`,
    ),
  );
}

/** Omaha, roughly: centre (-96.05, 41.27). */
const OMAHA_BOX = { west: -96.2, south: 41.17, east: -95.9, north: 41.37 };

const A = () => t.seed.a.companyId;
const B = () => t.seed.b.companyId;

/** Saves addresses with pins for a company, as its owner would. */
async function addPins(company: 'a' | 'b', pins: { lat: number; lng: number }[]) {
  const owner = await who.as('owner', company);
  const ids: string[] = [];
  for (const [i, pin] of pins.entries()) {
    ids.push((await mustCreate(owner, '/api/properties', { ...addressFor(i + (company === 'a' ? 0 : 50)), ...pin })).id);
  }
  return ids;
}

describe('GET /api/weather', () => {
  beforeEach(async () => {
    t = await makeTestApp();
    who = new Actors(t);
    t.clock.set(new Date('2026-10-12T15:00:00.000Z'));
  });

  test('needs a session', async () => {
    await setServiceArea(A(), OMAHA_BOX);
    const res = await request(t.app).get('/api/weather');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Please sign in.' });
    expect(t.weather.calls).toHaveLength(0);
  });

  test('is null without a location and makes no call', async () => {
    const owner = await who.as('owner');
    for (let i = 0; i < 2; i++) {
      const res = await owner.get('/api/weather');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ weather: null });
    }
    expect(t.weather.calls).toEqual([]);
  });

  test('uses the service area, then caches for 30 minutes', async () => {
    await setServiceArea(A(), OMAHA_BOX);
    const owner = await who.as('owner');

    const first = await owner.get('/api/weather');
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ weather: FAKE_WEATHER });
    expect(t.weather.calls).toHaveLength(1);
    // A point inside the box (for a box, its middle).
    const { lat, lng } = t.weather.calls[0]!;
    expect(lat).toBeCloseTo(41.27, 1);
    expect(lng).toBeCloseTo(-96.05, 1);

    const second = await owner.get('/api/weather');
    expect(second.body).toEqual({ weather: FAKE_WEATHER });
    expect(t.weather.calls).toHaveLength(1);

    t.clock.advance(29 * MINUTE);
    await owner.get('/api/weather');
    expect(t.weather.calls).toHaveLength(1);

    t.clock.advance(2 * MINUTE); // 31 minutes in
    const later = await owner.get('/api/weather');
    expect(later.body).toEqual({ weather: FAKE_WEATHER });
    expect(t.weather.calls).toHaveLength(2);
    expect(t.weather.calls[1]).toEqual(t.weather.calls[0]);
  });

  test('shows what the source says right now: a new answer replaces the old one after the cache expires', async () => {
    await setServiceArea(A(), OMAHA_BOX);
    const owner = await who.as('owner');
    await owner.get('/api/weather');
    const stormy: CurrentWeather = { tempF: 58, summary: 'Thunderstorms', icon: 'storm', isDaytime: true, updatedAt: '2026-10-12T16:00:00.000Z' };
    t.weather.value = stormy;
    expect((await owner.get('/api/weather')).body).toEqual({ weather: FAKE_WEATHER });
    t.clock.advance(31 * MINUTE);
    expect((await owner.get('/api/weather')).body).toEqual({ weather: stormy });
  });

  test('caches a failure too', async () => {
    await setServiceArea(A(), OMAHA_BOX);
    t.weather.value = null;
    const owner = await who.as('owner');

    const first = await owner.get('/api/weather');
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ weather: null });
    expect(t.weather.calls).toHaveLength(1);

    const second = await owner.get('/api/weather');
    expect(second.body).toEqual({ weather: null });
    expect(t.weather.calls).toHaveLength(1);

    // The service comes back: it is asked again once the 30 minutes are up, not before.
    t.weather.value = FAKE_WEATHER;
    t.clock.advance(31 * MINUTE);
    expect((await owner.get('/api/weather')).body).toEqual({ weather: FAKE_WEATHER });
    expect(t.weather.calls).toHaveLength(2);
    expect(t.logged).toEqual([]);
  });

  test('any signed-in member can read it, and they share the company cache', async () => {
    await setServiceArea(A(), OMAHA_BOX);
    for (const member of ['owner', 'office', 'rep'] as const) {
      const res = await (await who.as(member)).get('/api/weather');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ weather: FAKE_WEATHER });
    }
    expect(t.weather.calls).toHaveLength(1);
  });

  test('an unexpected failure of the source is logged once and answered as no weather, not an error', async () => {
    await setServiceArea(A(), OMAHA_BOX);
    const boom = new Error('boom');
    t.weather.failure = boom;
    const owner = await who.as('owner');
    const res = await owner.get('/api/weather');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ weather: null });
    expect(t.logged).toEqual([{ err: boom, where: 'weather' }]);
    // Nothing about the failure is on the screen or in the body.
    expect(JSON.stringify(res.body)).not.toContain('boom');

    // A failure that threw is not remembered: the next look asks again, and a good answer is shown.
    t.weather.failure = undefined;
    expect((await owner.get('/api/weather')).body).toEqual({ weather: FAKE_WEATHER });
    expect(t.weather.calls).toHaveLength(2);
    expect(t.logged).toHaveLength(1);
  });

  describe('where the company is', () => {
    test('with no service area, the middle of its located, active addresses', async () => {
      await addPins('a', [
        { lat: 41, lng: -96 },
        { lat: 43, lng: -95 },
      ]);
      const owner = await who.as('owner');
      expect((await owner.get('/api/weather')).body).toEqual({ weather: FAKE_WEATHER });
      expect(t.weather.calls).toHaveLength(1);
      expect(t.weather.calls[0]!.lat).toBeCloseTo(42, 1);
      expect(t.weather.calls[0]!.lng).toBeCloseTo(-95.5, 1);
    });

    test('archived addresses, addresses with no pin and the other company’s do not count', async () => {
      const [, far] = await addPins('a', [
        { lat: 41, lng: -96 },
        { lat: 48, lng: -120 },
      ]);
      const owner = await who.as('owner');
      await owner.post(`/api/properties/${far}/archive`);
      await mustCreate(owner, '/api/properties', { ...addressFor(9) }); // no pin
      await addPins('b', [{ lat: 30, lng: -90 }]);

      await owner.get('/api/weather');
      expect(t.weather.calls).toHaveLength(1);
      expect(t.weather.calls[0]!.lat).toBeCloseTo(41, 1);
      expect(t.weather.calls[0]!.lng).toBeCloseTo(-96, 1);
    });

    test('a rep gets the company’s location, not one built from only the addresses they can see', async () => {
      // Pins saved by the owner with no customer or job: a rep cannot see any of them.
      await addPins('a', [
        { lat: 41, lng: -96 },
        { lat: 43, lng: -94 },
      ]);
      const rep = await who.as('rep');
      expect((await rep.get('/api/properties')).body).toMatchObject({ properties: [], total: 0 });
      expect((await rep.get('/api/weather')).body).toEqual({ weather: FAKE_WEATHER });
      expect(t.weather.calls[0]!.lat).toBeCloseTo(42, 1);
      expect(t.weather.calls[0]!.lng).toBeCloseTo(-95, 1);
    });

    test('the service area wins over the addresses', async () => {
      await addPins('a', [{ lat: 30, lng: -90 }]);
      await setServiceArea(A(), OMAHA_BOX);
      await (await who.as('owner')).get('/api/weather');
      expect(t.weather.calls[0]!.lat).toBeCloseTo(41.27, 1);
      expect(t.weather.calls[0]!.lng).toBeCloseTo(-96.05, 1);
    });

    test('each company has its own location and its own cache entry', async () => {
      await setServiceArea(A(), OMAHA_BOX);
      // Company B has nothing yet: no location, no call, even though A's weather is cached.
      const b = await who.as('owner', 'b');
      const a = await who.as('owner', 'a');
      await a.get('/api/weather');
      expect((await b.get('/api/weather')).body).toEqual({ weather: null });
      expect(t.weather.calls).toHaveLength(1);

      // The same place for B is still its own lookup.
      await setServiceArea(B(), OMAHA_BOX);
      expect((await b.get('/api/weather')).body).toEqual({ weather: FAKE_WEATHER });
      expect(t.weather.calls).toHaveLength(2);
    });
  });
});

/** A clock the test moves by hand. */
function handClock(start = 0): Clock & { advance(ms: number): void } {
  let now = start;
  return {
    now: () => new Date(now),
    advance(ms) {
      now += ms;
    },
  };
}

/** A source that waits for the test to answer each call. */
function deferredSource() {
  const calls: { lat: number; lng: number; settle: { resolve(w: CurrentWeather | null): void; reject(e: unknown): void } }[] = [];
  const source: WeatherSource = {
    current: (lat, lng) =>
      new Promise((resolve, reject) => {
        calls.push({ lat, lng, settle: { resolve, reject } });
      }),
    hourly: async () => null,
  };
  return { source, calls };
}

describe('WeatherCache', () => {
  test('keeps an answer for 30 minutes, to the millisecond', async () => {
    const clock = handClock(1_000);
    const calls: number[] = [];
    const source: WeatherSource = {
      current: async () => {
        calls.push(clock.now().getTime());
        return FAKE_WEATHER;
      },
      hourly: async () => null,
    };
    const cache = new WeatherCache(source, clock);
    expect(await cache.get('k', 1, 2)).toEqual(FAKE_WEATHER);
    clock.advance(30 * MINUTE - 1);
    await cache.get('k', 1, 2);
    expect(calls).toHaveLength(1);
    clock.advance(1);
    await cache.get('k', 1, 2);
    expect(calls).toHaveLength(2);
  });

  test('the time to live counts from when the answer arrived, not from when it was asked for', async () => {
    const clock = handClock();
    const { source, calls } = deferredSource();
    const cache = new WeatherCache(source, clock, 10 * MINUTE);
    const pending = cache.get('k', 1, 2);
    clock.advance(4 * MINUTE); // a slow service
    calls[0]!.settle.resolve(FAKE_WEATHER);
    await pending;
    clock.advance(9 * MINUTE); // 13 minutes after the question, 9 after the answer
    await cache.get('k', 1, 2);
    expect(calls).toHaveLength(1);
  });

  test('a different key is a different entry; the key, not the exact place, decides', async () => {
    const clock = handClock();
    const seen: [number, number][] = [];
    const cache = new WeatherCache(
      { current: async (lat, lng) => (seen.push([lat, lng]), FAKE_WEATHER), hourly: async () => null },
      clock,
    );
    await cache.get('a:41.27,-96.05', 41.2701, -96.0501);
    await cache.get('a:41.27,-96.05', 41.2699, -96.0499);
    await cache.get('b:41.27,-96.05', 41.2701, -96.0501);
    expect(seen).toEqual([
      [41.2701, -96.0501],
      [41.2701, -96.0501],
    ]);
  });

  test('misses at the same time share one call', async () => {
    const { source, calls } = deferredSource();
    const cache = new WeatherCache(source, handClock());
    const all = [cache.get('k', 1, 2), cache.get('k', 1, 2), cache.get('k', 1, 2)];
    expect(calls).toHaveLength(1);
    calls[0]!.settle.resolve(FAKE_WEATHER);
    expect(await Promise.all(all)).toEqual([FAKE_WEATHER, FAKE_WEATHER, FAKE_WEATHER]);
    await cache.get('k', 1, 2);
    expect(calls).toHaveLength(1);
  });

  test('a null answer is kept like any other, and shared while it is in flight', async () => {
    const { source, calls } = deferredSource();
    const cache = new WeatherCache(source, handClock());
    const both = [cache.get('k', 1, 2), cache.get('k', 1, 2)];
    calls[0]!.settle.resolve(null);
    expect(await Promise.all(both)).toEqual([null, null]);
    expect(await cache.get('k', 1, 2)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  test('a source that throws is not remembered; only the caller that caused the miss sees the error', async () => {
    const { source, calls } = deferredSource();
    const cache = new WeatherCache(source, handClock());
    const boom = new Error('boom');
    const first = cache.get('k', 1, 2);
    const joined = cache.get('k', 1, 2);
    calls[0]!.settle.reject(boom);
    await expect(first).rejects.toBe(boom);
    expect(await joined).toBeNull();

    const retry = cache.get('k', 1, 2);
    expect(calls).toHaveLength(2);
    calls[1]!.settle.resolve(FAKE_WEATHER);
    expect(await retry).toEqual(FAKE_WEATHER);
  });
});

describe('FakeWeatherSource.hourly', () => {
  test('records the call and returns the first `hours` entries as copies', async () => {
    const fake = new FakeWeatherSource();
    const got = await fake.hourly(41.27, -96.05, 2);
    expect(fake.hourlyCalls).toEqual([{ lat: 41.27, lng: -96.05, hours: 2 }]);
    expect(got).toEqual(FAKE_HOURLY.slice(0, 2));
    expect(got).not.toBe(fake.hourlyValue);
    got![0]!.precipPct = 99;
    expect(fake.hourlyValue![0]!.precipPct).toBe(FAKE_HOURLY[0]!.precipPct);
  });

  test('returns null when hourlyValue is null', async () => {
    const fake = new FakeWeatherSource();
    fake.hourlyValue = null;
    expect(await fake.hourly(41.27, -96.05, 3)).toBeNull();
    expect(fake.hourlyCalls).toHaveLength(1);
  });
});
