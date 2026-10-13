import { describe, expect, test } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { createGeocoder } from '../src/providers/geocoder.ts';
import { DEMO_EXACT_REPORT_MS, DemoExactReports } from '../src/providers/fakes/demo-exact-reports.ts';
import { DemoGeocoder, FakeGeocoder } from '../src/providers/fakes/geocoder.ts';

const ADDRESS = { street: '4217 Prairie Wind Ln', city: 'Omaha', state: 'NE', zip: '68144' };

describe('the demo geocoder', () => {
  test('reverse geocodes a point to a plausible, fictional Omaha address, the same one every time', async () => {
    const geocoder = new DemoGeocoder();
    const [a, b, none] = await geocoder.reverseMany([
      { lat: 41.2611, lng: -96.0612 },
      { lat: 41.2611, lng: -96.0612 },
      { lat: -1, lng: 0 },
    ]);
    expect(a).toEqual(b);
    expect(a?.street).toMatch(/^\d{4,5} [A-Z][a-z]+( [A-Z][a-z]+)* (Dr|Ln|Ct|Ave|Rd|Cir|Way|Pl|St)$/);
    expect(a).toMatchObject({ city: 'Omaha', state: 'NE' });
    expect(a?.zip).toMatch(/^681\d\d$/);
    expect(a?.street).not.toContain('Fake');
    expect(none).toBeNull();
  });

  test('is the geocoder in DEMO_MODE; plain FAKE_PROVIDERS keeps the test fake', () => {
    const base = {
      NODE_ENV: 'development',
      APP_ORIGIN: 'http://localhost:4500',
      PUBLIC_BASE_URL: 'http://localhost:4500',
      DATABASE_URL_TENANT: 'postgres://t@localhost/x',
      DATABASE_URL_SYSTEM: 'postgres://s@localhost/x',
      ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
    };
    expect(createGeocoder(loadConfig({ ...base, DEMO_MODE: '1' }))).toBeInstanceOf(DemoGeocoder);
    const fake = createGeocoder(loadConfig({ ...base, FAKE_PROVIDERS: '1' }));
    expect(fake).toBeInstanceOf(FakeGeocoder);
    expect(fake).not.toBeInstanceOf(DemoGeocoder);
  });
});

describe('the demo exact reports', () => {
  test('a report is pending at first and complete about 20 seconds after it was ordered', async () => {
    let now = new Date('2026-10-13T18:00:00Z');
    const reports = new DemoExactReports(() => now);
    const input = { address: { street: ADDRESS.street, city: ADDRESS.city, state: ADDRESS.state, zip: ADDRESS.zip }, productId: 0, referenceId: 'r1' };
    const price = await reports.price(input);
    expect(price.maxCents).toBeGreaterThan(0);
    const { reportId } = await reports.order(input);
    const { reportId: other } = await reports.order(input);
    expect(other).not.toBe(reportId);
    expect(await reports.report(reportId)).toEqual({ status: 'pending' });
    now = new Date(now.getTime() + DEMO_EXACT_REPORT_MS);
    const done = await reports.report(reportId);
    expect(done.status).toBe('complete');
    // A fresh process (a worker restart) still completes it: the order time is in the id.
    expect((await new DemoExactReports(() => now).report(reportId)).status).toBe('complete');
  });
});
