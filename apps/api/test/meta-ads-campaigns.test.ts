import { describe, expect, test } from 'vitest';
import type { Config } from '../src/config.ts';
import { AdPlatformError } from '../src/providers/ads-google.ts';
import type { MetaCreate } from '../src/providers/ads-meta.ts';
import { createCampaign, daysBetween, findCampaign, metaRadiusMiles, setStatus } from '../src/providers/meta/campaigns.ts';
import { metaAdsFor } from '../src/providers/meta/index.ts';
import type { MetaHttp } from '../src/providers/meta/http.ts';
import { fixture } from './meta-helpers.ts';

/*
 * The Meta campaign package, against a hand-built fake MetaHttp. Nothing here reaches Meta:
 * the fake records each call and answers by path, and no test imports createMetaHttp.
 */

type Call = { method: 'GET' | 'POST'; path: string; query?: Record<string, string>; body?: Record<string, unknown> | FormData };

/** Answers are keyed by path; an Error answer is thrown instead of returned. */
function fakeHttp(answers: Record<string, unknown>) {
  const calls: Call[] = [];
  const answer = (call: Call): unknown => {
    calls.push(call);
    if (!Object.prototype.hasOwnProperty.call(answers, call.path)) {
      throw new Error(`no fake answer for ${call.method} ${call.path}`);
    }
    const found = answers[call.path];
    if (found instanceof Error) throw found;
    return found;
  };
  const http: MetaHttp = {
    async get(path, query) {
      return answer({ method: 'GET', path, query });
    },
    async post(path, body) {
      return answer({ method: 'POST', path, body });
    },
  };
  return { http, calls };
}

const json = <T>(name: string): T => JSON.parse(fixture(name)) as T;

const BASE_CREATE: MetaCreate = {
  accountId: 'act_111',
  nameTag: 'Roofline storm cs-1 meta',
  dailyBudgetCents: 5000,
  startDate: '2026-10-13',
  endDate: '2026-10-15',
  circles: [{ lat: 35.12345, lng: -97.5, radiusM: 8046.72 }],
  landingUrl: 'https://example.test/storm/abc',
  headline: 'Free hail damage check',
  description: 'No-obligation inspection after the storm.',
  companyName: 'Acme Roofing',
  city: 'Oklahoma City',
  primaryText: 'Hail hit Oklahoma City this week. Ask Acme Roofing for a free roof check.',
  imagePng: new Uint8Array([1, 2, 3]),
  housing: false,
};

function happyAnswers(): Record<string, unknown> {
  return {
    'act_111/adimages': json('adimages.json'),
    'act_111/campaigns': json('campaign-create.json'),
    'act_111/adsets': json('adset-create.json'),
    'act_111/adcreatives': json('creative-create.json'),
    'act_111/ads': json('ad-create.json'),
  };
}

function bodyOf(calls: Call[], path: string): Record<string, unknown> {
  const call = calls.find((c) => c.method === 'POST' && c.path === path);
  if (!call || !call.body || call.body instanceof FormData) throw new Error(`no JSON body posted to ${path}`);
  return call.body;
}

describe('metaRadiusMiles', () => {
  test('converts metres to miles rounded to one decimal', () => {
    expect(metaRadiusMiles(8046.72)).toBe(5);
    expect(metaRadiusMiles(24140.16)).toBe(15);
  });

  test('never goes below one mile', () => {
    expect(metaRadiusMiles(100)).toBe(1);
    expect(metaRadiusMiles(0)).toBe(1);
  });
});

describe('daysBetween', () => {
  test('counts both end days inclusively', () => {
    expect(daysBetween('2026-10-13', '2026-10-15')).toBe(3);
    expect(daysBetween('2026-10-13', '2026-10-13')).toBe(1);
  });

  test('uses UTC calendar math across a month boundary', () => {
    expect(daysBetween('2026-10-30', '2026-11-02')).toBe(4);
  });

  test('has a minimum of one day', () => {
    expect(daysBetween('2026-10-15', '2026-10-13')).toBe(1);
  });
});

