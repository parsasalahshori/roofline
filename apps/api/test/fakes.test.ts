import { describe, expect, test } from 'vitest';
import { DisabledSmsAdapter, FakeSmsAdapter } from '@roofline/send-gate';
import type { Config } from '../src/config.ts';
import {
  type BillingProvider,
  BillingUnavailableError,
  createBillingProvider,
  UnconfiguredBillingProvider,
} from '../src/providers/billing.ts';
import { FakeBillingProvider } from '../src/providers/fakes/billing.ts';
import { FakeGeocoder } from '../src/providers/fakes/geocoder.ts';
import { fakeSid, FakeTextingRegistrar } from '../src/providers/fakes/registrar.ts';
import { createGeocoder, type Geocoder, GeocoderUnavailableError, UnconfiguredGeocoder } from '../src/providers/geocoder.ts';
import { createRegistrar, RegistrarRejectedError, RegistrarUnavailableError } from '../src/providers/registrar.ts';
import { createSmsAdapter } from '../src/providers/sms.ts';

const fakeConfig = { FAKE_PROVIDERS: true } as unknown as Config;
const realConfig = { FAKE_PROVIDERS: undefined } as unknown as Config;

const OMAHA = { street: '1200 Farnam St', city: 'Omaha', state: 'NE', zip: '68102', timezone: 'America/Chicago' };

