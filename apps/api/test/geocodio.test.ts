import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { GeocodioGeocoder, geocodioFor } from '../src/providers/geocodio.ts';
import { GeocoderUnavailableError } from '../src/providers/geocoder.ts';

/*
 * The Geocodio adapter, against canned responses. Nothing here reaches the network: every test hands
 * the geocoder its own `fetch`, so a test that forgot to would fail on a missing route, not call geocod.io.
 */

const SINGLE = readFileSync(new URL('./fixtures/geocodio/single.json', import.meta.url), 'utf8');
const LOW_ACCURACY = readFileSync(new URL('./fixtures/geocodio/low-accuracy.json', import.meta.url), 'utf8');
const BATCH = readFileSync(new URL('./fixtures/geocodio/batch.json', import.meta.url), 'utf8');

const BASE = 'https://geo.test/v1';
const API_KEY = 'geo-secret-key';
const KEY = Buffer.alloc(32, 9).toString('base64');

const VALID = {
  NODE_ENV: 'production',
  APP_ORIGIN: 'https://app.roofline.test',
  DATABASE_URL_TENANT: 'postgres://app_tenant:pw@localhost:5432/roofline',
  DATABASE_URL_SYSTEM: 'postgres://app_system:pw@localhost:5432/roofline',
  ENCRYPTION_KEY: KEY,
  PUBLIC_BASE_URL: 'https://app.roofline.test',
  TRUST_PROXY: '1',
} satisfies Record<string, string>;

type Answer = {
  location: { lat: number; lng: number };
  accuracy: number;
  accuracy_type: string;
  address_components: { number: string; formatted_street: string; city: string; state: string; zip: string };
  fields: { timezone: { name: string } };
};
type Batch = { results: { query: string; response: { results: Answer[] } }[] };

const BATCH_TEMPLATE: Answer = (JSON.parse(BATCH) as Batch).results[0]?.response.results[0] ?? failMissingTemplate();

function failMissingTemplate(): never {
  throw new Error('batch.json has no template answer');
}

type Call = { url: string; init: RequestInit | undefined };

/** A `fetch` that answers from `answer` and records every request. */
function fakeFetch(answer: (url: string, init: RequestInit | undefined) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return answer(url, init);
  }) as typeof fetch;
  return { fetch: fn, calls };
}

function json(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

/** A `fetch` that never answers until the request's abort signal fires, then rejects the way fetch does. */
const hangingFetch = (async (_input: string | URL | Request, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
  })) as typeof fetch;

/** Answers a batch POST: one answer per body entry, its street number set to the index parsed from `addr N`. */
function batchAnswer(_url: string, init: RequestInit | undefined): Response {
  const body: unknown = JSON.parse(String(init?.body));
  if (!Array.isArray(body) || !body.every((q): q is string => typeof q === 'string')) return json('[]', 400);
  const answers = body.map((query) => {
    const item = structuredClone(BATCH_TEMPLATE);
    item.address_components.number = String(Number(/(\d+)$/.exec(query)?.[1]));
    return { query, response: { results: [item] } };
  });
  return json(JSON.stringify({ results: answers }));
}