describe('createCampaign request bodies', () => {
  test('bodies match the fixtures for one fixed input', async () => {
    const { http, calls } = fakeHttp(happyAnswers());
    const result = await createCampaign(http, BASE_CREATE);

    expect(result).toEqual({ campaignId: '120000001' });
    expect(bodyOf(calls, 'act_111/campaigns')).toEqual(json('body-campaign.json'));
    expect(bodyOf(calls, 'act_111/adsets')).toEqual(json('body-adset.json'));
    expect(bodyOf(calls, 'act_111/adcreatives')).toEqual(json('body-creative.json'));
    expect(bodyOf(calls, 'act_111/ads')).toEqual(json('body-ad.json'));
  });

  test('the image upload is a PNG blob named ad.png with the input bytes', async () => {
    const { http, calls } = fakeHttp(happyAnswers());
    await createCampaign(http, BASE_CREATE);

    const upload = calls.find((c) => c.path === 'act_111/adimages');
    expect(upload?.method).toBe('POST');
    const form = upload?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const file = form.get('filename') as File;
    expect(file).toBeInstanceOf(Blob);
    expect(file.name).toBe('ad.png');
    expect(file.type).toBe('image/png');
    expect(Array.from(new Uint8Array(await file.arrayBuffer()))).toEqual([1, 2, 3]);
  });

  test('the image hash from the upload is the creative image_hash', async () => {
    const { http, calls } = fakeHttp({ ...happyAnswers(), 'act_111/adimages': { images: { 'ad.png': { hash: 'other-hash' } } } });
    await createCampaign(http, BASE_CREATE);
    const creative = bodyOf(calls, 'act_111/adcreatives') as { object_story_spec: { link_data: { image_hash: string } } };
    expect(creative.object_story_spec.link_data.image_hash).toBe('other-hash');
  });

  test('a missing image hash fails as other and posts nothing further', async () => {
    const { http, calls } = fakeHttp({ ...happyAnswers(), 'act_111/adimages': { images: {} } });
    await expect(createCampaign(http, BASE_CREATE)).rejects.toMatchObject({ kind: 'other' });
    expect(calls.map((c) => c.path)).toEqual(['act_111/adimages']);
  });

  test('the account id is normalised, with or without the act_ prefix', async () => {
    const bare = fakeHttp(happyAnswers());
    await createCampaign(bare.http, { ...BASE_CREATE, accountId: '111' });
    expect(bare.calls.map((c) => c.path)).toEqual([
      'act_111/adimages',
      'act_111/campaigns',
      'act_111/adsets',
      'act_111/adcreatives',
      'act_111/ads',
    ]);
  });
});

describe('createCampaign housing variant', () => {
  test('sends the HOUSING special category and one 15-mile circle at the centroid', async () => {
    const { http, calls } = fakeHttp(happyAnswers());
    await createCampaign(http, { ...BASE_CREATE, housing: true });

    expect(bodyOf(calls, 'act_111/campaigns')).toEqual(json('body-campaign-housing.json'));
    expect(bodyOf(calls, 'act_111/adsets')).toEqual(json('body-adset-housing.json'));
  });

  test('several circles collapse to one centroid circle of 15 miles', async () => {
    const { http, calls } = fakeHttp(happyAnswers());
    await createCampaign(http, {
      ...BASE_CREATE,
      housing: true,
      circles: [
        { lat: 35.0, lng: -97.0, radiusM: 1000 },
        { lat: 36.0, lng: -98.0, radiusM: 2000 },
      ],
    });
    const adset = bodyOf(calls, 'act_111/adsets') as {
      targeting: { geo_locations: { custom_locations: unknown[] }; age_min: number };
    };
    expect(adset.targeting.geo_locations.custom_locations).toEqual([
      { latitude: 35.5, longitude: -97.5, radius: 15, distance_unit: 'mile' },
    ]);
    expect(adset.targeting.age_min).toBe(25);
  });

  test('a non-housing create keeps one entry per input circle', async () => {
    const { http, calls } = fakeHttp(happyAnswers());
    await createCampaign(http, {
      ...BASE_CREATE,
      circles: [
        { lat: 35.12345, lng: -97.5, radiusM: 100 },
        { lat: 35.2, lng: -97.6, radiusM: 24140.16 },
      ],
    });
    const adset = bodyOf(calls, 'act_111/adsets') as {
      targeting: { geo_locations: { custom_locations: unknown[] } };
    };
    expect(adset.targeting.geo_locations.custom_locations).toEqual([
      { latitude: 35.12345, longitude: -97.5, radius: 1, distance_unit: 'mile' },
      { latitude: 35.2, longitude: -97.6, radius: 15, distance_unit: 'mile' },
    ]);
  });
});

