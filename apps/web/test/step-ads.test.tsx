import { cleanup, screen, waitFor } from '@testing-library/react';
import type { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stepTypes } from '@roofline/shared';
import type { StepView } from '../src/api/types.ts';
import { keys } from '../src/api/keys.ts';
import type { StormSummary } from '../src/features/storm/types.ts';
import { StepFieldsSheet } from '../src/features/approvals/StepFieldsSheet.tsx';
import { stepAds } from '../src/copy/stepAds.ts';
import { adCampaignKit, AdCampaignPreview } from '../src/features/approvals/steps/AdCampaignPreview.tsx';
import { renderAt, stubApi } from './helpers.tsx';

let api: ReturnType<typeof stubApi> | undefined;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  expect(api?.unexpected ?? []).toEqual([]);
  api = undefined;
});

const STORM = '7c2e8f10-4b6a-4d3e-9a5c-2f1e0d9c8b7a';
const PHOTO = '3f0b6a52-9c1d-4e7a-8b2f-5d6c7e8f9a01';
const OTHER_PHOTO = '5a1c9e3d-2b7f-4c8e-9d0a-6e4f2b1a0c3d';
const MAP_NAME = 'Map of the hail area the ads cover';

/** One square of hail in north Texas, as a Polygon feature. */
const SQUARE = {
  type: 'Feature',
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [-96.8, 32.78],
        [-96.7, 32.78],
        [-96.7, 32.85],
        [-96.8, 32.78],
      ],
    ],
  },
  properties: { thresholdIn: 1 },
};

/** Two polygons in one MultiPolygon feature; the first has a hole, which the map leaves out. */
const MULTI = {
  type: 'Feature',
  geometry: {
    type: 'MultiPolygon',
    coordinates: [
      [
        [
          [-96.6, 32.7],
          [-96.5, 32.7],
          [-96.5, 32.8],
          [-96.6, 32.7],
        ],
        [
          [-96.58, 32.72],
          [-96.55, 32.72],
          [-96.55, 32.75],
          [-96.58, 32.72],
        ],
      ],
      [
        [
          [-96.4, 32.7],
          [-96.3, 32.7],
          [-96.3, 32.8],
          [-96.4, 32.7],
        ],
      ],
    ],
  },
  properties: { thresholdIn: 1.5 },
};

const SUMMARY: StormSummary = {
  id: STORM,
  placeName: null,
  day: '2026-10-11',
  maxIn: 1.5,
  status: 'final',
  customersHit: 3,
  homesHit: 12,
  planTaskId: null,
  planStatus: null,
};

const ZERO_RESULTS = {
  textsSent: 0,
  textsDelivered: 0,
  replies: 0,
  yesReplies: 0,
  emailsSent: 0,
  unsubscribes: 0,
  doorsKnocked: 0,
  wantsCheck: 0,
  adSpendCents: 0,
  adMaxCents: 0,
  adClicks: 0,
  landingRequests: 0,
  inspectionsBooked: 0,
};

/** A create_ad_campaign step. The payload is the strict shape the server stores, plus the optional extras when given. */
function step(payload: Record<string, unknown> = {}, overrides: Partial<StepView> = {}): StepView {
  return {
    id: 's1',
    position: 1,
    type: 'create_ad_campaign',
    approvalClass: 'spend',
    enabled: true,
    version: 1,
    status: 'pending',
    preview: { title: 'Google ads on the hail area', lines: [], maxSpendCents: 15000 },
    canApprove: true,
    attempts: 0,
    result: null,
    errorPlain: null,
    payload: {
      companyStormId: STORM,
      platform: 'google',
      maxSpendCents: 15000,
      days: 7,
      headline: 'Hail damage? Free roof check',
      description: 'Local roofers on your street.',
      keywords: ['roof repair', 'hail damage'],
      ...payload,
    },
    ...overrides,
  };
}

/** Renders the preview with the storm read answered by `features` as its swath, under the query providers. */
function renderPreview(features: unknown[] = [SQUARE], canApprove = true, payload: Record<string, unknown> = {}) {
  api = stubApi({
    [`GET /api/storms/${STORM}`]: () => ({
      body: { storm: SUMMARY, swath: { type: 'FeatureCollection', features }, results: ZERO_RESULTS, plan: null },
    }),
  });
  return renderAt(<AdCampaignPreview step={step(payload)} canApprove={canApprove} />);
}

/** Waits until the storm read has answered, so the test ends with no request still in flight. */
async function settled(client: QueryClient) {
  await waitFor(() => expect(client.getQueryState(keys.storm(STORM))?.status).toBe('success'));
}

