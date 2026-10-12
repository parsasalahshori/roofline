import { readFileSync } from "node:fs";
import { afterEach, describe, expect, test, vi } from "vitest";
import { loadConfig } from "../src/config.ts";
import {
  AdPlatformError,
  type FetchLike,
  type GoogleAdsSettings,
  createGoogleAdsHttp,
} from "../src/providers/google-ads/http.ts";
import { googleAdsFor } from "../src/providers/google-ads/index.ts";

/*
 * The Google Ads REST client and adapter factory, against canned responses. Nothing here reaches
 * Google: every test hands the client its own fetch, so a test that forgot would fail on a missing
 * route rather than call googleapis.com. Fixtures are recorded shapes from the public Google docs.
 */

const fixture = (name: string): string =>
  readFileSync(
    new URL(`./fixtures/google-ads/${name}`, import.meta.url),
    "utf8",
  );

const TOKEN = fixture("token.json");
const SEARCH_EMPTY = fixture("search-empty.json");
const ERROR_AUTHORIZATION = fixture("error-authorization.json");
const ERROR_POLICY = fixture("error-policy.json");
const ERROR_BILLING = fixture("error-billing.json");
const ERROR_CRITERION = fixture("error-criterion.json");
const ERROR_OTHER = fixture("error-other.json");

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_BASE = "https://googleads.googleapis.com/v21/";
const CUSTOMER = "111-222-3333";
const CUSTOMER_DIGITS = "1112223333";

const SECRETS = {
  developerToken: "dev-token-SECRET-111",
  refreshToken: "refresh-SECRET-222",
  clientSecret: "client-SECRET-333",
};
const SECRET_VALUES = [
  SECRETS.developerToken,
  SECRETS.refreshToken,
  SECRETS.clientSecret,
];

const SETTINGS: GoogleAdsSettings = {
  developerToken: SECRETS.developerToken,
  managerId: "123-456-7890",
  clientId: "client-id.apps.googleusercontent.com",
  clientSecret: SECRETS.clientSecret,
  refreshToken: SECRETS.refreshToken,
  apiVersion: "v21",
};

type Call = { url: string; init: RequestInit };
type Route = (url: string, init: RequestInit) => Response;

/** A fake fetch that records every call and answers each one from `route`. A throwing route rejects, like a network failure. */
function fakeFetch(route: Route): { fetchImpl: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return route(call.url, call.init);
  }) as FetchLike;
  return { fetchImpl, calls };
}

function json(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Answers the token endpoint with the recorded token, and every other URL with `api`. */
function withToken(api: Route): Route {
  return (url, init) => (url === TOKEN_URL ? json(TOKEN) : api(url, init));
}

function headersOf(call: Call): Headers {
  return new Headers(call.init.headers);
}

function bodyOf(call: Call): unknown {
  return JSON.parse(String(call.init.body));
}

function tokenCalls(calls: Call[]): Call[] {
  return calls.filter((c) => c.url === TOKEN_URL);
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to reject");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("token refresh", () => {
  test("refreshes the token once per hour", async () => {
    let clock = 0;
    const { fetchImpl, calls } = fakeFetch(withToken(() => json(SEARCH_EMPTY)));
    const http = createGoogleAdsHttp(SETTINGS, fetchImpl, () => clock);

    await http.search(CUSTOMER, "SELECT campaign.id FROM campaign");
    clock = 1000 * 1000;
    await http.search(CUSTOMER, "SELECT campaign.id FROM campaign");
    clock = 3000 * 1000;
    await http.search(CUSTOMER, "SELECT campaign.id FROM campaign");
    expect(tokenCalls(calls)).toHaveLength(1);

    clock = 3600 * 1000;
    await http.search(CUSTOMER, "SELECT campaign.id FROM campaign");
    expect(tokenCalls(calls)).toHaveLength(2);
  });

  test("concurrent calls share one in-flight refresh", async () => {
    const { fetchImpl, calls } = fakeFetch(withToken(() => json(SEARCH_EMPTY)));
    const http = createGoogleAdsHttp(SETTINGS, fetchImpl, () => 0);

    await Promise.all([
      http.search(CUSTOMER, "q"),
      http.search(CUSTOMER, "q"),
      http.search(CUSTOMER, "q"),
    ]);
    expect(tokenCalls(calls)).toHaveLength(1);
  });

  test("posts a form-encoded refresh-token grant to the token endpoint", async () => {
    const { fetchImpl, calls } = fakeFetch(withToken(() => json(SEARCH_EMPTY)));
    const http = createGoogleAdsHttp(SETTINGS, fetchImpl, () => 0);

    await http.search(CUSTOMER, "q");
    const [token] = tokenCalls(calls);
    expect(token?.init.method).toBe("POST");
    const form = new URLSearchParams(String(token?.init.body));
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("client_id")).toBe(SETTINGS.clientId);
    expect(form.get("client_secret")).toBe(SECRETS.clientSecret);
    expect(form.get("refresh_token")).toBe(SECRETS.refreshToken);
  });
});