describe('createCampaign budget and status', () => {
  test('lifetime_budget is daily cents times inclusive days', async () => {
    const { http, calls } = fakeHttp(happyAnswers());
    await createCampaign(http, { ...BASE_CREATE, dailyBudgetCents: 4321, startDate: '2026-10-01', endDate: '2026-10-04' });
    const adset = bodyOf(calls, 'act_111/adsets');
    expect(adset.lifetime_budget).toBe(4321 * 4);
    expect(adset.end_time).toBe('2026-10-04T23:59:59');
  });

  test('the campaign is created PAUSED as the one switch; the ad set and the ad are ACTIVE so they deliver once it is enabled', async () => {
    const { http, calls } = fakeHttp(happyAnswers());
    await createCampaign(http, BASE_CREATE);
    expect(bodyOf(calls, 'act_111/campaigns').status).toBe('PAUSED');
    expect(bodyOf(calls, 'act_111/adsets').status).toBe('ACTIVE');
    expect(bodyOf(calls, 'act_111/ads').status).toBe('ACTIVE');
  });

  test('the sequence posts in order: image, campaign, ad set, creative, ad', async () => {
    const { http, calls } = fakeHttp(happyAnswers());
    await createCampaign(http, BASE_CREATE);
    expect(calls.map((c) => c.path)).toEqual([
      'act_111/adimages',
      'act_111/campaigns',
      'act_111/adsets',
      'act_111/adcreatives',
      'act_111/ads',
    ]);
  });
});

describe('createCampaign errors', () => {
  test('the Housing-required error propagates as targeting and nothing else is posted', async () => {
    const { http, calls } = fakeHttp({
      ...happyAnswers(),
      'act_111/campaigns': new AdPlatformError('targeting', 400),
    });
    await expect(createCampaign(http, BASE_CREATE)).rejects.toMatchObject({ kind: 'targeting' });
    expect(calls.filter((c) => c.path === 'act_111/campaigns')).toHaveLength(1);
    expect(calls.some((c) => c.path === 'act_111/adsets')).toBe(false);
    expect(calls.some((c) => c.path === 'act_111/ads')).toBe(false);
    expect(calls.some((c) => c.path === '120000001')).toBe(false);
  });

  test('other provider errors pass through unchanged', async () => {
    const failure = new AdPlatformError('payment', 400);
    const { http, calls } = fakeHttp({ ...happyAnswers(), 'act_111/adsets': failure, '120000001': { success: true } });
    await expect(createCampaign(http, BASE_CREATE)).rejects.toBe(failure);
    expect(calls.some((c) => c.path === 'act_111/ads')).toBe(false);
    expect(calls.filter((c) => c.path === '120000001').map((c) => c.body)).toEqual([{ status: 'DELETED' }]);
  });

  test('empty circles fail as targeting before anything is posted', async () => {
    const { http, calls } = fakeHttp(happyAnswers());
    await expect(createCampaign(http, { ...BASE_CREATE, circles: [] })).rejects.toMatchObject({ kind: 'targeting' });
    expect(calls).toEqual([]);
  });

  test('a failing cleanup does not mask the original error', async () => {
    const failure = new AdPlatformError('payment', 400);
    const { http, calls } = fakeHttp({
      ...happyAnswers(),
      'act_111/adsets': failure,
      '120000001': new AdPlatformError('other', 500),
    });
    await expect(createCampaign(http, BASE_CREATE)).rejects.toBe(failure);
    expect(calls.filter((c) => c.method === 'POST' && c.path === '120000001')).toHaveLength(1);
  });

  test('a failure at the ad step also deletes the campaign', async () => {
    const { http, calls } = fakeHttp({
      ...happyAnswers(),
      'act_111/ads': new AdPlatformError('policy', 400),
      '120000001': { success: true },
    });
    await expect(createCampaign(http, BASE_CREATE)).rejects.toMatchObject({ kind: 'policy' });
    const cleanup = calls.filter((c) => c.method === 'POST' && c.path === '120000001');
    expect(cleanup).toHaveLength(1);
    expect(cleanup[0]?.body).toEqual({ status: 'DELETED' });
  });
});

