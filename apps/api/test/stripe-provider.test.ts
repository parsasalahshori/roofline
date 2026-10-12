import { describe, expect, test } from 'vitest';
import { priceLookupKeys } from '@roofline/shared';
import type { Config } from '../src/config.ts';
import { BillingUnavailableError } from '../src/providers/billing.ts';
import { StripeBillingProvider, stripeFor } from '../src/providers/stripe.ts';

type Recorded = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: URLSearchParams;
};

const PRICES = {
  object: 'list',
  data: [
    { id: 'price_m', lookup_key: 'roofline_starter_monthly' },
    { id: 'price_ai', lookup_key: 'roofline_starter_ai_call_minute' },
    { id: 'price_sms', lookup_key: 'roofline_starter_sms_segment' },
  ],
  has_more: false,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Answers canned JSON by method and path, and records every call. */
function makeRecordingFetch(answer: (method: string, path: string) => Response | null = () => null) {
  const calls: Recorded[] = [];
  const recordingFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    const raw = init?.headers;
    if (raw instanceof Headers) {
      raw.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
    } else if (raw) {
      const entries = Array.isArray(raw) ? raw : Object.entries(raw as Record<string, string>);
      for (const [key, value] of entries as [string, string][]) {
        headers[key.toLowerCase()] = String(value);
      }
    }
    const body = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
    calls.push({ method, url: url.href, headers, body });

    const custom = answer(method, url.pathname);
    if (custom) return custom;
    if (method === 'GET' && url.pathname === '/v1/prices') return jsonResponse(PRICES);
    if (method === 'POST' && url.pathname === '/v1/checkout/sessions') {
      return jsonResponse({ id: 'cs_1', url: 'https://checkout.example/c1' });
    }
    if (method === 'POST' && url.pathname === '/v1/customers') return jsonResponse({ id: 'cus_1' });
    if (method === 'POST' && url.pathname === '/v1/billing/meter_events') return jsonResponse({ object: 'billing.meter_event' });
    if (method === 'POST' && url.pathname === '/v1/invoiceitems') return jsonResponse({ id: 'ii_1' });
    return jsonResponse({ error: { message: 'unexpected test call', type: 'invalid_request_error' } }, 404);
  };
  return { calls, fetch: recordingFetch as typeof fetch };
}

function providerWith(fetch: typeof globalThis.fetch) {
  return new StripeBillingProvider({ secretKey: 'sk_test_x', fetch, maxNetworkRetries: 0 });
}

const checkoutBase = {
  customerId: 'cus_1',
  companyId: 'co_1',
  planKey: 'starter',
  successUrl: 'https://app.example/billing?ok=1',
  cancelUrl: 'https://app.example/billing',
};

