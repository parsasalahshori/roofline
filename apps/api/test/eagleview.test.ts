import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Config } from '../src/config.ts';
import { AerialUnavailableError } from '../src/providers/aerial.ts';
import { EagleViewHttp, EagleViewHttpError } from '../src/providers/eagleview/http.ts';
import { EagleViewOrders, eagleViewOrdersFor } from '../src/providers/eagleview/orders.ts';
import { EagleViewPropertyData, eagleViewPropertyDataFor } from '../src/providers/eagleview/property-data.ts';
import { EagleViewNormalizeError, normalizeEagleView } from '../src/providers/eagleview/normalize.ts';
import {
  ExactOrderUncertainError,
  ExactReportsUnavailableError,
  type ExactOrderInput,
} from '../src/providers/exact-reports.ts';

/*
 * The EagleView adapters, against canned responses. Nothing here reaches the network: every test hands
 * the client its own `fetch` (a stub that answers by URL and records each call), so a test that forgot
 * to would fail on a missing route, not call EagleView.
 */

const CLIENT_ID = 'id';
const CLIENT_SECRET = 'sec';
const PROVIDER_SECRET_TEXT = 'SECRET-PROVIDER-TEXT';
const STREET = '1 A St';
const TOKEN = 'tok-abc';
const PRODUCT_ID = 7;
const DELIVERY_ID = 3;
const REPORT_ID = '123456789';
const REQUEST_ID = '11111111-2222-4333-8444-555555555555';

const ADDRESS = { street: STREET, city: 'Omaha', state: 'NE', zip: '68102' };
const ORDER_INPUT: ExactOrderInput = { address: ADDRESS, productId: PRODUCT_ID, referenceId: 'ref-1' };

function fixtureText(name: string): string {
  return readFileSync(new URL(`./fixtures/eagleview/${name}`, import.meta.url), 'utf8');
}

function fixtureJson(name: string): Record<string, unknown> {
  return JSON.parse(fixtureText(name)) as Record<string, unknown>;
}

const TOKEN_URL_PART = 'oauth2/v1/token';
const ORDERS_HOST = 'webservices-integrations.eagleview.com';
const PROPERTY_HOST = 'sandbox.apis.eagleview.com';

/** One canned answer: a status with an optional body, or a thrown error (a network failure). */
type Reply = { status: number; text?: string; json?: unknown } | Error;
type Route = { match: string; replies: Reply[] };
type Call = { url: string; init: RequestInit | undefined };

/**
 * A `fetch` stub. The first route whose `match` is a substring of the URL answers. Each route plays its
 * replies in order; the last one repeats, so a route with one reply answers every call.
 */