describe('findCampaign', () => {
  test('returns the id on an exact name match and queries by CONTAIN', async () => {
    const { http, calls } = fakeHttp({ 'act_111/campaigns': json('campaign-search.json') });
    await expect(findCampaign(http, 'act_111', 'Roofline storm cs-1 meta')).resolves.toBe('120000001');

    const [call] = calls;
    expect(call?.method).toBe('GET');
    expect(call?.path).toBe('act_111/campaigns');
    expect(call?.query?.fields).toBe('id,name');
    expect(call?.query?.limit).toBe('25');
    expect(JSON.parse(call?.query?.filtering ?? 'null')).toEqual([
      { field: 'name', operator: 'CONTAIN', value: 'Roofline storm cs-1 meta' },
    ]);
  });

  test('returns null when the search is empty', async () => {
    const { http } = fakeHttp({ 'act_111/campaigns': json('campaign-search-empty.json') });
    await expect(findCampaign(http, 'act_111', 'Roofline storm cs-1 meta')).resolves.toBeNull();
  });

  test('returns null when only a longer name contains the tag', async () => {
    const { http } = fakeHttp({
      'act_111/campaigns': { data: [{ id: '120000009', name: 'Roofline storm cs-10 meta' }] },
    });
    await expect(findCampaign(http, 'act_111', 'Roofline storm cs-1 meta')).resolves.toBeNull();
  });
});

describe('setStatus', () => {
  test('posts ACTIVE for active and PAUSED for paused', async () => {
    const { http, calls } = fakeHttp({ '120000001': { success: true } });
    await setStatus(http, 'act_111', '120000001', 'active');
    await setStatus(http, 'act_111', '120000001', 'paused');

    expect(calls.map((c) => c.path)).toEqual(['120000001', '120000001']);
    expect(calls.map((c) => c.body)).toEqual([{ status: 'ACTIVE' }, { status: 'PAUSED' }]);
  });
});

describe('metaAdsFor', () => {
  const META = {
    META_APP_ID: 'app-1',
    META_APP_SECRET: 'secret-1',
    META_SYSTEM_USER_TOKEN: 'token-1',
    META_BUSINESS_ID: 'biz-1',
    META_GRAPH_VERSION: 'v24.0',
  };

  test('returns null when the META_* settings are absent', () => {
    expect(metaAdsFor({ ...META, META_APP_ID: undefined } as unknown as Config)).toBeNull();
    expect(metaAdsFor({ ...META, META_BUSINESS_ID: undefined } as unknown as Config)).toBeNull();
    expect(metaAdsFor({ META_GRAPH_VERSION: 'v24.0' } as unknown as Config)).toBeNull();
  });

  test('returns a configured adapter when every META_* setting is present', () => {
    const adapter = metaAdsFor(META as unknown as Config);
    expect(adapter).not.toBeNull();
    expect(adapter?.configured).toBe(true);
    expect(adapter?.businessId).toBe('biz-1');
  });
});