describe('the ad campaign preview', () => {
  it('shows the approved maximum prominently and the daily amount with the days', async () => {
    const { queryClient } = renderPreview();
    expect(screen.getByText('Up to $150')).toBeTruthy();
    // floor(15000 / 7) = 2142 cents a day
    expect(screen.getByText('$21.42 a day for 7 days')).toBeTruthy();
    expect(screen.getByText('Search ads')).toBeTruthy();
    expect(screen.getByText('Hail damage? Free roof check')).toBeTruthy();
    expect(screen.getByText('Local roofers on your street.')).toBeTruthy();
    expect(screen.getByText('roof repair')).toBeTruthy();
    expect(screen.getByText('hail damage')).toBeTruthy();
    await settled(queryClient);
  });

  it('labels the hail area as radar-estimated', async () => {
    const { queryClient } = renderPreview();
    expect(await screen.findByText('Radar-estimated hail area')).toBeTruthy();
    await settled(queryClient);
  });

  it('draws the storm swath as an image with one path per outer ring', async () => {
    const { queryClient } = renderPreview([SQUARE, MULTI]);
    const image = await screen.findByRole('img', { name: MAP_NAME });
    // one for the square, and one for each of the two MultiPolygon outlines (not the hole)
    expect(image.querySelectorAll('path')).toHaveLength(3);
    await settled(queryClient);
  });

  it('draws no map when the swath has no usable outline', async () => {
    const point = { type: 'Feature', geometry: { type: 'Point', coordinates: [-96.8, 32.78] }, properties: { thresholdIn: 1 } };
    const short = {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-96.8, 32.78],
            [-96.7, 32.78],
          ],
        ],
      },
      properties: { thresholdIn: 1 },
    };
    const malformed = {
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            ['west', 32.78],
            [-96.7, 32.78],
            [-96.7, 32.85],
          ],
        ],
      },
      properties: { thresholdIn: 1 },
    };
    const { queryClient } = renderPreview([point, short, malformed]);
    await settled(queryClient);
    expect(screen.queryByRole('img', { name: MAP_NAME })).toBeNull();
    expect(screen.queryByText('Radar-estimated hail area')).toBeNull();
  });

  it('tells an office user that only the owner can approve the spending', async () => {
    const { queryClient } = renderPreview([SQUARE], false);
    expect(screen.getByText('Only the owner can approve spending')).toBeTruthy();
    await settled(queryClient);
  });

  it('does not tell the owner that only the owner can approve', async () => {
    const { queryClient } = renderPreview([SQUARE], true);
    expect(screen.queryByText('Only the owner can approve spending')).toBeNull();
    await settled(queryClient);
  });

  it('shows the main text and no keywords for a Facebook and Instagram campaign', async () => {
    const meta = { platform: 'meta', keywords: undefined, primaryText: 'Hail hit your street. Get a free check.' };
    const { queryClient } = renderPreview([SQUARE], true, meta);
    expect(screen.getByText('Social media ads')).toBeTruthy();
    expect(screen.getByText('Hail hit your street. Get a free check.')).toBeTruthy();
    expect(screen.queryByText('roof repair')).toBeNull();
    expect(screen.getByText('Up to $150')).toBeTruthy();
    await settled(queryClient);
  });
});