function stubFetch(routes: Route[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes.find((r) => url.includes(r.match));
    if (!route) throw new Error(`no stub route for ${url}`);
    const reply = route.replies.length > 1 ? route.replies.shift() : route.replies[0];
    if (reply === undefined) throw new Error(`empty stub route for ${url}`);
    if (reply instanceof Error) throw reply;
    const body = reply.text ?? (reply.json !== undefined ? JSON.stringify(reply.json) : '');
    return new Response(body, { status: reply.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: fn, calls };
}

function tokenRoute(): Route {
  return { match: TOKEN_URL_PART, replies: [{ status: 200, text: fixtureText('token.json') }] };
}

function callsTo(calls: Call[], part: string): Call[] {
  return calls.filter((c) => c.url.includes(part));
}

function headerOf(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

function bodyOf(init: RequestInit | undefined): unknown {
  return JSON.parse(String(init?.body));
}

function makeHttp(routes: Route[], now: () => number = () => 0): { http: EagleViewHttp; calls: Call[] } {
  const stub = stubFetch([tokenRoute(), ...routes]);
  const http = new EagleViewHttp({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    env: 'sandbox',
    fetch: stub.fetch,
    now,
  });
  return { http, calls: stub.calls };
}

function makeOrders(routes: Route[]): { orders: EagleViewOrders; calls: Call[] } {
  const { http, calls } = makeHttp(routes);
  return { orders: new EagleViewOrders({ http, productId: PRODUCT_ID, deliveryId: DELIVERY_ID }), calls };
}

function makePropertyData(routes: Route[]): { pd: EagleViewPropertyData; calls: Call[] } {
  const { http, calls } = makeHttp(routes);
  return { pd: new EagleViewPropertyData({ http }), calls };
}

const PRICE_ROUTE_PART = '/v2/Order/PriceOrder';
const PLACE_ROUTE_PART = '/v2/Order/PlaceOrder';
const REPORT_ROUTE_PART = '/v3/Report/GetReport';
const PD_REQUEST_PART = '/property/v2/request';
const PD_RESULT_PART = '/property/v2/result/';

const priceOk: Route = { match: PRICE_ROUTE_PART, replies: [{ status: 200, text: fixtureText('price-order.json') }] };
const placeOk: Route = { match: PLACE_ROUTE_PART, replies: [{ status: 200, text: fixtureText('place-order.json') }] };

function configWith(overrides: Record<string, unknown>): Config {
  return { NODE_ENV: 'test', ...overrides } as unknown as Config;
}

const CONFIGURED = configWith({
  EAGLEVIEW_CLIENT_ID: CLIENT_ID,
  EAGLEVIEW_CLIENT_SECRET: CLIENT_SECRET,
  EAGLEVIEW_ENV: 'sandbox',
  EAGLEVIEW_PRODUCT_ID: PRODUCT_ID,
});

afterEach(() => {
  vi.useRealTimers();
});

describe('EagleViewHttp', () => {
  test('one token for three calls', async () => {
    const { http, calls } = makeHttp([
      { match: '/property/v2/result/', replies: [{ status: 200, json: {} }] },
    ]);
    const path = `/property/v2/result/${REQUEST_ID}`;
    await http.request('property', 'GET', path);
    await http.request('property', 'GET', path);
    await http.request('property', 'GET', path);

    const tokenCalls = callsTo(calls, TOKEN_URL_PART);
    expect(tokenCalls).toHaveLength(1);
    expect(headerOf(tokenCalls[0]?.init, 'authorization')).toBe(
      `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
    );

    const apiCalls = callsTo(calls, PROPERTY_HOST);
    expect(apiCalls).toHaveLength(3);
    for (const call of apiCalls) {
      expect(headerOf(call.init, 'authorization')).toBe(`Bearer ${TOKEN}`);
    }
  });

  test('concurrent first calls share one token fetch', async () => {
    const { http, calls } = makeHttp([
      { match: '/property/v2/result/', replies: [{ status: 200, json: {} }] },
    ]);
    const path = `/property/v2/result/${REQUEST_ID}`;
    await Promise.all([
      http.request('property', 'GET', path),
      http.request('property', 'GET', path),
      http.request('property', 'GET', path),
    ]);
    expect(callsTo(calls, TOKEN_URL_PART)).toHaveLength(1);
    expect(callsTo(calls, PROPERTY_HOST)).toHaveLength(3);
  });

  test('refreshes the token at expiry minus 60 s', async () => {
    let clockMs = 0;
    const { http, calls } = makeHttp(
      [{ match: '/property/v2/result/', replies: [{ status: 200, json: {} }] }],
      () => clockMs,
    );
    const path = `/property/v2/result/${REQUEST_ID}`;

    await http.request('property', 'GET', path);
    expect(callsTo(calls, TOKEN_URL_PART)).toHaveLength(1);

    clockMs = 3539_000;
    await http.request('property', 'GET', path);
    expect(callsTo(calls, TOKEN_URL_PART)).toHaveLength(1);

    clockMs = 3541_000;
    await http.request('property', 'GET', path);
    expect(callsTo(calls, TOKEN_URL_PART)).toHaveLength(2);
  });

  test('refreshes once on 401', async () => {
    const { http, calls } = makeHttp([
      {
        match: '/property/v2/result/',
        replies: [{ status: 401, text: '{}' }, { status: 200, json: { ok: true } }],
      },
    ]);
    const res = await http.request('property', 'GET', `/property/v2/result/${REQUEST_ID}`);
    expect(res.status).toBe(200);
    expect(callsTo(calls, TOKEN_URL_PART)).toHaveLength(2);
    expect(callsTo(calls, PROPERTY_HOST)).toHaveLength(2);
  });

  test('second 401 is rejected', async () => {
    const { http, calls } = makeHttp([
      { match: '/property/v2/result/', replies: [{ status: 401, text: '{}' }, { status: 401, text: '{}' }] },
    ]);
    await expect(http.request('property', 'GET', `/property/v2/result/${REQUEST_ID}`)).rejects.toMatchObject({
      kind: 'rejected',
      status: 401,
    });
    expect(callsTo(calls, TOKEN_URL_PART)).toHaveLength(2);
    expect(callsTo(calls, PROPERTY_HOST)).toHaveLength(2);
  });

  test('maps 503/429 to unavailable and a thrown fetch to network', async () => {
    const path = `/property/v2/result/${REQUEST_ID}`;

    const down = makeHttp([{ match: '/property/v2/result/', replies: [{ status: 503, text: '' }] }]);
    const downErr = await down.http.request('property', 'GET', path).catch((e: unknown) => e);
    expect(downErr).toBeInstanceOf(EagleViewHttpError);
    expect(downErr).toMatchObject({ kind: 'unavailable', status: 503 });

    const limited = makeHttp([{ match: '/property/v2/result/', replies: [{ status: 429, text: '' }] }]);
    const limitedErr = await limited.http.request('property', 'GET', path).catch((e: unknown) => e);
    expect(limitedErr).toMatchObject({ kind: 'unavailable', status: 429 });

    const broken = makeHttp([
      { match: '/property/v2/result/', replies: [new TypeError(`${PROVIDER_SECRET_TEXT} socket reset`)] },
    ]);
    const brokenErr = await broken.http.request('property', 'GET', path).catch((e: unknown) => e);
    expect(brokenErr).toBeInstanceOf(EagleViewHttpError);
    expect(brokenErr).toMatchObject({ kind: 'network', status: null });
  });
});

describe('EagleViewOrders', () => {
  test('price maps dollars to cents', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-12T12:00:00Z'));

    const { orders } = makeOrders([priceOk]);
    const price = await orders.price(ORDER_INPUT);

    expect(price.minCents).toBe(4250);
    expect(price.maxCents).toBe(4250);
    expect(Math.abs(price.expiresAt.getTime() - (Date.now() + 10 * 60_000))).toBeLessThan(5000);
  });

  test('price sends the order payload', async () => {
    const { orders, calls } = makeOrders([priceOk]);
    await orders.price(ORDER_INPUT);

    const priceCalls = callsTo(calls, PRICE_ROUTE_PART);
    expect(priceCalls).toHaveLength(1);
    expect(priceCalls[0]?.url).toContain(ORDERS_HOST);
    const body = bodyOf(priceCalls[0]?.init) as { OrderReports: Record<string, unknown>[] };
    const report = body.OrderReports[0];
    expect(report).toMatchObject({
      PrimaryProductId: PRODUCT_ID,
      DeliveryProductId: DELIVERY_ID,
      MeasurementInstructionType: 1,
      ChangesInLast4Years: false,
      ReferenceId: 'ref-1',
      Comments: 'Roofline: US imperial roof measurements requested.',
    });
  });

  test('place-order success returns the report id as a string', async () => {
    const { orders, calls } = makeOrders([placeOk]);
    await expect(orders.order(ORDER_INPUT)).resolves.toEqual({ reportId: REPORT_ID });
    expect(callsTo(calls, PLACE_ROUTE_PART)).toHaveLength(1);
  });

  test('place-order with an empty ReportIds throws ExactOrderUncertainError', async () => {
    const { orders } = makeOrders([
      { match: PLACE_ROUTE_PART, replies: [{ status: 200, text: '{"ReportIds":[],"Status":"Placed"}' }] },
    ]);
    await expect(orders.order(ORDER_INPUT)).rejects.toBeInstanceOf(ExactOrderUncertainError);
  });

  test('place-order on a 500 throws ExactOrderUncertainError', async () => {
    const { orders } = makeOrders([{ match: PLACE_ROUTE_PART, replies: [{ status: 500, text: '' }] }]);
    await expect(orders.order(ORDER_INPUT)).rejects.toBeInstanceOf(ExactOrderUncertainError);
  });

  test('place-order on a thrown fetch (timeout) throws ExactOrderUncertainError and fetch is called once for the order (no retry)', async () => {
    const { orders, calls } = makeOrders([
      { match: PLACE_ROUTE_PART, replies: [new Error('The operation was aborted due to timeout')] },
    ]);
    await expect(orders.order(ORDER_INPUT)).rejects.toBeInstanceOf(ExactOrderUncertainError);
    expect(callsTo(calls, PLACE_ROUTE_PART)).toHaveLength(1);
  });

  test('place-order on 403 throws ExactReportsUnavailableError', async () => {
    const { orders } = makeOrders([{ match: PLACE_ROUTE_PART, replies: [{ status: 403, text: '' }] }]);
    await expect(orders.order(ORDER_INPUT)).rejects.toBeInstanceOf(ExactReportsUnavailableError);
  });

  test('price on 503 throws ExactReportsUnavailableError', async () => {
    const { orders } = makeOrders([{ match: PRICE_ROUTE_PART, replies: [{ status: 503, text: '' }] }]);
    await expect(orders.price(ORDER_INPUT)).rejects.toBeInstanceOf(ExactReportsUnavailableError);
  });

  test('get-report pending', async () => {
    const { orders } = makeOrders([
      { match: REPORT_ROUTE_PART, replies: [{ status: 200, text: fixtureText('get-report-pending.json') }] },
    ]);
    await expect(orders.report(REPORT_ID)).resolves.toEqual({ status: 'pending' });
  });

  test('get-report complete without a readable cost gives costCents null, never 0', async () => {
    const text = fixtureText('get-report-complete.json').replace('"Cost":42.5,', '');
    const { orders } = makeOrders([{ match: REPORT_ROUTE_PART, replies: [{ status: 200, text }] }]);
    const result = await orders.report(REPORT_ID);
    expect(result).toMatchObject({ status: 'complete', costCents: null });
  });

  test.each(['"Cost":0,', '"Cost":"0.00",'])('get-report complete with a cost of 0 (%s) is unreadable: costCents null (B3)', async (zero) => {
    const text = fixtureText('get-report-complete.json').replace('"Cost":42.5,', zero);
    expect(text).toContain(zero);
    const { orders } = makeOrders([{ match: REPORT_ROUTE_PART, replies: [{ status: 200, text }] }]);
    const result = await orders.report(REPORT_ID);
    expect(result).toMatchObject({ status: 'complete', costCents: null });
  });

  test('get-report complete', async () => {
    const { orders, calls } = makeOrders([
      { match: REPORT_ROUTE_PART, replies: [{ status: 200, text: fixtureText('get-report-complete.json') }] },
    ]);
    const result = await orders.report(REPORT_ID);
    expect(result).toEqual({
      status: 'complete',
      costCents: 4250,
      report: {
        surfaceSqFt: 2850,
        pitchX12: 6,
        ridgeFt: 65,
        edgeFt: 180,
        valleyFt: 30,
        facets: 12,
        reportRef: REPORT_ID,
      },
    });
    expect(callsTo(calls, REPORT_ROUTE_PART)[0]?.url).toContain(`reportId=${REPORT_ID}`);
  });

  test('get-report failed', async () => {
    const { orders } = makeOrders([
      { match: REPORT_ROUTE_PART, replies: [{ status: 200, text: fixtureText('get-report-failed.json') }] },
    ]);
    await expect(orders.report(REPORT_ID)).resolves.toEqual({ status: 'failed', reasonKey: 'provider_failed' });
  });

  test('get-report with unsupported units returns failed unsupported_units', async () => {
    const complete = fixtureJson('get-report-complete.json');
    const measurements = { ...(complete.TotalMeasurements as Record<string, unknown>), Area: 'abc' };
    const { orders } = makeOrders([
      {
        match: REPORT_ROUTE_PART,
        replies: [{ status: 200, json: { ...complete, TotalMeasurements: measurements } }],
      },
    ]);
    await expect(orders.report(REPORT_ID)).resolves.toEqual({ status: 'failed', reasonKey: 'unsupported_units' });
  });

  test('get-report network failure throws ExactReportsUnavailableError', async () => {
    const { orders } = makeOrders([
      { match: REPORT_ROUTE_PART, replies: [new Error(`${PROVIDER_SECRET_TEXT} reset`)] },
    ]);
    await expect(orders.report(REPORT_ID)).rejects.toBeInstanceOf(ExactReportsUnavailableError);
  });

  test('get-report on 403 throws ExactReportsUnavailableError (not failed)', async () => {
    const { orders } = makeOrders([{ match: REPORT_ROUTE_PART, replies: [{ status: 403, text: '' }] }]);
    await expect(orders.report(REPORT_ID)).rejects.toBeInstanceOf(ExactReportsUnavailableError);
  });

  test('get-report on 404 returns failed provider_failed', async () => {
    const { orders } = makeOrders([{ match: REPORT_ROUTE_PART, replies: [{ status: 404, text: '' }] }]);
    await expect(orders.report(REPORT_ID)).resolves.toEqual({ status: 'failed', reasonKey: 'provider_failed' });
  });
});

describe('normalizeEagleView', () => {
  test('maps the complete fixture to surface, pitch, ridge+hip, eave+rake, valley and facets', () => {
    expect(normalizeEagleView(fixtureJson('get-report-complete.json'))).toEqual({
      surfaceSqFt: 2850,
      pitchX12: 6,
      ridgeFt: 65,
      edgeFt: 180,
      valleyFt: 30,
      facets: 12,
      reportRef: REPORT_ID,
    });
  });

  test('missing facets gives facets null', () => {
    const raw = fixtureJson('get-report-complete.json');
    const measurements = { ...(raw.TotalMeasurements as Record<string, unknown>) };
    delete measurements.TotalRoofFacets;
    expect(normalizeEagleView({ ...raw, TotalMeasurements: measurements }).facets).toBeNull();
  });

  test('optional lengths missing count as 0', () => {
    const raw = fixtureJson('get-report-complete.json');
    const measurements = { ...(raw.TotalMeasurements as Record<string, unknown>) };
    delete measurements.LengthHip;
    delete measurements.LengthRake;
    delete measurements.LengthValley;
    const report = normalizeEagleView({ ...raw, TotalMeasurements: measurements });
    expect(report.ridgeFt).toBe(40);
    expect(report.edgeFt).toBe(120);
    expect(report.valleyFt).toBe(0);
  });

  test('a bad Area throws EagleViewNormalizeError', () => {
    const raw = fixtureJson('get-report-complete.json');
    const measurements = { ...(raw.TotalMeasurements as Record<string, unknown>), Area: 'abc' };
    expect(() => normalizeEagleView({ ...raw, TotalMeasurements: measurements })).toThrow(EagleViewNormalizeError);
  });
});

describe('EagleViewPropertyData', () => {
  test('start returns the request id', async () => {
    const { pd, calls } = makePropertyData([
      { match: PD_REQUEST_PART, replies: [{ status: 200, text: fixtureText('pd-request.json') }] },
    ]);
    await expect(pd.start('1 A St, Omaha, NE 68102')).resolves.toEqual({ requestId: REQUEST_ID });

    const requestCalls = callsTo(calls, PD_REQUEST_PART);
    expect(requestCalls).toHaveLength(1);
    expect(requestCalls[0]?.init?.method).toBe('POST');
    expect(bodyOf(requestCalls[0]?.init)).toEqual({ address: { completeAddress: '1 A St, Omaha, NE 68102' } });
  });

  test('result 202 is pending', async () => {
    const { pd } = makePropertyData([
      { match: PD_RESULT_PART, replies: [{ status: 202, text: fixtureText('pd-result-pending.json') }] },
    ]);
    await expect(pd.result(REQUEST_ID)).resolves.toEqual({ status: 'pending' });
  });

  test('result complete returns roofs with the first structure', async () => {
    const { pd } = makePropertyData([
      { match: PD_RESULT_PART, replies: [{ status: 200, text: fixtureText('pd-result-complete.json') }] },
    ]);
    const result = await pd.result(REQUEST_ID);
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') return;
    expect(result.roofs).toHaveLength(2);
    expect(result.roofs[0]).toEqual({ areaSqFt: 2400.5, pitchX12: 6, structureIndex: 0 });
  });

  test('Failure status throws AerialUnavailableError', async () => {
    const { pd } = makePropertyData([
      {
        match: PD_RESULT_PART,
        replies: [{ status: 200, json: { request: { id: REQUEST_ID, status: 'Failure' } } }],
      },
    ]);
    await expect(pd.result(REQUEST_ID)).rejects.toBeInstanceOf(AerialUnavailableError);
  });
});

describe('factories', () => {
  test('eagleViewOrdersFor is null without client id and secret', () => {
    expect(eagleViewOrdersFor(configWith({ EAGLEVIEW_PRODUCT_ID: PRODUCT_ID }))).toBeNull();
    expect(eagleViewOrdersFor(configWith({ EAGLEVIEW_CLIENT_ID: CLIENT_ID, EAGLEVIEW_PRODUCT_ID: PRODUCT_ID }))).toBeNull();
  });

  test('eagleViewOrdersFor is null when EAGLEVIEW_PRODUCT_ID is 0', () => {
    expect(eagleViewOrdersFor(configWith({ ...CONFIGURED, EAGLEVIEW_PRODUCT_ID: 0 }))).toBeNull();
  });

  test('eagleViewOrdersFor is configured when the credentials and product id are set', () => {
    expect(eagleViewOrdersFor(CONFIGURED)?.configured).toBe(true);
  });

  test('eagleViewPropertyDataFor is null without credentials and configured with them', () => {
    expect(eagleViewPropertyDataFor(configWith({}))).toBeNull();
    expect(eagleViewPropertyDataFor(CONFIGURED)?.configured).toBe(true);
  });
});

describe('no leaks', () => {
  /*
   * Each failure path runs with provider bodies and thrown messages that carry the secret, the token,
   * the street and the provider marker. The thrown error must carry none of them.
   */
  const LEAK_MARKERS = [CLIENT_SECRET, TOKEN, STREET, PROVIDER_SECRET_TEXT];
  const leakyBody = `${PROVIDER_SECRET_TEXT} ${STREET} ${TOKEN} ${CLIENT_SECRET}`;
  const leakyError = () => new Error(`${PROVIDER_SECRET_TEXT} ${STREET} ${TOKEN} ${CLIENT_SECRET}`);

  const failurePaths: { name: string; run: () => Promise<unknown> }[] = [
    {
      name: 'price 503',
      run: () => makeOrders([{ match: PRICE_ROUTE_PART, replies: [{ status: 503, text: leakyBody }] }]).orders.price(ORDER_INPUT),
    },
    {
      name: 'place-order 403',
      run: () => makeOrders([{ match: PLACE_ROUTE_PART, replies: [{ status: 403, text: leakyBody }] }]).orders.order(ORDER_INPUT),
    },
    {
      name: 'price thrown fetch',
      run: () => makeOrders([{ match: PRICE_ROUTE_PART, replies: [leakyError()] }]).orders.price(ORDER_INPUT),
    },
    {
      name: 'report thrown fetch',
      run: () => makeOrders([{ match: REPORT_ROUTE_PART, replies: [leakyError()] }]).orders.report(REPORT_ID),
    },
    {
      name: 'uncertain order on 500',
      run: () => makeOrders([{ match: PLACE_ROUTE_PART, replies: [{ status: 500, text: leakyBody }] }]).orders.order(ORDER_INPUT),
    },
    {
      name: 'uncertain order on thrown fetch',
      run: () => makeOrders([{ match: PLACE_ROUTE_PART, replies: [leakyError()] }]).orders.order(ORDER_INPUT),
    },
    {
      name: 'uncertain order on empty ReportIds',
      run: () =>
        makeOrders([{ match: PLACE_ROUTE_PART, replies: [{ status: 200, text: leakyBody }] }]).orders.order(ORDER_INPUT),
    },
    {
      name: 'property-data start 503',
      run: () =>
        makePropertyData([{ match: PD_REQUEST_PART, replies: [{ status: 503, text: leakyBody }] }]).pd.start(
          `${STREET}, Omaha, NE 68102`,
        ),
    },
    {
      name: 'property-data result thrown fetch',
      run: () => makePropertyData([{ match: PD_RESULT_PART, replies: [leakyError()] }]).pd.result(REQUEST_ID),
    },
  ];

  for (const path of failurePaths) {
    test(`${path.name} error message carries no secret, token, street or provider text`, async () => {
      const thrown = await path.run().then(
        () => null,
        (err: unknown) => err,
      );
      expect(thrown).toBeInstanceOf(Error);
      const err = thrown as Error;
      for (const marker of LEAK_MARKERS) {
        expect(err.message).not.toContain(marker);
        expect(String(err)).not.toContain(marker);
      }
    });
  }

  test('token endpoint rejection carries no secret or provider text', async () => {
    const stub = stubFetch([
      { match: TOKEN_URL_PART, replies: [{ status: 401, text: leakyBody }] },
    ]);
    const http = new EagleViewHttp({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      env: 'sandbox',
      fetch: stub.fetch,
      now: () => 0,
    });
    const thrown = await http.request('property', 'GET', `/property/v2/result/${REQUEST_ID}`).then(
      () => null,
      (err: unknown) => err,
    );
    expect(thrown).toBeInstanceOf(EagleViewHttpError);
    const err = thrown as Error;
    for (const marker of LEAK_MARKERS) {
      expect(err.message).not.toContain(marker);
      expect(String(err)).not.toContain(marker);
    }
  });
});