describe('FakeGeocoder', () => {
  test('parses street, city, state and zip, and gives the state timezone', async () => {
    const g = new FakeGeocoder();
    expect(g.configured).toBe(true);
    const r = await g.geocode('1200 Farnam St, Omaha, NE 68102');
    expect(r).toMatchObject(OMAHA);
    expect(r).toMatchObject({ accuracy: 1, accuracyType: 'rooftop', source: 'fake' });
  });

  test('the same address gives the same lng and lat, and every call is recorded', async () => {
    const g = new FakeGeocoder();
    const a = await g.geocode('1200 Farnam St, Omaha, NE 68102');
    const b = await g.geocode('1200 Farnam St, Omaha, NE 68102');
    expect(b?.lng).toBe(a?.lng);
    expect(b?.lat).toBe(a?.lat);
    expect(a?.lng).toBeGreaterThan(-96);
    expect(a?.lng).toBeLessThan(-95);
    expect(a?.lat).toBeGreaterThan(41);
    expect(a?.lat).toBeLessThan(42);
    expect(g.calls).toEqual([
      { method: 'geocode', args: ['1200 Farnam St, Omaha, NE 68102', undefined] },
      { method: 'geocode', args: ['1200 Farnam St, Omaha, NE 68102', undefined] },
    ]);
  });

  test('different addresses give different positions', async () => {
    const g = new FakeGeocoder();
    const a = await g.geocode('1 A St, Omaha, NE 68102');
    const b = await g.geocode('2 B St, Omaha, NE 68102');
    expect(a && b && (a.lng !== b.lng || a.lat !== b.lat)).toBe(true);
  });

  test('a /nowhere/ address gives null', async () => {
    const g = new FakeGeocoder();
    expect(await g.geocode('Nowhere Rd, Omaha, NE 68102')).toBeNull();
  });

  test('an /outage/ address rejects with GeocoderUnavailableError', async () => {
    const g = new FakeGeocoder();
    await expect(g.geocode('outage')).rejects.toBeInstanceOf(GeocoderUnavailableError);
  });

  test('missing parts come back as null', async () => {
    const g = new FakeGeocoder();
    const r = await g.geocode('1 Main St');
    expect(r).toMatchObject({ street: '1 Main St', city: null, state: null, zip: null });
  });

  test('two parts: a city before a state and zip gives the city', async () => {
    const g = new FakeGeocoder();
    expect(await g.geocode('1 A St, Omaha')).toMatchObject({ street: '1 A St', city: 'Omaha', state: null, zip: null });
  });

  test('two parts: a state and zip at the end gives state and zip, and no city', async () => {
    const g = new FakeGeocoder();
    expect(await g.geocode('1 A St, NE 68102')).toMatchObject({
      street: '1 A St',
      city: null,
      state: 'NE',
      zip: '68102',
      timezone: 'America/Chicago',
    });
  });

  test('a geocode call records the options it was given', async () => {
    const g = new FakeGeocoder();
    await g.geocode('1 A St, Omaha, NE 68102', { timeoutMs: 2000 });
    expect(g.calls.at(-1)).toEqual({ method: 'geocode', args: ['1 A St, Omaha, NE 68102', { timeoutMs: 2000 }] });
  });

  test('timezone follows the state table, with Chicago as the fallback', async () => {
    const g = new FakeGeocoder();
    const tz = async (state: string) => (await g.geocode(`1 Main St, Town, ${state} 10001`))?.timezone;
    expect(await tz('TX')).toBe('America/Chicago');
    expect(await tz('NY')).toBe('America/New_York');
    expect(await tz('FL')).toBe('America/New_York');
    expect(await tz('CO')).toBe('America/Denver');
    expect(await tz('AZ')).toBe('America/Phoenix');
    expect(await tz('CA')).toBe('America/Los_Angeles');
    expect(await tz('WA')).toBe('America/Los_Angeles');
    expect(await tz('ID')).toBe('America/Chicago');
  });

  test('geocodeMany returns per-item results, null for an outage item, and records one batch', async () => {
    const g = new FakeGeocoder();
    const out = await g.geocodeMany(['1 A St, Omaha, NE 68102', 'outage', '2 B St, Omaha, NE 68102']);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ street: '1 A St', state: 'NE' });
    expect(out[1]).toBeNull();
    expect(out[2]).toMatchObject({ street: '2 B St', state: 'NE' });
    expect(g.batches).toHaveLength(1);
    expect(g.batches[0]).toEqual(['1 A St, Omaha, NE 68102', 'outage', '2 B St, Omaha, NE 68102']);
    expect(g.calls.at(-1)?.method).toBe('geocodeMany');
  });

  test('failNext makes the next call throw, then calls succeed again', async () => {
    const g = new FakeGeocoder();
    g.failNext();
    await expect(g.geocode('1 A St, Omaha, NE 68102')).rejects.toBeInstanceOf(GeocoderUnavailableError);
    expect(await g.geocode('1 A St, Omaha, NE 68102')).toMatchObject({ state: 'NE' });
  });

  test('failNext(n) fails the next n calls', async () => {
    const g = new FakeGeocoder();
    g.failNext(2);
    await expect(g.geocode('1 A St, Omaha, NE 68102')).rejects.toBeInstanceOf(GeocoderUnavailableError);
    await expect(g.geocode('1 A St, Omaha, NE 68102')).rejects.toBeInstanceOf(GeocoderUnavailableError);
    expect(await g.geocode('1 A St, Omaha, NE 68102')).toMatchObject({ state: 'NE' });
  });

  test('failNext fails the whole geocodeMany batch', async () => {
    const g = new FakeGeocoder();
    g.failNext();
    await expect(g.geocodeMany(['1 A St, Omaha, NE 68102'])).rejects.toBeInstanceOf(GeocoderUnavailableError);
  });
});