describe('GeocodioGeocoder.geocode', () => {
  test('maps a rooftop answer to a GeocodeResult and asks for timezone with limit 1', async () => {
    const fake = fakeFetch(() => json(SINGLE));
    const geocoder = new GeocodioGeocoder({ apiKey: API_KEY, fetch: fake.fetch, baseUrl: BASE });

    const result = await geocoder.geocode('1200 Farnam St, Omaha, NE 68102');

    expect(result).toMatchObject({
      street: '1200 Farnam St',
      city: 'Omaha',
      state: 'NE',
      zip: '68102',
      timezone: 'America/Chicago',
      lng: -95.9345,
      lat: 41.2565,
      source: 'geocodio',
      accuracy: 1,
      accuracyType: 'rooftop',
    });
    expect(fake.calls).toHaveLength(1);
    const url = new URL(fake.calls[0]?.url ?? '');
    expect(url.href).toContain('fields=timezone');
    expect(url.href).toContain('limit=1');
    expect(url.searchParams.get('q')).toBe('1200 Farnam St, Omaha, NE 68102');
  });

  test('returns null for an answer below the accuracy floor', async () => {
    const fake = fakeFetch(() => json(LOW_ACCURACY));
    const geocoder = new GeocodioGeocoder({ apiKey: API_KEY, fetch: fake.fetch, baseUrl: BASE });

    expect(await geocoder.geocode('Omaha, NE')).toBeNull();
  });

  test('returns null for a 422 (the address cannot be parsed)', async () => {
    const fake = fakeFetch(() => json('{"error":"Could not parse address"}', 422));
    const geocoder = new GeocodioGeocoder({ apiKey: API_KEY, fetch: fake.fetch, baseUrl: BASE });

    expect(await geocoder.geocode('???')).toBeNull();
  });

  test('returns null for an empty results list', async () => {
    const fake = fakeFetch(() => json('{"results":[]}'));
    const geocoder = new GeocodioGeocoder({ apiKey: API_KEY, fetch: fake.fetch, baseUrl: BASE });

    expect(await geocoder.geocode('Nowhere Road')).toBeNull();
  });

  test('a 500 rejects with GeocoderUnavailableError and never leaks the key or the query string', async () => {
    const fake = fakeFetch(() => json('{"error":"server"}', 500));
    const geocoder = new GeocodioGeocoder({ apiKey: API_KEY, fetch: fake.fetch, baseUrl: BASE });

    const error = await geocoder.geocode('1200 Farnam St, Omaha, NE 68102').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GeocoderUnavailableError);
    expect((error as Error).message).not.toContain('api_key');
    expect((error as Error).message).not.toContain(API_KEY);
  });

  test('a 401 rejects with GeocoderUnavailableError', async () => {
    const fake = fakeFetch(() => json('{"error":"unauthorized"}', 401));
    const geocoder = new GeocodioGeocoder({ apiKey: API_KEY, fetch: fake.fetch, baseUrl: BASE });

    const error = await geocoder.geocode('1200 Farnam St').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GeocoderUnavailableError);
    expect((error as Error).message).not.toContain('api_key');
    expect((error as Error).message).not.toContain(API_KEY);
  });

  test('an unreadable body rejects with GeocoderUnavailableError', async () => {
    const fake = fakeFetch(() => json('not json'));
    const geocoder = new GeocodioGeocoder({ apiKey: API_KEY, fetch: fake.fetch, baseUrl: BASE });

    const error = await geocoder.geocode('1200 Farnam St').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GeocoderUnavailableError);
    expect((error as Error).message).not.toContain('api_key');
    expect((error as Error).message).not.toContain(API_KEY);
  });

  test('a timeout rejects with GeocoderUnavailableError and never leaks the key', async () => {
    const geocoder = new GeocodioGeocoder({ apiKey: API_KEY, fetch: hangingFetch, timeoutMs: 50, baseUrl: BASE });

    const error = await geocoder.geocode('1200 Farnam St').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GeocoderUnavailableError);
    expect((error as Error).message).not.toContain('api_key');
    expect((error as Error).message).not.toContain(API_KEY);
  });

  test('a per-call timeout overrides the default', async () => {
    const geocoder = new GeocodioGeocoder({ apiKey: API_KEY, fetch: hangingFetch, baseUrl: BASE });

    const started = Date.now();
    const error = await geocoder.geocode('x', { timeoutMs: 20 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GeocoderUnavailableError);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('GeocodioGeocoder.geocodeMany', () => {
  test('2,500 addresses go out as three POST chunks (1000, 1000, 500) and come back in input order', async () => {
    const fake = fakeFetch(batchAnswer);
    const geocoder = new GeocodioGeocoder({ apiKey: API_KEY, fetch: fake.fetch, baseUrl: BASE });
    const addresses = Array.from({ length: 2500 }, (_, i) => `addr ${i}`);

    const results = await geocoder.geocodeMany(addresses);

    expect(fake.calls.map((c) => c.init?.method)).toEqual(['POST', 'POST', 'POST']);
    for (const call of fake.calls) {
      expect(new Headers(call.init?.headers).get('content-type')).toBe('application/json');
    }
    const bodyLengths = fake.calls.map((c) => (JSON.parse(String(c.init?.body)) as unknown[]).length);
    expect(bodyLengths).toEqual([1000, 1000, 500]);

    expect(results).toHaveLength(2500);
    expect(results.map((r) => r?.street)).toEqual(addresses.map((_, i) => `${i} Farnam St`));
  });

  test('empty input returns [] and makes no request', async () => {
    const fake = fakeFetch(batchAnswer);
    const geocoder = new GeocodioGeocoder({ apiKey: API_KEY, fetch: fake.fetch, baseUrl: BASE });

    expect(await geocoder.geocodeMany([])).toEqual([]);
    expect(fake.calls).toHaveLength(0);
  });
});

describe('geocodioFor', () => {
  test('is null without GEOCODIO_API_KEY and a GeocodioGeocoder with it', () => {
    const config = loadConfig(VALID);
    expect(geocodioFor(config)).toBeNull();

    const keyed = geocodioFor({ ...config, GEOCODIO_API_KEY: 'geo-key' });
    expect(keyed).toBeInstanceOf(GeocodioGeocoder);
    expect(keyed?.configured).toBe(true);
  });
});
