import { type AdCreate, AdPlatformError, type Circle } from "../ads-google.ts";
import type { GoogleAdsHttp } from "./http.ts";

export type GoogleAdsCampaigns = {
  findCampaign(customerId: string, nameTag: string): Promise<string | null>;
  createCampaign(c: AdCreate): Promise<{ campaignId: string }>;
  setStatus(customerId: string, campaignId: string, s: "active" | "paused"): Promise<void>;
};

type JsonRecord = Record<string, unknown>;

/** Google's limit on proximity criteria per campaign, and the Search headline and description sizes. */
const MAX_CIRCLES = 50;
const HEADLINE_MAX = 30;
const DESCRIPTION_MAX = 90;
const MICROS_PER_CENT = 10_000;
const PAD_HEADLINES = ["Free Roof Inspection", "Storm Damage Repair"] as const;
const NEGATIVE_KEYWORDS = ["jobs", "salary", "diy"] as const;
const CAMPAIGN_RESOURCE = /campaigns\/(\d+)$/;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Google Ads ids are digits; the console shows them with dashes. */
function digitsOnly(id: string): string {
  return id.replace(/-/g, "");
}

/** Escapes a value for a single-quoted GAQL string: backslashes first, then single quotes. */
function gaqlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function fail(kind: "other" | "targeting"): never {
  throw new AdPlatformError(kind);
}

/** The Search headlines: the headline, the company name, and "Roofing in <city>", with pads to reach three. */
function headlinesFor(c: AdCreate): string[] {
  const base = [c.headline, c.companyName, `Roofing in ${c.city}`];
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string): void => {
    const text = raw.slice(0, HEADLINE_MAX).trim();
    const key = text.toLowerCase();
    if (text === "" || seen.has(key)) return;
    seen.add(key);
    out.push(text);
  };
  for (const raw of base) add(raw);
  for (const pad of PAD_HEADLINES) {
    if (out.length >= 3) break;
    add(pad);
  }
  return out;
}

/** Exactly two descriptions, each within the limit; the second must differ from the first. */
function descriptionsFor(c: AdCreate): string[] {
  const first = c.description.slice(0, DESCRIPTION_MAX).trim();
  let second = `Call ${c.companyName} for a free roof check.`
    .slice(0, DESCRIPTION_MAX)
    .trim();
  if (second === first) second = "Free roof check after the storm.";
  return [first, second];
}