describe("request headers and URLs", () => {
  test("sends developer-token, login-customer-id and bearer headers", async () => {
    const { fetchImpl, calls } = fakeFetch(withToken(() => json(SEARCH_EMPTY)));
    const http = createGoogleAdsHttp(SETTINGS, fetchImpl, () => 0);

    await http.search(CUSTOMER, "SELECT campaign.id FROM campaign");
    const api = calls.find((c) => c.url !== TOKEN_URL);
    expect(api).toBeDefined();
    const headers = headersOf(api!);
    expect(headers.get("authorization")).toBe("Bearer ya29.test-access");
    expect(headers.get("developer-token")).toBe(SECRETS.developerToken);
    expect(headers.get("login-customer-id")).toBe("1234567890");
    expect(headers.get("content-type")).toBe("application/json");
  });

  test("strips dashes from customer ids in the URL", async () => {
    const { fetchImpl, calls } = fakeFetch(withToken(() => json(SEARCH_EMPTY)));
    const http = createGoogleAdsHttp(SETTINGS, fetchImpl, () => 0);

    await http.search(CUSTOMER, "q");
    expect(calls.find((c) => c.url !== TOKEN_URL)?.url).toBe(
      `${API_BASE}customers/${CUSTOMER_DIGITS}/googleAds:search`,
    );
  });
});