describe('the ad campaign kit', () => {
  it('review keeps the title, shows the platform and daily lines, and carries the maximum', () => {
    const review = adCampaignKit.review(step());
    expect(review.title).toBe('Google ads on the hail area');
    expect(review.lines).toEqual(['Search ads', '$21.42 a day for 7 days']);
    expect(review.maxSpendCents).toBe(15000);
  });

  it('review keeps the server preview when the numbers are not valid', () => {
    const current = step({ maxSpendCents: 'lots' as unknown as number });
    expect(adCampaignKit.review(current)).toEqual(current.preview);
  });

  it('lists the edit fields of a Google campaign, with the photo choice last', () => {
    const fields = adCampaignKit.editFields(step());
    expect(fields.map((f) => f.id)).toEqual(['maxSpend', 'days', 'headline', 'description', 'keywords', 'photo']);
    expect(fields.find((f) => f.id === 'maxSpend')).toMatchObject({ kind: 'number', value: '150' });
    expect(fields.find((f) => f.id === 'keywords')).toMatchObject({ kind: 'lines', value: 'roof repair\nhail damage' });
    expect(fields.find((f) => f.id === 'maxSpend')?.help).toContain('$150');
  });

  it('lists the main text instead of the keywords for a Facebook and Instagram campaign', () => {
    const fields = adCampaignKit.editFields(step({ platform: 'meta', keywords: undefined, primaryText: 'Main' }));
    expect(fields.map((f) => f.id)).toEqual(['maxSpend', 'days', 'headline', 'description', 'primaryText', 'photo']);
  });

  it('always offers a photo pick, with nothing picked when the step has no photo', () => {
    const photo = adCampaignKit.editFields(step()).find((f) => f.id === 'photo');
    expect(photo).toMatchObject({ kind: 'pick', value: [''] });
  });

  it('starts the photo pick on the photo the step uses, in lower case', () => {
    const photo = adCampaignKit.editFields(step({ photoId: PHOTO.toUpperCase() })).find((f) => f.id === 'photo');
    expect(photo).toMatchObject({ kind: 'pick', value: [PHOTO] });
  });

  it('turns typed values into a payload that the shared schema accepts', () => {
    const payload = adCampaignKit.toPayload(step(), {
      maxSpend: '100',
      days: '7',
      headline: 'Hail damage? Free roof check',
      description: 'Local roofers on your street.',
      keywords: ' roof repair \n\n hail damage \n',
    });
    expect(payload).toMatchObject({
      companyStormId: STORM,
      platform: 'google',
      maxSpendCents: 10000,
      days: 7,
      keywords: ['roof repair', 'hail damage'],
    });
    expect(stepTypes.create_ad_campaign.payload.safeParse(payload).success).toBe(true);
  });

  it('keeps the main text for a Facebook and Instagram campaign', () => {
    const meta = step({ platform: 'meta', keywords: undefined, primaryText: 'Old text' });
    const payload = adCampaignKit.toPayload(meta, {
      maxSpend: '100',
      days: '7',
      headline: 'Hail damage? Free roof check',
      description: 'Local roofers on your street.',
      primaryText: 'New text',
    });
    expect(payload.primaryText).toBe('New text');
    expect(payload.keywords).toBeUndefined();
    expect(stepTypes.create_ad_campaign.payload.safeParse(payload).success).toBe(true);
  });

  it('sets the photo to the photo picked, and parses', () => {
    const payload = adCampaignKit.toPayload(step({ photoId: PHOTO }), {
      maxSpend: '100',
      days: '7',
      headline: 'H',
      description: 'D',
      keywords: 'roof repair',
      photo: [PHOTO],
    });
    expect(stepTypes.create_ad_campaign.payload.safeParse(payload).success).toBe(true);
    expect(payload.photoId).toBe(PHOTO);
  });

  it('uses the last photo picked when several are ticked, and skips the no-photo choice', () => {
    const values = { maxSpend: '100', days: '7', headline: 'H', description: 'D', keywords: 'roof repair' };
    expect(adCampaignKit.toPayload(step(), { ...values, photo: [PHOTO, OTHER_PHOTO] }).photoId).toBe(OTHER_PHOTO);
    expect(adCampaignKit.toPayload(step(), { ...values, photo: ['', PHOTO, ''] }).photoId).toBe(PHOTO);
  });

  it('sets the photo to null when none is picked, and that still parses', () => {
    const payload = adCampaignKit.toPayload(step({ photoId: PHOTO }), {
      maxSpend: '100',
      days: '7',
      headline: 'H',
      description: 'D',
      keywords: 'roof repair',
      photo: [''],
    });
    expect(payload.photoId).toBeNull();
    expect(stepTypes.create_ad_campaign.payload.safeParse(payload).success).toBe(true);
  });

  it('keeps the photo the step already has when the sheet has no photo choice', () => {
    const payload = adCampaignKit.toPayload(step({ photoId: PHOTO }), {
      maxSpend: '100',
      days: '7',
      headline: 'H',
      description: 'D',
      keywords: 'roof repair',
    });
    expect(payload.photoId).toBe(PHOTO);
  });

  it('opens Edit with the maximum on the decimal keyboard and the days on the numeric one', async () => {
    api = stubApi({
      'GET /api/team': () => ({ body: { members: [], invites: [] } }),
      'GET /api/storm/settings': () => ({ body: { photos: [] } }),
    });
    renderAt(<StepFieldsSheet step={step()} kit={adCampaignKit} saving={false} onSave={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByLabelText(stepAds.maxLabel)).toHaveAttribute('inputmode', 'decimal');
    expect(screen.getByLabelText(stepAds.daysLabel)).toHaveAttribute('inputmode', 'numeric');
    await waitFor(() => expect(api?.count('GET /api/storm/settings')).toBeGreaterThan(0));
  });

  it('refuses a maximum above the current one and allows one at or below it', () => {
    expect(adCampaignKit.fieldErrors?.(step(), { maxSpend: '200' })).toEqual({ maxSpend: 'Please keep it at or under $150.' });
    expect(adCampaignKit.fieldErrors?.(step(), { maxSpend: '100' })).toEqual({});
    expect(adCampaignKit.fieldErrors?.(step(), { maxSpend: '150' })).toEqual({});
  });

  it('leaves a non-numeric maximum to the shared validation', () => {
    expect(adCampaignKit.fieldErrors?.(step(), { maxSpend: 'abc' })).toEqual({});
  });

  it('fails the shared schema for a blank headline with the headline message', () => {
    const payload = adCampaignKit.toPayload(step(), {
      maxSpend: '100',
      days: '7',
      headline: '',
      description: 'Local roofers on your street.',
      keywords: 'roof repair',
    });
    const result = stepTypes.create_ad_campaign.payload.safeParse(payload);
    expect(result.success).toBe(false);
    expect(result.success ? '' : result.error.issues.map((i) => i.message)).toContain('Please write the headline.');
  });
});