/** Trimmed, non-empty keywords, de-duplicated case-insensitively, in their original order. */
function keywordsFor(keywords: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of keywords) {
    const text = raw.trim();
    const key = text.toLowerCase();
    if (text === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

/** A proximity criterion: centre in micro degrees, radius in kilometres to one decimal (at least 1). */
function proximityCriterion(cid: string, circle: Circle): JsonRecord {
  if (
    !Number.isFinite(circle.lat) ||
    !Number.isFinite(circle.lng) ||
    !Number.isFinite(circle.radiusM)
  ) {
    fail("targeting");
  }
  let km = Math.round(circle.radiusM / 100) / 10;
  if (km < 1) km = 1;
  return {
    campaignCriterionOperation: {
      create: {
        campaign: `customers/${cid}/campaigns/-2`,
        proximity: {
          geoPoint: {
            longitudeInMicroDegrees: Math.round(circle.lng * 1e6),
            latitudeInMicroDegrees: Math.round(circle.lat * 1e6),
          },
          radius: km,
          radiusUnits: "KILOMETERS",
        },
      },
    },
  };
}

/** The ordered mutateOperations for one Search campaign, with temporary negative resource names. */
function campaignOperations(c: AdCreate, cid: string): JsonRecord[] {
  if (!Number.isInteger(c.dailyBudgetCents) || c.dailyBudgetCents <= 0) {
    fail("other");
  }
  if (c.circles.length === 0 || c.circles.length > MAX_CIRCLES) {
    fail("targeting");
  }

  const budget = `customers/${cid}/campaignBudgets/-1`;
  const campaign = `customers/${cid}/campaigns/-2`;
  const adGroup = `customers/${cid}/adGroups/-3`;

  const ops: JsonRecord[] = [
    {
      campaignBudgetOperation: {
        create: {
          resourceName: budget,
          name: `${c.nameTag} budget`,
          amountMicros: String(c.dailyBudgetCents * MICROS_PER_CENT),
          deliveryMethod: "STANDARD",
          explicitlyShared: false,
        },
      },
    },
    {
      campaignOperation: {
        create: {
          resourceName: campaign,
          name: c.nameTag,
          advertisingChannelType: "SEARCH",
          status: "PAUSED",
          campaignBudget: budget,
          maximizeClicks: {},
          startDate: c.startDate.replace(/-/g, ""),
          endDate: c.endDate.replace(/-/g, ""),
          networkSettings: {
            targetGoogleSearch: true,
            targetSearchNetwork: false,
            targetContentNetwork: false,
          },
          containsEuPoliticalAdvertising: "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
        },
      },
    },
    {
      adGroupOperation: {
        create: {
          resourceName: adGroup,
          name: `${c.nameTag} ad group`,
          campaign,
          status: "ENABLED",
          type: "SEARCH_STANDARD",
        },
      },
    },
  ];

  for (const text of keywordsFor(c.keywords)) {
    ops.push({
      adGroupCriterionOperation: {
        create: {
          adGroup,
          status: "ENABLED",
          keyword: { text, matchType: "PHRASE" },
        },
      },
    });
  }

  ops.push({
    adGroupAdOperation: {
      create: {
        adGroup,
        status: "ENABLED",
        ad: {
          finalUrls: [c.landingUrl],
          responsiveSearchAd: {
            headlines: headlinesFor(c).map((text) => ({ text })),
            descriptions: descriptionsFor(c).map((text) => ({ text })),
          },
        },
      },
    },
  });

  for (const circle of c.circles) ops.push(proximityCriterion(cid, circle));

  for (const text of NEGATIVE_KEYWORDS) {
    ops.push({
      campaignCriterionOperation: {
        create: {
          campaign,
          negative: true,
          keyword: { text, matchType: "BROAD" },
        },
      },
    });
  }
  return ops;
}

/** The campaign id from the first campaignResult whose resource name ends in campaigns/<digits>. */
function createdCampaignId(responses: JsonRecord[]): string {
  for (const response of responses) {
    const result = response.campaignResult;
    if (!isRecord(result) || typeof result.resourceName !== "string") continue;
    const match = CAMPAIGN_RESOURCE.exec(result.resourceName);
    if (match?.[1] !== undefined) return match[1];
  }
  return fail("other");
}

export function createCampaigns(http: GoogleAdsHttp): GoogleAdsCampaigns {
  return {
    async findCampaign(customerId, nameTag) {
      const query =
        `SELECT campaign.id, campaign.name, campaign.status FROM campaign ` +
        `WHERE campaign.name = '${gaqlString(nameTag)}' ` +
        `AND campaign.status != 'REMOVED' LIMIT 1`;
      const rows = await http.search(digitsOnly(customerId), query);
      const first = rows[0];
      if (!isRecord(first) || !isRecord(first.campaign)) return null;
      const id = first.campaign.id;
      return typeof id === "string" ? id : null;
    },

    async createCampaign(c) {
      const cid = digitsOnly(c.accountId);
      const responses = await http.mutate(cid, campaignOperations(c, cid));
      return { campaignId: createdCampaignId(responses) };
    },

    async setStatus(customerId, campaignId, s) {
      if (!/^\d+$/.test(campaignId)) fail("other");
      const cid = digitsOnly(customerId);
      await http.mutate(cid, [
        {
          campaignOperation: {
            update: {
              resourceName: `customers/${cid}/campaigns/${campaignId}`,
              status: s === "active" ? "ENABLED" : "PAUSED",
            },
            updateMask: "status",
          },
        },
      ]);
    },
  };
}