describe("search and mutate", () => {
  test("search returns an empty list when the response has no results", async () => {
    const { fetchImpl } = fakeFetch(withToken(() => json(SEARCH_EMPTY)));
    const http = createGoogleAdsHttp(SETTINGS, fetchImpl, () => 0);

    await expect(http.search(CUSTOMER, "q")).resolves.toEqual([]);
  });

  test("search follows nextPageToken until absent", async () => {
    const { fetchImpl, calls } = fakeFetch(
      withToken((_url, init) => {
        const body = JSON.parse(String(init.body)) as { pageToken?: string };
        if (body.pageToken === undefined) {
          return json(
            JSON.stringify({
              results: [{ campaign: { id: "1" } }],
              nextPageToken: "page-2",
            }),
          );
        }
        return json(JSON.stringify({ results: [{ campaign: { id: "2" } }] }));
      }),
    );
    const http = createGoogleAdsHttp(SETTINGS, fetchImpl, () => 0);

    const results = await http.search(
      CUSTOMER,
      "SELECT campaign.id FROM campaign",
    );
    expect(results).toEqual([
      { campaign: { id: "1" } },
      { campaign: { id: "2" } },
    ]);
    const apiCalls = calls.filter((c) => c.url !== TOKEN_URL);
    expect(apiCalls).toHaveLength(2);
    expect(bodyOf(apiCalls[0]!)).toEqual({
      query: "SELECT campaign.id FROM campaign",
    });
    expect(bodyOf(apiCalls[1]!)).toEqual({
      query: "SELECT campaign.id FROM campaign",
      pageToken: "page-2",
    });
  });

  test("mutate posts mutateOperations to googleAds:mutate with the api version in the URL", async () => {
    const ops = [
      { campaignOperation: { create: { name: "Roofline storm 7 google" } } },
    ];
    const responses = [
      { campaignResult: { resourceName: "customers/1112223333/campaigns/9" } },
    ];
    const { fetchImpl, calls } = fakeFetch(
      withToken(() =>
        json(JSON.stringify({ mutateOperationResponses: responses })),
      ),
    );
    const http = createGoogleAdsHttp(SETTINGS, fetchImpl, () => 0);

    await expect(http.mutate(CUSTOMER, ops)).resolves.toEqual(responses);
    const api = calls.find((c) => c.url !== TOKEN_URL);
    expect(api?.url).toBe(
      `${API_BASE}customers/${CUSTOMER_DIGITS}/googleAds:mutate`,
    );
    expect(api?.init.method).toBe("POST");
    expect(bodyOf(api!)).toEqual({ mutateOperations: ops });
  });

  test("mutate returns an empty list when the response has no operation responses", async () => {
    const { fetchImpl } = fakeFetch(withToken(() => json("{}")));
    const http = createGoogleAdsHttp(SETTINGS, fetchImpl, () => 0);

    await expect(http.mutate(CUSTOMER, [])).resolves.toEqual([]);
  });

  test("request sends any path under the api version with the manager header", async () => {
    const { fetchImpl, calls } = fakeFetch(
      withToken(() =>
        json('{"resourceName":"customers/1112223333/customerClientLinks/1"}'),
      ),
    );
    const http = createGoogleAdsHttp(SETTINGS, fetchImpl, () => 0);

    const out = await http.request(
      "POST",
      `customers/${CUSTOMER_DIGITS}/customerClientLinks:mutate`,
      { operations: [] },
    );
    expect(out).toEqual({
      resourceName: "customers/1112223333/customerClientLinks/1",
    });
    const api = calls.find((c) => c.url !== TOKEN_URL);
    expect(api?.url).toBe(
      `${API_BASE}customers/${CUSTOMER_DIGITS}/customerClientLinks:mutate`,
    );
    expect(headersOf(api!).get("login-customer-id")).toBe("1234567890");
    expect(bodyOf(api!)).toEqual({ operations: [] });
  });
});

describe("error mapping", () => {
  const cases: Array<{
    name: string;
    route: Route;
    kind: string;
    status?: number;
  }> = [
    {
      name: "authorization failure (403) is access",
      route: withToken(() => json(ERROR_AUTHORIZATION, 403)),
      kind: "access",
      status: 403,
    },
    {
      name: "policy violation is policy",
      route: withToken(() => json(ERROR_POLICY, 400)),
      kind: "policy",
      status: 400,
    },
    {
      name: "billing error is payment",
      route: withToken(() => json(ERROR_BILLING, 400)),
      kind: "payment",
      status: 400,
    },
    {
      name: "criterion error is targeting",
      route: withToken(() => json(ERROR_CRITERION, 400)),
      kind: "targeting",
      status: 400,
    },
    {
      name: "internal error (500) is other",
      route: withToken(() => json(ERROR_OTHER, 500)),
      kind: "other",
      status: 500,
    },
    {
      name: "a bare 401 with no body is access",
      route: withToken(() => new Response("", { status: 401 })),
      kind: "access",
      status: 401,
    },
    {
      name: "a token endpoint refusal (401) is access",
      route: (url) =>
        url === TOKEN_URL
          ? new Response('{"error":"invalid_grant"}', { status: 401 })
          : json(SEARCH_EMPTY),
      kind: "access",
      status: 401,
    },
    {
      name: "a token endpoint 400 (invalid_grant) is access, whatever its body says",
      route: (url) =>
        url === TOKEN_URL
          ? new Response(ERROR_POLICY, { status: 400 })
          : json(SEARCH_EMPTY),
      kind: "access",
      status: 400,
    },
    {
      name: "a rejected fetch is other",
      route: () => {
        throw new TypeError("fetch failed");
      },
      kind: "other",
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const { fetchImpl } = fakeFetch(c.route);
      const http = createGoogleAdsHttp(SETTINGS, fetchImpl, () => 0);

      const err = await errorOf(http.search(CUSTOMER, "q"));
      expect(err).toBeInstanceOf(AdPlatformError);
      expect((err as AdPlatformError).kind).toBe(c.kind);
      expect((err as AdPlatformError).status).toBe(c.status);
    });
  }
});

