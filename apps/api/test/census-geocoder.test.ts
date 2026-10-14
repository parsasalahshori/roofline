import { describe, expect, it, vi } from 'vitest';
import { loadConfig, type Config } from '../src/config.ts';
import { CensusDemoGeocoder, parseCensusResult } from '../src/providers/census.ts';
import { censusDemoEnabled, createGeocoder, GeocoderUnavailableError } from '../src/providers/geocoder.ts';
import { FakeGeocoder } from '../src/providers/fakes/geocoder.ts';

const match = {
  matchedAddress: '1600 PENNSYLVANIA AVE NW, WASHINGTON, DC, 20500',
  coordinates: { x: -77.035189204737, y: 38.898702605245 },
  addressComponents: { city: 'WASHINGTON', state: 'DC', zip: '20500' },
};
const body = { result: { addressMatches: [match] } };
const env = {
  NODE_ENV: 'test', APP_ORIGIN: 'http://localhost:4500', PUBLIC_BASE_URL: 'http://localhost:4500',
  DATABASE_URL_TENANT: 'postgres://tenant:test@localhost/db', DATABASE_URL_SYSTEM: 'postgres://system:test@localhost/db',
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
};

describe('opt-in public Census demo geocoder', () => {
  it('parses interpolated street coordinates without claiming rooftop accuracy', () => {
    expect(parseCensusResult(body)).toMatchObject({
      lng: match.coordinates.x, lat: match.coordinates.y, source: 'census', accuracyType: 'range_interpolation',
      street: '1600 PENNSYLVANIA AVE NW', state: 'DC', timezone: null,
    });
  });

  it('refuses ambiguous, missing, malformed and invalid-coordinate results', () => {
    for (const matches of [[], [match, match], [{ ...match, coordinates: { x: Infinity, y: 38 } }], [{ ...match, coordinates: { x: -77, y: 91 } }]]) {
      expect(parseCensusResult({ result: { addressMatches: matches } })).toBeNull();
    }
    expect(() => parseCensusResult({ error: 'upstream text' })).toThrow(GeocoderUnavailableError);
  });

  it('uses the fixed public endpoint, encoded address, timeout and no redirects', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body)));
    const result = await new CensusDemoGeocoder(request).geocode('1600 Pennsylvania Ave NW, Washington, DC 20500');
    expect(result?.accuracyType).toBe('range_interpolation');
    const url = new URL(String(request.mock.calls[0]![0]));
    expect(url.origin).toBe('https://geocoding.geo.census.gov');
    expect(url.pathname).toBe('/geocoder/locations/onelineaddress');
    expect(url.searchParams.get('benchmark')).toBe('Public_AR_Current');
    expect(url.searchParams.get('address')).toContain('1600 Pennsylvania');
    expect(request.mock.calls[0]![1]).toMatchObject({ redirect: 'error', signal: expect.any(AbortSignal) });
  });

  it('returns no match and sanitizes failed HTTP, malformed JSON and network errors', async () => {
    const noMatch = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ result: { addressMatches: [] } })));
    await expect(new CensusDemoGeocoder(noMatch).geocode('missing')).resolves.toBeNull();
    for (const request of [
      vi.fn<typeof fetch>().mockResolvedValue(new Response('provider secret text', { status: 503 })),
      vi.fn<typeof fetch>().mockResolvedValue(new Response('not json')),
      vi.fn<typeof fetch>().mockRejectedValue(new Error('provider address details')),
    ]) {
      await expect(new CensusDemoGeocoder(request).geocode('some address')).rejects.toThrow('Public address lookup is unavailable. Please try again.');
    }
  });

  it('keeps defaults fake and requires non-production demo plus fake-provider guard', () => {
    const ordinaryDemo = loadConfig({ ...env, DEMO_MODE: '1' });
    expect(createGeocoder(ordinaryDemo)).toBeInstanceOf(FakeGeocoder);
    const opted = loadConfig({ ...env, DEMO_MODE: '1', DEMO_GEOCODER: 'census' });
    expect(opted.FAKE_PROVIDERS).toBe(true);
    expect(createGeocoder(opted)).toBeInstanceOf(CensusDemoGeocoder);
    for (const config of [
      { ...opted, DEMO_MODE: false }, { ...opted, FAKE_PROVIDERS: false }, { ...opted, NODE_ENV: 'production' as const },
    ]) expect(censusDemoEnabled(config as Config)).toBe(false);
    expect(() => loadConfig({ ...env, DEMO_GEOCODER: 'census' })).toThrow(/DEMO_GEOCODER/);
    expect(() => loadConfig({ ...env, NODE_ENV: 'production', DEMO_MODE: '1', DEMO_MODE_ALLOW_PROD: '1', DEMO_GEOCODER: 'census' })).toThrow(/DEMO_GEOCODER/);
  });

  it('does not fabricate reverse-geocoded addresses', async () => {
    const request = vi.fn<typeof fetch>();
    await expect(new CensusDemoGeocoder(request).reverseMany([{ lat: 38, lng: -77 }])).resolves.toEqual([null]);
    expect(request).not.toHaveBeenCalled();
  });
});
