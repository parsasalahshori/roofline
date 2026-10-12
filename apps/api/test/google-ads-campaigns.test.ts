import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import type { AdCreate } from "../src/providers/ads-google.ts";
import { AdPlatformError } from "../src/providers/ads-google.ts";
import {
  type GoogleAdsHttp,
  createGoogleAdsHttp,
} from "../src/providers/google-ads/http.ts";
import { createCampaigns } from "../src/providers/google-ads/campaigns.ts";

/*
 * The Search campaign builder, against a fake GoogleAdsHttp. Nothing here reaches Google: the fake
 * answers every call from recorded fixtures. The operations snapshot pins the exact mutate body.
 */

const fixture = (name: string): string =>
  readFileSync(
    new URL(`./fixtures/google-ads/${name}`, import.meta.url),
    "utf8",
  );

const FIND_HIT = JSON.parse(fixture("campaign-find-hit.json")) as {
  results: Record<string, unknown>[];
};
const FIND_MISS = JSON.parse(fixture("campaign-find-miss.json")) as {
  results?: Record<string, unknown>[];
};
const MUTATE_RESPONSE = JSON.parse(fixture("campaign-mutate-response.json")) as {
  mutateOperationResponses: Record<string, unknown>[];
};
const STATUS_RESPONSE = JSON.parse(fixture("campaign-status-response.json")) as {
  mutateOperationResponses: Record<string, unknown>[];
};
const EXPECTED_OPERATIONS: unknown = JSON.parse(
  fixture("campaign-mutate-operations.json"),
);

const CUSTOMER_DASHED = "987-654-3210";
const CUSTOMER_DIGITS = "9876543210";

const INPUT: AdCreate = {
  accountId: CUSTOMER_DASHED,
  nameTag: "Roofline storm cs_1 google",
  dailyBudgetCents: 2500,
  startDate: "2026-10-14",
  endDate: "2026-10-17",
  circles: [{ lat: 41.2565, lng: -95.9345, radiusM: 8046 }],
  landingUrl: "https://acme.example/storm/abc",
  headline: "Free Storm Roof Check",
  description: "Hail hit your area. Get a free roof check.",
  companyName: "Acme Roofing",
  city: "Omaha",
  keywords: ["roof repair", "hail damage roof"],
};

type Ops = Record<string, unknown>[];

type SearchFn = GoogleAdsHttp["search"];
type MutateFn = GoogleAdsHttp["mutate"];

/** A fake client whose search and mutate are spies; the spies returned are the ones the client calls. */
function fakeHttp(
  answers: { search?: SearchFn; mutate?: MutateFn } = {},
): {
  http: GoogleAdsHttp;
  search: ReturnType<typeof vi.fn<SearchFn>>;
  mutate: ReturnType<typeof vi.fn<MutateFn>>;
} {
  const search = vi.fn<SearchFn>(
    answers.search ?? (async () => FIND_HIT.results),
  );
  const mutate = vi.fn<MutateFn>(
    answers.mutate ?? (async () => MUTATE_RESPONSE.mutateOperationResponses),
  );
  const http: GoogleAdsHttp = {
    search: (customerId, query) => search(customerId, query),
    mutate: (customerId, ops) => mutate(customerId, ops),
    request: vi.fn(async () => ({})),
  };
  return { http, search, mutate };
}

/** Runs createCampaign on the fixed input and returns the operations sent in its one mutate call. */
async function createOps(input: AdCreate = INPUT): Promise<Ops> {
  const { http, mutate } = fakeHttp();
  await createCampaigns(http).createCampaign(input);
  expect(mutate).toHaveBeenCalledTimes(1);
  return mutate.mock.calls[0]?.[1] as Ops;
}

function opOf(ops: Ops, key: string): Record<string, unknown> {
  const found = ops.find((op) => key in op);
  if (found === undefined) throw new Error(`no ${key} operation`);
  return (found[key] as { create: Record<string, unknown> }).create;
}

type Ad = {
  finalUrls: string[];
  responsiveSearchAd: {
    headlines: { text: string }[];
    descriptions: { text: string }[];
  };
};

function adOf(ops: Ops): Ad {
  const op = ops.find((o) => "adGroupAdOperation" in o);
  const create = (op?.adGroupAdOperation as { create: { ad: Ad } }).create;
  return create.ad;
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to reject");
}