describe('StripeBillingProvider', () => {
  test('checkout sends the three prices in order', async () => {
    const rec = makeRecordingFetch();
    const provider = providerWith(rec.fetch);
    const result = await provider.createCheckout({
      ...checkoutBase,
      priceLookupKeys: [
        priceLookupKeys('starter').monthly,
        priceLookupKeys('starter').ai_call_minute,
        priceLookupKeys('starter').sms_segment,
      ],
      trialEnd: null,
    });

    const checkout = rec.calls.find((c) => c.url.includes('/v1/checkout/sessions'));
    expect(checkout).toBeDefined();
    const body = checkout!.body;
    expect(body.get('line_items[0][price]')).toBe('price_m');
    expect(body.get('line_items[0][quantity]')).toBe('1');
    expect(body.get('line_items[1][price]')).toBe('price_ai');
    expect(body.has('line_items[1][quantity]')).toBe(false);
    expect(body.get('line_items[2][price]')).toBe('price_sms');
    expect(body.get('mode')).toBe('subscription');
    expect(result).toEqual({ url: 'https://checkout.example/c1' });
  });

  test('checkout adds trial_end when given', async () => {
    const rec = makeRecordingFetch();
    const provider = providerWith(rec.fetch);
    await provider.createCheckout({
      ...checkoutBase,
      priceLookupKeys: [
        priceLookupKeys('starter').monthly,
        priceLookupKeys('starter').ai_call_minute,
        priceLookupKeys('starter').sms_segment,
      ],
      trialEnd: new Date('2030-01-01T00:00:00Z'),
    });

    const body = rec.calls.find((c) => c.url.includes('/v1/checkout/sessions'))!.body;
    expect(body.get('subscription_data[trial_end]')).toBe(String(1893456000));
  });

  test('checkout has no trial_end key when null', async () => {
    const rec = makeRecordingFetch();
    const provider = providerWith(rec.fetch);
    await provider.createCheckout({
      ...checkoutBase,
      priceLookupKeys: [
        priceLookupKeys('starter').monthly,
        priceLookupKeys('starter').ai_call_minute,
        priceLookupKeys('starter').sms_segment,
      ],
      trialEnd: null,
    });

    const body = rec.calls.find((c) => c.url.includes('/v1/checkout/sessions'))!.body;
    const keys = [...body.keys()];
    expect(keys.some((k) => k.includes('trial_end'))).toBe(false);
  });

  test('customer create uses the idempotency key', async () => {
    const rec = makeRecordingFetch();
    const provider = providerWith(rec.fetch);
    const result = await provider.ensureCustomer({
      companyId: 'co_42',
      name: 'Acme Roofing',
      email: 'owner@example.com',
      existingCustomerId: null,
    });

    const create = rec.calls.find((c) => c.method === 'POST' && c.url.includes('/v1/customers'));
    expect(create).toBeDefined();
    expect(create!.headers['idempotency-key']).toBe('customer:co_42');
    expect(create!.body.get('metadata[company_id]')).toBe('co_42');
    expect(result).toEqual({ customerId: 'cus_1' });
  });

  test('existing customer id makes no request', async () => {
    const rec = makeRecordingFetch();
    const provider = providerWith(rec.fetch);
    const result = await provider.ensureCustomer({
      companyId: 'co_42',
      name: 'Acme Roofing',
      email: null,
      existingCustomerId: 'cus_existing',
    });

    expect(rec.calls).toHaveLength(0);
    expect(result).toEqual({ customerId: 'cus_existing' });
  });

  test('meter event body has identifier and payload value', async () => {
    const rec = makeRecordingFetch();
    const provider = providerWith(rec.fetch);
    await provider.reportMeterEvent({
      eventName: 'roofline_sms_segment',
      customerId: 'cus_1',
      value: 5,
      identifier: 'usage_evt_1',
      timestamp: new Date('2030-01-01T00:00:00Z'),
    });

    const call = rec.calls.find((c) => c.url.includes('/v1/billing/meter_events'));
    expect(call).toBeDefined();
    expect(call!.method).toBe('POST');
    expect(call!.body.get('identifier')).toBe('usage_evt_1');
    expect(call!.body.get('payload[value]')).toBe('5');
    expect(call!.body.get('payload[stripe_customer_id]')).toBe('cus_1');
    expect(call!.body.get('event_name')).toBe('roofline_sms_segment');
  });

  test('invoice item has idempotency key and usd', async () => {
    const rec = makeRecordingFetch();
    const provider = providerWith(rec.fetch);
    const result = await provider.createInvoiceItem({
      customerId: 'cus_1',
      amountCents: 1234,
      description: 'Exact roof report — 812 Oak St',
      idempotencyKey: 'usage:abc123',
    });

    const call = rec.calls.find((c) => c.url.includes('/v1/invoiceitems'));
    expect(call).toBeDefined();
    expect(call!.headers['idempotency-key']).toBe('usage:abc123');
    expect(call!.body.get('currency')).toBe('usd');
    expect(call!.body.get('amount')).toBe('1234');
    expect(result).toEqual({ invoiceItemId: 'ii_1' });
  });

  test('a 503 becomes BillingUnavailableError', async () => {
    const rec = makeRecordingFetch((method, path) =>
      method === 'POST' && path === '/v1/customers'
        ? jsonResponse({ error: { message: 'service down', type: 'api_error' } }, 503)
        : null,
    );
    const provider = providerWith(rec.fetch);

    const failure = await provider
      .ensureCustomer({ companyId: 'co_1', name: 'Acme', email: null, existingCustomerId: null })
      .catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(BillingUnavailableError);
  });

  test('a 400 becomes a generic error', async () => {
    const rec = makeRecordingFetch((method, path) =>
      method === 'POST' && path === '/v1/customers'
        ? jsonResponse({ error: { message: 'secret provider words', type: 'invalid_request_error' } }, 400)
        : null,
    );
    const provider = providerWith(rec.fetch);

    const failure = await provider
      .ensureCustomer({ companyId: 'co_1', name: 'Acme', email: null, existingCustomerId: null })
      .catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(BillingUnavailableError);
    expect((failure as Error).message).toBe('Stripe refused the request.');
    expect((failure as Error).message).not.toContain('secret provider words');
  });

  test('the price list is fetched once for two checkouts', async () => {
    const rec = makeRecordingFetch();
    const provider = providerWith(rec.fetch);
    const input = {
      ...checkoutBase,
      priceLookupKeys: [
        priceLookupKeys('starter').monthly,
        priceLookupKeys('starter').ai_call_minute,
        priceLookupKeys('starter').sms_segment,
      ],
      trialEnd: null,
    };
    await provider.createCheckout(input);
    await provider.createCheckout(input);

    const priceCalls = rec.calls.filter((c) => c.method === 'GET' && c.url.includes('/v1/prices'));
    expect(priceCalls).toHaveLength(1);
  });
});

describe('stripeFor', () => {
  test('returns null when STRIPE_SECRET_KEY is unset', () => {
    expect(stripeFor({ STRIPE_SECRET_KEY: undefined } as unknown as Config)).toBeNull();
  });

  test('returns a StripeBillingProvider when STRIPE_SECRET_KEY is set', () => {
    const provider = stripeFor({ STRIPE_SECRET_KEY: 'sk_test_x' } as unknown as Config);
    expect(provider).toBeInstanceOf(StripeBillingProvider);
  });
});
