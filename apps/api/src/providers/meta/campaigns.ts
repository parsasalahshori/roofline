import { AdPlatformError } from '../ads-google.ts';
import type { MetaCreate } from '../ads-meta.ts';
import type { MetaHttp } from './http.ts';

/*
 * Campaign, ad set, creative and ad creation for the Meta adapter. The campaign is created PAUSED and is the one
 * switch (setStatus flips only it); the ad set and the ad are created ACTIVE so they deliver once it is enabled,
 * and a campaign-level pause still stops everything.
 * A retried create finds the campaign first by its name tag, so nothing is duplicated.
 */

const METERS_PER_MILE = 1609.344;
/** Meta rejects radii below one mile for custom locations, so every circle is at least this big. */
const MIN_RADIUS_MILES = 1;
/** Housing targeting uses one circle of this size at the centroid of the storm circles. */
const HOUSING_RADIUS_MILES = 15;
const AGE_MIN = 25;
const DAY_MS = 86_400_000;

/** Converts a radius in metres to whole-tenth miles, never below the Meta minimum. */
export function metaRadiusMiles(radiusM: number): number {
  const miles = Math.round((radiusM / METERS_PER_MILE) * 10) / 10;
  return Math.max(MIN_RADIUS_MILES, miles);
}

/** Inclusive calendar days between two 'YYYY-MM-DD' dates, UTC math, minimum 1. */
export function daysBetween(startDate: string, endDate: string): number {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  const days = Math.round((end - start) / DAY_MS) + 1;
  return Number.isFinite(days) ? Math.max(1, days) : 1;
}

/** Accepts 'act_123' or '123' and returns the Graph node path 'act_123'. */
function accountPath(adAccountId: string): string {
  return `act_${adAccountId.replace(/^act_/, '')}`;
}

function round5(value: number): number {
  return Math.round(value * 1e5) / 1e5;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The id of a created node. A response without one is a provider failure, shown as other. */
function idOf(body: unknown): string {
  const id = isRecord(body) ? body.id : undefined;
  if (typeof id !== 'string' && typeof id !== 'number') throw new AdPlatformError('other');
  return String(id);
}

/** Campaign-level search by name tag. CONTAIN is broader than the tag, so the exact name is compared. */
export async function findCampaign(http: MetaHttp, adAccountId: string, nameTag: string): Promise<string | null> {
  const body = await http.get(`${accountPath(adAccountId)}/campaigns`, {
    fields: 'id,name',
    filtering: JSON.stringify([{ field: 'name', operator: 'CONTAIN', value: nameTag }]),
    limit: '25',
  });
  const data = isRecord(body) ? body.data : undefined;
  if (!Array.isArray(data)) return null;
  for (const row of data) {
    if (isRecord(row) && row.name === nameTag && (typeof row.id === 'string' || typeof row.id === 'number')) {
      return String(row.id);
    }
  }
  return null;
}

/** Pauses or resumes a campaign by its Graph id. */
export async function setStatus(
  http: MetaHttp,
  _adAccountId: string,
  campaignId: string,
  s: 'active' | 'paused',
): Promise<void> {
  await http.post(campaignId, { status: s === 'active' ? 'ACTIVE' : 'PAUSED' });
}

/** Circles as Meta custom locations. Housing collapses them to one 15-mile circle at their centroid. */
function customLocations(c: MetaCreate): Record<string, unknown>[] {
  if (c.circles.length === 0) throw new AdPlatformError('targeting');
  if (c.housing) {
    const count = c.circles.length;
    const lat = c.circles.reduce((sum, circle) => sum + circle.lat, 0) / count;
    const lng = c.circles.reduce((sum, circle) => sum + circle.lng, 0) / count;
    return [{ latitude: round5(lat), longitude: round5(lng), radius: HOUSING_RADIUS_MILES, distance_unit: 'mile' }];
  }
  return c.circles.map((circle) => ({
    latitude: round5(circle.lat),
    longitude: round5(circle.lng),
    radius: metaRadiusMiles(circle.radiusM),
    distance_unit: 'mile',
  }));
}

function imageForm(png: Uint8Array): FormData {
  const form = new FormData();
  form.append('filename', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'ad.png');
  return form;
}

/** The hash of the first image in an adimages response. A missing hash is a provider failure. */
function imageHashOf(body: unknown): string {
  const images = isRecord(body) && isRecord(body.images) ? body.images : undefined;
  const first = images ? Object.values(images)[0] : undefined;
  const hash = isRecord(first) ? first.hash : undefined;
  if (typeof hash !== 'string' || hash === '') throw new AdPlatformError('other');
  return hash;
}

/**
 * Creates the image, campaign (PAUSED), ad set (ACTIVE), creative and ad (ACTIVE). A targeting error from the
 * campaign step (Meta requires the Housing category) is rethrown as is, and nothing after it is posted.
 * If a step after the campaign fails, the campaign is deleted (best effort) so a retry's findCampaign
 * does not reuse a half-built campaign.
 */
export async function createCampaign(http: MetaHttp, c: MetaCreate): Promise<{ campaignId: string }> {
  const account = accountPath(c.accountId);
  const days = daysBetween(c.startDate, c.endDate);
  const link = c.landingUrl;
  const locations = customLocations(c);

  const image = await http.post(`${account}/adimages`, imageForm(c.imagePng));
  const imageHash = imageHashOf(image);

  const campaign = await http.post(`${account}/campaigns`, {
    name: c.nameTag,
    objective: 'OUTCOME_TRAFFIC',
    status: 'PAUSED',
    special_ad_categories: c.housing ? ['HOUSING'] : [],
    buying_type: 'AUCTION',
  });
  const campaignId = idOf(campaign);

  try {
    const adset = await http.post(`${account}/adsets`, {
      name: c.nameTag,
      campaign_id: campaignId,
      status: 'ACTIVE',
      billing_event: 'IMPRESSIONS',
      optimization_goal: 'LANDING_PAGE_VIEWS',
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      lifetime_budget: c.dailyBudgetCents * days,
      start_time: `${c.startDate}T00:00:00`,
      end_time: `${c.endDate}T23:59:59`,
      targeting: {
        geo_locations: { custom_locations: locations },
        age_min: AGE_MIN,
        publisher_platforms: ['facebook', 'instagram'],
      },
    });
    const adsetId = idOf(adset);

    const creative = await http.post(`${account}/adcreatives`, {
      name: c.nameTag,
      object_story_spec: {
        link_data: {
          image_hash: imageHash,
          link,
          message: c.primaryText,
          name: c.headline,
          description: c.description,
          call_to_action: { type: 'LEARN_MORE', value: { link } },
        },
      },
    });
    const creativeId = idOf(creative);

    await http.post(`${account}/ads`, {
      name: c.nameTag,
      adset_id: adsetId,
      creative: { creative_id: creativeId },
      status: 'ACTIVE',
    });
  } catch (err) {
    try {
      await http.post(campaignId, { status: 'DELETED' });
    } catch {
      /* best effort: the original error matters more */
    }
    throw err;
  }

  return { campaignId };
}