describe("createCampaign operations", () => {
  test("createCampaign sends one mutate with the expected operations", async () => {
    const { http, mutate } = fakeHttp();
    await createCampaigns(http).createCampaign(INPUT);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]?.[0]).toBe(CUSTOMER_DIGITS);
    expect(mutate.mock.calls[0]?.[1]).toEqual(EXPECTED_OPERATIONS);
  });

  test("micros math: 2500 cents is 25000000 micros", async () => {
    const ops = await createOps();
    expect(opOf(ops, "campaignBudgetOperation").amountMicros).toBe("25000000");
  });

  test("cents x 10000 for 1 and 12345 cents", async () => {
    const one = await createOps({ ...INPUT, dailyBudgetCents: 1 });
    expect(opOf(one, "campaignBudgetOperation").amountMicros).toBe("10000");
    const many = await createOps({ ...INPUT, dailyBudgetCents: 12345 });
    expect(opOf(many, "campaignBudgetOperation").amountMicros).toBe("123450000");
  });

  test("budget is not shared", async () => {
    const ops = await createOps();
    expect(opOf(ops, "campaignBudgetOperation").explicitlyShared).toBe(false);
  });

  test("campaign is SEARCH, PAUSED, maximizeClicks is empty (no CPC ceiling)", async () => {
    const ops = await createOps();
    const campaign = opOf(ops, "campaignOperation");
    expect(campaign.advertisingChannelType).toBe("SEARCH");
    expect(campaign.status).toBe("PAUSED");
    expect(campaign.maximizeClicks).toEqual({});
    expect(campaign).not.toHaveProperty("cpcBidCeilingMicros");
  });

  test("dates are YYYYMMDD", async () => {
    const ops = await createOps();
    const campaign = opOf(ops, "campaignOperation");
    expect(campaign.startDate).toBe("20261014");
    expect(campaign.endDate).toBe("20261017");
  });

  test("keywords are PHRASE and negatives jobs, salary, diy are present", async () => {
    const ops = await createOps();
    const keywords = ops
      .filter((op) => "adGroupCriterionOperation" in op)
      .map(
        (op) =>
          (op.adGroupCriterionOperation as { create: { keyword: unknown } })
            .create.keyword as { text: string; matchType: string },
      );
    expect(keywords).toEqual([
      { text: "roof repair", matchType: "PHRASE" },
      { text: "hail damage roof", matchType: "PHRASE" },
    ]);

    const negatives = ops
      .filter((op) => "campaignCriterionOperation" in op)
      .map(
        (op) =>
          (op.campaignCriterionOperation as { create: Record<string, unknown> })
            .create,
      )
      .filter((c) => c.negative === true)
      .map((c) => c.keyword as { text: string; matchType: string });
    expect(negatives).toEqual([
      { text: "jobs", matchType: "BROAD" },
      { text: "salary", matchType: "BROAD" },
      { text: "diy", matchType: "BROAD" },
    ]);
  });

  test("ad has >= 3 headlines <= 30 chars and exactly 2 descriptions <= 90 chars", async () => {
    const ad = adOf(await createOps());
    expect(ad.responsiveSearchAd.headlines.length).toBeGreaterThanOrEqual(3);
    for (const h of ad.responsiveSearchAd.headlines) {
      expect(h.text.length).toBeLessThanOrEqual(30);
    }
    expect(ad.responsiveSearchAd.descriptions).toHaveLength(2);
    for (const d of ad.responsiveSearchAd.descriptions) {
      expect(d.text.length).toBeLessThanOrEqual(90);
    }
    expect(ad.finalUrls).toEqual([INPUT.landingUrl]);
  });

  test("proximity radius km: 8046 m => 8, units KILOMETERS, micro degrees rounded", async () => {
    const ops = await createOps();
    const proximity = ops
      .filter((op) => "campaignCriterionOperation" in op)
      .map(
        (op) =>
          (op.campaignCriterionOperation as { create: Record<string, unknown> })
            .create,
      )
      .find((c) => "proximity" in c) as {
      proximity: {
        geoPoint: {
          longitudeInMicroDegrees: number;
          latitudeInMicroDegrees: number;
        };
        radius: number;
        radiusUnits: string;
      };
    };
    expect(proximity.proximity.radius).toBe(8);
    expect(proximity.proximity.radiusUnits).toBe("KILOMETERS");
    expect(proximity.proximity.geoPoint).toEqual({
      latitudeInMicroDegrees: 41256500,
      longitudeInMicroDegrees: -95934500,
    });
  });

  test("more than 50 circles throws targeting", async () => {
    const circles = Array.from({ length: 51 }, (_, i) => ({
      lat: 41 + i / 100,
      lng: -95,
      radiusM: 8000,
    }));
    const { http, mutate } = fakeHttp();
    const err = await errorOf(
      createCampaigns(http).createCampaign({ ...INPUT, circles }),
    );
    expect(err).toBeInstanceOf(AdPlatformError);
    expect((err as AdPlatformError).kind).toBe("targeting");
    expect(mutate).not.toHaveBeenCalled();
  });

  test("zero circles throws targeting", async () => {
    const { http, mutate } = fakeHttp();
    const err = await errorOf(
      createCampaigns(http).createCampaign({ ...INPUT, circles: [] }),
    );
    expect(err).toBeInstanceOf(AdPlatformError);
    expect((err as AdPlatformError).kind).toBe("targeting");
    expect(mutate).not.toHaveBeenCalled();
  });

  test("returns campaignId 555", async () => {
    const { http } = fakeHttp();
    await expect(createCampaigns(http).createCampaign(INPUT)).resolves.toEqual({
      campaignId: "555",
    });
  });

  test("a mutate response without a campaign result throws other", async () => {
    const { http } = fakeHttp({
      mutate: async () => [
        { campaignBudgetResult: { resourceName: "customers/9876543210/campaignBudgets/777" } },
      ],
    });
    const err = await errorOf(createCampaigns(http).createCampaign(INPUT));
    expect((err as AdPlatformError).kind).toBe("other");
  });
});