describe('FakeBillingProvider', () => {
  test('ensureCustomer returns the existing id when one is given', async () => {
    const b = new FakeBillingProvider();
    expect(b.configured).toBe(true);
    const r = await b.ensureCustomer({ companyId: 'c1', name: 'Acme', email: null, existingCustomerId: 'cus_real_9' });
    expect(r).toEqual({ customerId: 'cus_real_9' });
  });

  test('the same company gets the same id, and new companies get cus_fake_1 then cus_fake_2', async () => {
    const b = new FakeBillingProvider();
    const a1 = await b.ensureCustomer({ companyId: 'c1', name: 'A', email: null, existingCustomerId: null });
    const a2 = await b.ensureCustomer({ companyId: 'c1', name: 'A', email: null, existingCustomerId: null });
    const z = await b.ensureCustomer({ companyId: 'c2', name: 'Z', email: 'z@x.test', existingCustomerId: null });
    expect(a1.customerId).toBe('cus_fake_1');
    expect(a2.customerId).toBe('cus_fake_1');
    expect(z.customerId).toBe('cus_fake_2');
    expect(b.calls.map((c) => c.method)).toEqual(['ensureCustomer', 'ensureCustomer', 'ensureCustomer']);
  });

  test('createCheckout returns a checkout url and records the input', async () => {
    const b = new FakeBillingProvider();
    const input = {
      customerId: 'cus_fake_1',
      companyId: 'c1',
      planKey: 'starter',
      priceLookupKeys: ['starter_monthly'],
      trialEnd: null,
      successUrl: 'https://app.test/ok',
      cancelUrl: 'https://app.test/no',
    };
    const r = await b.createCheckout(input);
    expect(r).toEqual({ url: 'https://checkout.stripe.test/c/cs_fake_1' });
    expect(b.checkouts).toEqual([input]);
  });

  test('createPortal returns a portal url and records the input', async () => {
    const b = new FakeBillingProvider();
    const input = { customerId: 'cus_fake_1', returnUrl: 'https://app.test/settings' };
    const r = await b.createPortal(input);
    expect(r).toEqual({ url: 'https://billing.stripe.test/p/bps_fake_1' });
    expect(b.portals).toEqual([input]);
    const r2 = await b.createPortal(input);
    expect(r2.url).toBe('https://billing.stripe.test/p/bps_fake_2');
  });

  test('changePlan is recorded', async () => {
    const b = new FakeBillingProvider();
    const input = { subscriptionId: 'sub_fake_1', planKey: 'pro', priceLookupKeys: ['pro_monthly'] };
    await b.changePlan(input);
    expect(b.planChanges).toEqual([input]);
  });

  test('reportMeterEvent ignores a repeated identifier', async () => {
    const b = new FakeBillingProvider();
    const timestamp = new Date('2026-10-01T00:00:00Z');
    const ev = { eventName: 'texts', customerId: 'cus_fake_1', value: 3, identifier: 'usage:c1:2026-10-01', timestamp };
    await b.reportMeterEvent(ev);
    await b.reportMeterEvent(ev);
    await b.reportMeterEvent({ ...ev, identifier: 'usage:c1:2026-10-02' });
    expect(b.meterEvents).toEqual([ev, { ...ev, identifier: 'usage:c1:2026-10-02' }]);
    expect(b.calls.filter((c) => c.method === 'reportMeterEvent')).toHaveLength(3);
  });

  test('createInvoiceItem with one key twice gives the same id and one record', async () => {
    const b = new FakeBillingProvider();
    const input = { customerId: 'cus_fake_1', amountCents: 1500, description: 'Monthly fee', idempotencyKey: 'fee:c1:2026-10' };
    const first = await b.createInvoiceItem(input);
    const second = await b.createInvoiceItem(input);
    expect(first).toEqual({ invoiceItemId: 'ii_fake_1' });
    expect(second).toEqual(first);
    expect(b.invoiceItems).toEqual([{ ...input, invoiceItemId: 'ii_fake_1' }]);
  });

  test('failNext makes the next call throw BillingUnavailableError', async () => {
    const b = new FakeBillingProvider();
    b.failNext();
    await expect(b.createPortal({ customerId: 'cus_fake_1', returnUrl: 'https://app.test' })).rejects.toBeInstanceOf(
      BillingUnavailableError,
    );
    expect((await b.createPortal({ customerId: 'cus_fake_1', returnUrl: 'https://app.test' })).url).toMatch(/bps_fake_/);
  });
});

describe('fakeSid', () => {
  test('is the prefix followed by 32 lowercase hex characters, and is deterministic', () => {
    const sid = fakeSid('AC', 'company-1');
    expect(sid).toMatch(/^AC[0-9a-f]{32}$/);
    expect(fakeSid('AC', 'company-1')).toBe(sid);
    expect(fakeSid('AC', 'company-2')).not.toBe(sid);
    expect(fakeSid('MG', 'company-1')).toMatch(/^MG[0-9a-f]{32}$/);
  });
});

