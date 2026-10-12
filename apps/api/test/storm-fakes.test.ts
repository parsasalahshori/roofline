import { describe, expect, test } from 'vitest';
import { AdPlatformError } from '../src/providers/ads-google.ts';
import { FakeAdImageRenderer } from '../src/providers/fakes/ad-image.ts';
import { FakeAdsGoogle } from '../src/providers/fakes/ads-google.ts';
import { FakeAdsMeta } from '../src/providers/fakes/ads-meta.ts';
import { FakeBroadcastMailer } from '../src/providers/fakes/broadcast.ts';
import { FakeGeocoder } from '../src/providers/fakes/geocoder.ts';
import { GeocoderUnavailableError } from '../src/providers/geocoder.ts';
import { GeocodioGeocoder } from '../src/providers/geocodio.ts';

const circle = { lat: 41, lng: -96, radiusM: 5000 };
function base(accountId: string, nameTag: string) {
  return { accountId, nameTag, dailyBudgetCents: 2000, startDate: '2026-05-01', endDate: '2026-05-08', circles: [circle],
    landingUrl: 'https://x.test/storm/abc', headline: 'h', description: 'd', companyName: 'Acme', city: 'Omaha' };
}
function create(accountId: string, nameTag: string) {
  return { ...base(accountId, nameTag), keywords: ['roof'] };
}
function metaCreate(accountId: string, nameTag: string, housing: boolean) {
  return { ...base(accountId, nameTag), primaryText: 'p', imagePng: new Uint8Array([1]), housing };
}