describe("findCampaign", () => {
  test("findCampaign returns 555 on hit, null on miss, and escapes a single quote in the nameTag in the query", async () => {
    const hit = fakeHttp();
    await expect(
      createCampaigns(hit.http).findCampaign(CUSTOMER_DASHED, INPUT.nameTag),
    ).resolves.toBe("555");
    expect(hit.search.mock.calls[0]?.[0]).toBe(CUSTOMER_DIGITS);

    const miss = fakeHttp({
      search: async () => FIND_MISS.results ?? [],
    });
    await expect(
      createCampaigns(miss.http).findCampaign(CUSTOMER_DASHED, INPUT.nameTag),
    ).resolves.toBeNull();

    const quoted = fakeHttp();
    await createCampaigns(quoted.http).findCampaign(
      CUSTOMER_DASHED,
      "Acme's storm \\ tag",
    );
    const query = String(quoted.search.mock.calls[0]?.[1]);
    expect(query).toContain("campaign.name = 'Acme\\'s storm \\\\ tag'");
    expect(query).toContain("campaign.status != 'REMOVED'");
    expect(query).toContain("LIMIT 1");
  });
});

describe("setStatus", () => {
  test("setStatus sends ENABLED/PAUSED with updateMask status", async () => {
    const { http, mutate } = fakeHttp({
      mutate: async () => STATUS_RESPONSE.mutateOperationResponses,
    });
    const campaigns = createCampaigns(http);

    await campaigns.setStatus(CUSTOMER_DASHED, "555", "active");
    await campaigns.setStatus(CUSTOMER_DASHED, "555", "paused");

    expect(mutate.mock.calls[0]).toEqual([
      CUSTOMER_DIGITS,
      [
        {
          campaignOperation: {
            update: {
              resourceName: `customers/${CUSTOMER_DIGITS}/campaigns/555`,
              status: "ENABLED",
            },
            updateMask: "status",
          },
        },
      ],
    ]);
    expect(
      (mutate.mock.calls[1]?.[1] as Ops)[0]?.campaignOperation,
    ).toMatchObject({ update: { status: "PAUSED" }, updateMask: "status" });
  });

  test("setStatus rejects a non-numeric id", async () => {
    const { http, mutate } = fakeHttp();
    const err = await errorOf(
      createCampaigns(http).setStatus(CUSTOMER_DASHED, "555; DROP", "active"),
    );
    expect(err).toBeInstanceOf(AdPlatformError);
    expect((err as AdPlatformError).kind).toBe("other");
    expect(mutate).not.toHaveBeenCalled();
  });
});

describe("shell wiring", () => {
  test("the real http client satisfies the campaigns seam", () => {
    const http = createGoogleAdsHttp(
      {
        developerToken: "d",
        managerId: "1",
        clientId: "c",
        clientSecret: "s",
        refreshToken: "r",
        apiVersion: "v21",
      },
      vi.fn() as unknown as typeof fetch,
    );
    expect(typeof createCampaigns(http).createCampaign).toBe("function");
    expect(EXPECTED_OPERATIONS).toBeDefined();
  });
});