describe('FakeTextingRegistrar', () => {
  const sub = { accountSid: 'AC' + '0'.repeat(32), authToken: 'tok' };
  const brand = {
    companyId: 'company-1',
    brand: {} as never,
    statusCallback: 'https://app.test/cb',
    previous: { customerProfileSid: null, trustProductSid: null, brandSid: null },
  };

  test('ensureSubaccount gives an AC sid and a fake token', async () => {
    const r = new FakeTextingRegistrar();
    expect(r.configured).toBe(true);
    const out = await r.ensureSubaccount('company-1234567');
    expect(out).toEqual({ accountSid: fakeSid('AC', 'company-1234567'), authToken: 'fake-token-company-' });
  });

  test('ensureMessagingService gives an MG sid', async () => {
    const r = new FakeTextingRegistrar();
    const out = await r.ensureMessagingService(sub, 'company-1', { inbound: 'https://a', status: 'https://b' });
    expect(out).toEqual({ messagingServiceSid: fakeSid('MG', 'company-1') });
  });

  test('ensureNumber uses +1, the area code or 402, and 5550100; the same on repeat', async () => {
    const r = new FakeTextingRegistrar();
    const mg = fakeSid('MG', 'company-1');
    const a = await r.ensureNumber(sub, { messagingServiceSid: mg, areaCode: null, state: 'NE' });
    expect(a).toEqual({
      e164: '+14025550100',
      phoneNumberSid: fakeSid('PN', mg),
      capabilities: ['sms', 'voice'],
    });
    const b = await r.ensureNumber(sub, { messagingServiceSid: mg, areaCode: '212', state: 'NY' });
    expect(b.e164).toBe('+12125550100');
    const again = await r.ensureNumber(sub, { messagingServiceSid: mg, areaCode: null, state: 'NE' });
    expect(again).toEqual(a);
  });

  test('submitBrand gives the profile, trust product and brand sids', async () => {
    const r = new FakeTextingRegistrar();
    const out = await r.submitBrand(sub, brand);
    expect(out).toEqual({
      customerProfileSid: fakeSid('BU', 'cp:company-1'),
      trustProductSid: fakeSid('BU', 'tp:company-1'),
      brandSid: fakeSid('BN', 'company-1'),
    });
  });

  test('submitBrand reports each step through onProgress, in order, with the returned sids', async () => {
    const r = new FakeTextingRegistrar();
    const seen: unknown[] = [];
    const out = await r.submitBrand(sub, { ...brand, onProgress: (p) => seen.push(p) });
    expect(seen).toEqual([
      { customerProfileSid: out.customerProfileSid },
      { trustProductSid: out.trustProductSid },
      { brandSid: out.brandSid },
    ]);
  });

  test('failAfter(customerProfile, unavailable) reports the profile sid once, then throws, for one call only', async () => {
    const r = new FakeTextingRegistrar();
    r.failAfter('customerProfile', 'unavailable');
    const seen: unknown[] = [];
    const err = await r.submitBrand(sub, { ...brand, onProgress: (p) => seen.push(p) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RegistrarUnavailableError);
    expect(seen).toEqual([{ customerProfileSid: fakeSid('BU', 'cp:company-1') }]);
    await expect(r.submitBrand(sub, brand)).resolves.toMatchObject({ brandSid: fakeSid('BN', 'company-1') });
  });

  test('failAfter(trustProduct, rejected) reports two steps, then rejects with the text', async () => {
    const r = new FakeTextingRegistrar();
    r.failAfter('trustProduct', { rejected: 'EIN mismatch' });
    const seen: unknown[] = [];
    const err = await r.submitBrand(sub, { ...brand, onProgress: (p) => seen.push(p) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RegistrarRejectedError);
    expect((err as RegistrarRejectedError).reasonText).toBe('EIN mismatch');
    expect(seen).toHaveLength(2);
  });

  test('submitCampaign gives a QE sid from the brand sid', async () => {
    const r = new FakeTextingRegistrar();
    const out = await r.submitCampaign(sub, {
      brandSid: 'BN123',
      messagingServiceSid: 'MG1',
      campaign: {} as never,
      previousCampaignSid: null,
    });
    expect(out).toEqual({ campaignSid: fakeSid('QE', 'BN123') });
  });

  test('brand and campaign statuses start pending and setBrand / setCampaign change them', async () => {
    const r = new FakeTextingRegistrar();
    expect(await r.brandStatus(sub, 'BN1')).toEqual({ status: 'pending', failureReason: null });
    expect(await r.campaignStatus(sub, 'MG1', 'QE1')).toEqual({ status: 'pending', failureReason: null });
    r.setBrand('approved');
    r.setCampaign('failed', 'Sample messages too short');
    expect(await r.brandStatus(sub, 'BN1')).toEqual({ status: 'approved', failureReason: null });
    expect(await r.campaignStatus(sub, 'MG1', 'QE1')).toEqual({ status: 'failed', failureReason: 'Sample messages too short' });
  });

  test('failNext(submitBrand, rejected) rejects the next submitBrand only', async () => {
    const r = new FakeTextingRegistrar();
    r.failNext('submitBrand', { rejected: 'EIN mismatch' });
    const err = await r.submitBrand(sub, brand).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RegistrarRejectedError);
    expect((err as RegistrarRejectedError).reasonText).toBe('EIN mismatch');
    await expect(r.submitBrand(sub, brand)).resolves.toMatchObject({ brandSid: fakeSid('BN', 'company-1') });
  });

  test('failNext(ensureNumber, unavailable) throws RegistrarUnavailableError, not a rejection', async () => {
    const r = new FakeTextingRegistrar();
    r.failNext('ensureNumber', 'unavailable');
    const call = () => r.ensureNumber(sub, { messagingServiceSid: 'MG1', areaCode: null, state: null });
    const err = await call().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RegistrarUnavailableError);
    expect(err).not.toBeInstanceOf(RegistrarRejectedError);
    await expect(call()).resolves.toMatchObject({ e164: '+14025550100' });
  });
});