describe("secrets stay out of logs and errors", () => {
  test("no console or stdout output carries a secret, on success or failure", async () => {
    const spies = [
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "info").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
      vi.spyOn(console, "debug").mockImplementation(() => undefined),
      vi.spyOn(process.stdout, "write").mockImplementation(() => true),
    ];

    const echoing = `{"error":{"code":403,"message":"token ${SECRETS.developerToken} refresh ${SECRETS.refreshToken} secret ${SECRETS.clientSecret}","status":"PERMISSION_DENIED","details":[{"errors":[{"errorCode":{"authorizationError":"USER_PERMISSION_DENIED"}}]}]}}`;
    const ok = fakeFetch(withToken(() => json(SEARCH_EMPTY)));
    await createGoogleAdsHttp(SETTINGS, ok.fetchImpl, () => 0).search(
      CUSTOMER,
      "q",
    );

    const failing = fakeFetch(withToken(() => json(echoing, 403)));
    const err = await errorOf(
      createGoogleAdsHttp(SETTINGS, failing.fetchImpl, () => 0).search(
        CUSTOMER,
        "q",
      ),
    );

    const refused = fakeFetch((url) =>
      url === TOKEN_URL
        ? new Response(echoing, { status: 401 })
        : json(SEARCH_EMPTY),
    );
    const tokenErr = await errorOf(
      createGoogleAdsHttp(SETTINGS, refused.fetchImpl, () => 0).search(
        CUSTOMER,
        "q",
      ),
    );

    const logged = spies.flatMap((spy) =>
      spy.mock.calls.map((args) => JSON.stringify(args)),
    );
    for (const secret of SECRET_VALUES) {
      for (const line of logged) expect(line).not.toContain(secret);
      for (const thrown of [err, tokenErr]) {
        expect(String((thrown as Error).message)).not.toContain(secret);
        expect(String((thrown as Error).stack ?? "")).not.toContain(secret);
      }
    }
  });
});

describe("googleAdsFor", () => {
  const VALID = {
    NODE_ENV: "production",
    APP_ORIGIN: "https://app.roofline.test",
    DATABASE_URL_TENANT: "postgres://app_tenant:pw@localhost:5432/roofline",
    DATABASE_URL_SYSTEM: "postgres://app_system:pw@localhost:5432/roofline",
    ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
    PUBLIC_BASE_URL: "https://app.roofline.test",
    R2_ACCOUNT_ID: "acct",
    R2_ACCESS_KEY_ID: "key-id",
    R2_SECRET_ACCESS_KEY: "key-secret",
    R2_BUCKET: "proposals",
    TRUST_PROXY: "1",
  } satisfies Record<string, string>;

  const GOOGLE_ADS = {
    GOOGLE_ADS_DEVELOPER_TOKEN: SECRETS.developerToken,
    GOOGLE_ADS_MANAGER_ID: "123-456-7890",
    GOOGLE_ADS_CLIENT_ID: SETTINGS.clientId,
    GOOGLE_ADS_CLIENT_SECRET: SECRETS.clientSecret,
    GOOGLE_ADS_REFRESH_TOKEN: SECRETS.refreshToken,
  } satisfies Record<string, string>;

  test("returns null when no GOOGLE_ADS setting is set", () => {
    const { fetchImpl } = fakeFetch(withToken(() => json(SEARCH_EMPTY)));
    expect(googleAdsFor(loadConfig({ ...VALID }), fetchImpl)).toBeNull();
  });

  test("returns an adapter with configured true when all five settings are set", () => {
    const { fetchImpl } = fakeFetch(withToken(() => json(SEARCH_EMPTY)));
    const adapter = googleAdsFor(
      loadConfig({ ...VALID, ...GOOGLE_ADS }),
      fetchImpl,
    );
    expect(adapter).not.toBeNull();
    expect(adapter?.configured).toBe(true);
    expect(adapter?.managerId).toBe("1234567890");
  });
});