describe('FakeAdsGoogle', () => {
  test('invite leaves the link pending until accept', async () => {
    const g = new FakeAdsGoogle();
    expect(await g.linkStatus('c1')).toBe('none');
    await g.invite('c1');
    expect(await g.linkStatus('c1')).toBe('pending');
    g.accept('c1');
    expect(await g.linkStatus('c1')).toBe('active');
  });

  test('campaigns are g-1, g-2, created paused, and findCampaign finds them by tag', async () => {
    const g = new FakeAdsGoogle();
    expect((await g.createCampaign(create('c1', 'Roofline storm s1 google'))).campaignId).toBe('g-1');
    expect((await g.createCampaign(create('c1', 'other'))).campaignId).toBe('g-2');
    expect(await g.findCampaign('c1', 'Roofline storm s1 google')).toBe('g-1');
    expect(await g.findCampaign('c1', 'nope')).toBeNull();
    expect((await g.stats('c1', 'g-1')).status).toBe('paused');
  });

  test('setSpend feeds stats and setStatus flips status', async () => {
    const g = new FakeAdsGoogle();
    await g.createCampaign(create('c1', 't'));
    g.setSpend('g-1', 4200);
    expect(await g.stats('c1', 'g-1')).toMatchObject({ spendCents: 4200, impressions: 42000, clicks: 84, status: 'paused' });
    await g.setStatus('c1', 'g-1', 'active');
    expect((await g.stats('c1', 'g-1')).status).toBe('active');
  });

  test('failNext(kind) fails the next call with that kind, once', async () => {
    const g = new FakeAdsGoogle();
    g.failNext('payment');
    const err = await g.accountInfo('c1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdPlatformError);
    expect((err as AdPlatformError).kind).toBe('payment');
    expect(await g.accountInfo('c1')).toEqual({ name: 'Fake Ads c1', currency: 'USD' });
  });

  test('calls are recorded', async () => {
    const g = new FakeAdsGoogle();
    await g.invite('c1');
    await g.linkStatus('c1');
    await g.createCampaign(create('c1', 't'));
    await g.stats('c1', 'g-1');
    expect(g.calls.map((c) => c.method)).toEqual(['invite', 'linkStatus', 'createCampaign', 'stats']);
  });
});

describe('FakeAdsMeta', () => {
  test('verifyAccess is not_shared until share', async () => {
    const m = new FakeAdsMeta();
    expect(await m.verifyAccess('a1')).toEqual({ ok: false, reason: 'not_shared' });
    m.share('a1');
    expect(await m.verifyAccess('a1')).toMatchObject({ ok: true, currency: 'USD' });
  });

  test('requireHousingNext makes the next non-housing create throw targeting', async () => {
    const m = new FakeAdsMeta();
    m.requireHousingNext();
    const err = await m.createCampaign(metaCreate('a1', 't', false)).catch((e: unknown) => e);
    expect((err as AdPlatformError).kind).toBe('targeting');
    expect((await m.createCampaign(metaCreate('a1', 't', false))).campaignId).toBe('m-1');
    m.requireHousingNext();
    expect((await m.createCampaign(metaCreate('a1', 't2', true))).campaignId).toBe('m-2');
    expect((await m.createCampaign(metaCreate('a1', 't3', false))).campaignId).toBe('m-3');
  });

  test('campaigns are m-<n> and findCampaign finds them', async () => {
    const m = new FakeAdsMeta();
    await m.createCampaign(metaCreate('a1', 'tag', true));
    expect(await m.findCampaign('a1', 'tag')).toBe('m-1');
    expect(await m.findCampaign('a1', 'x')).toBeNull();
  });

  test('setSpend feeds stats', async () => {
    const m = new FakeAdsMeta();
    await m.createCampaign(metaCreate('a1', 'tag', true));
    m.setSpend('m-1', 100);
    await m.setStatus('a1', 'm-1', 'active');
    expect(await m.stats('a1', 'm-1')).toEqual({ spendCents: 100, impressions: 1000, clicks: 2, status: 'active' });
  });
});

describe('FakeBroadcastMailer and FakeAdImageRenderer', () => {
  test('records sent mail and returns message ids', async () => {
    const b = new FakeBroadcastMailer();
    const mail = { to: 'a@x.test', from: 'f@x.test', replyTo: null, subject: 's', text: 't', html: 'h', unsubscribeUrl: 'u', tag: 'g' };
    expect((await b.send(mail)).messageId).toBe('bm-1');
    expect((await b.send(mail)).messageId).toBe('bm-2');
    expect(b.sent.length).toBe(2);
  });

  test('returns the 8-byte PNG signature', async () => {
    const r = new FakeAdImageRenderer();
    const png = await r.card({ companyName: 'A', line: 'l', colorHex: '#000000' });
    expect(Array.from(png)).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(png.length).toBe(8);
  });
});

describe('FakeGeocoder.reverseMany', () => {
  test('`<n> Fake St` and null for lat < 0', async () => {
    const g = new FakeGeocoder();
    const out = await g.reverseMany([{ lat: 41, lng: -96 }, { lat: -1, lng: -96 }, { lat: 41.1, lng: -96 }]);
    expect(out).toEqual([
      { street: '1 Fake St', city: 'Omaha', state: 'NE', zip: '68102' },
      null,
      { street: '3 Fake St', city: 'Omaha', state: 'NE', zip: '68102' },
    ]);
  });

  test('records the call', async () => {
    const g = new FakeGeocoder();
    const pts = [{ lat: 41, lng: -96 }];
    await g.reverseMany(pts);
    expect(g.calls).toEqual([{ method: 'reverseMany', args: [pts] }]);
  });
});

describe('GeocodioGeocoder.reverseMany', () => {
  const entry = { response: { results: [{ address_components: { number: '1', formatted_street: 'Main St', city: 'Omaha', state: 'NE', zip: '68102' } }] } };
  function stub(answer: (n: number) => unknown) {
    const calls: { url: string; method: string | undefined; body: string[] }[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as string[];
      calls.push({ url: String(input), method: init?.method, body });
      return new Response(JSON.stringify(answer(body.length)), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    return { geocoder: new GeocodioGeocoder({ apiKey: 'k', fetch: fetchFn, baseUrl: 'https://geo.test/v1' }), calls };
  }

  test('posts lat,lng strings to /reverse and maps results', async () => {
    const { geocoder, calls } = stub(() => ({ results: [entry, { response: { results: [] } }] }));
    const out = await geocoder.reverseMany([{ lat: 41.2, lng: -96.1 }, { lat: 41.3, lng: -96.2 }]);
    expect(calls.length).toBe(1);
    expect(calls[0]?.url).toContain('/reverse');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toEqual(['41.2,-96.1', '41.3,-96.2']);
    expect(out).toEqual([{ street: '1 Main St', city: 'Omaha', state: 'NE', zip: '68102' }, null]);
  });

  test('chunks 2500 points into 3 calls of 1000, 1000, 500', async () => {
    const { geocoder, calls } = stub((n) => ({ results: Array.from({ length: n }, () => entry) }));
    const out = await geocoder.reverseMany(Array.from({ length: 2500 }, (_, i) => ({ lat: 40 + i / 10000, lng: -96 })));
    expect(calls.map((c) => c.body.length)).toEqual([1000, 1000, 500]);
    expect(out.length).toBe(2500);
  });

  test('an empty list makes no request', async () => {
    const { geocoder, calls } = stub(() => ({ results: [] }));
    expect(await geocoder.reverseMany([])).toEqual([]);
    expect(calls.length).toBe(0);
  });

  test('a non-list response throws GeocoderUnavailableError', async () => {
    const { geocoder } = stub(() => ({ nope: true }));
    await expect(geocoder.reverseMany([{ lat: 1, lng: 1 }])).rejects.toBeInstanceOf(GeocoderUnavailableError);
  });
});