describe('unconfigured adapters and factories', () => {
  test('UnconfiguredGeocoder is not configured and throws the setup message', async () => {
    const g: Geocoder = new UnconfiguredGeocoder();
    expect(g.configured).toBe(false);
    await expect(g.geocode('1 A St, Omaha, NE 68102')).rejects.toBeInstanceOf(GeocoderUnavailableError);
    await expect(g.geocode('1 A St, Omaha, NE 68102')).rejects.toThrow("Address lookup isn't set up.");
    await expect(g.geocodeMany(['x'])).rejects.toThrow("Address lookup isn't set up.");
  });

  test('UnconfiguredBillingProvider is not configured and throws the setup message', async () => {
    const b: BillingProvider = new UnconfiguredBillingProvider();
    expect(b.configured).toBe(false);
    await expect(b.createPortal({ customerId: 'x', returnUrl: 'https://app.test' })).rejects.toBeInstanceOf(
      BillingUnavailableError,
    );
    await expect(b.createPortal({ customerId: 'x', returnUrl: 'https://app.test' })).rejects.toThrow("Billing isn't set up.");
  });

  test('the unconfigured registrar throws RegistrarUnavailableError with the setup message', async () => {
    const r = createRegistrar(realConfig);
    expect(r.configured).toBe(false);
    await expect(r.ensureSubaccount('company-1')).rejects.toBeInstanceOf(RegistrarUnavailableError);
    await expect(r.ensureSubaccount('company-1')).rejects.toThrow("Texting registration isn't set up.");
    await expect(r.brandStatus({ accountSid: 'AC', authToken: 't' }, 'BN1')).rejects.toThrow(
      "Texting registration isn't set up.",
    );
  });

  test('createGeocoder, createBillingProvider and createRegistrar pick the fakes when FAKE_PROVIDERS is set', () => {
    expect(createGeocoder(fakeConfig)).toBeInstanceOf(FakeGeocoder);
    expect(createBillingProvider(fakeConfig)).toBeInstanceOf(FakeBillingProvider);
    expect(createRegistrar(fakeConfig)).toBeInstanceOf(FakeTextingRegistrar);
    expect(createSmsAdapter(fakeConfig)).toBeInstanceOf(FakeSmsAdapter);
  });

  test('without FAKE_PROVIDERS and no real adapter, the factories are unconfigured', () => {
    expect(createGeocoder(realConfig)).toBeInstanceOf(UnconfiguredGeocoder);
    expect(createGeocoder(realConfig).configured).toBe(false);
    expect(createBillingProvider(realConfig)).toBeInstanceOf(UnconfiguredBillingProvider);
    expect(createBillingProvider(realConfig).configured).toBe(false);
    expect(createRegistrar(realConfig).configured).toBe(false);
    expect(createSmsAdapter(realConfig)).toBeInstanceOf(DisabledSmsAdapter);
  });
});
