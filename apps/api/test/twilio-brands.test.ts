import { buildCampaign, type BrandInfo } from '@roofline/shared';
import { describe, expect, test } from 'vitest';
import { RegistrarRejectedError, RegistrarUnavailableError } from '../src/providers/registrar.ts';
import { A2P_PROFILE_POLICY, SECONDARY_PROFILE_POLICY, TwilioBrands } from '../src/providers/twilio/brands.ts';
import { TWILIO_API, TWILIO_MESSAGING, TWILIO_TRUSTHUB, TwilioHttp } from '../src/providers/twilio/http.ts';
import { fixtureFetch, type RecordedRequest } from './twilio-fixtures.ts';

/** Master credentials (the ones we hold) and a company's subaccount (the one its registration runs as). */
const master = { accountSid: 'AC00000000000000000000000000000000', authToken: 'master-token' };
const sub = { accountSid: 'AC11111111111111111111111111111111', authToken: 'sub-auth-token' };
const PRIMARY = 'BU33333333333333333333333333333333';
const MG = 'MG22222222222222222222222222222222';
const BU = 'BU11111111111111111111111111111111';
const BW = 'BW11111111111111111111111111111111';
const BN = 'BN11111111111111111111111111111111';
const IT1 = 'IT11111111111111111111111111111111';
const IT2 = 'IT22222222222222222222222222222222';
const RD1 = 'RD11111111111111111111111111111111';
const AD1 = 'AD11111111111111111111111111111111';
const QE = 'QE11111111111111111111111111111111';
const TH = TWILIO_TRUSTHUB;
const MSG = TWILIO_MESSAGING;
const API = TWILIO_API;
const companyId = '00000000-0000-4000-8000-0000000000c1';
const statusCallback = 'https://app.roofline.test/hooks/twilio/status';
const campaign = buildCampaign({ companyName: 'Acme Roofing', companyPhone: '+14025550199', privacyUrl: 'P', termsUrl: 'T' });
type Previous = { customerProfileSid: string | null; trustProductSid: string | null; brandSid: string | null };
const none: Previous = { customerProfileSid: null, trustProductSid: null, brandSid: null };
const previous: Previous = { customerProfileSid: BU, trustProductSid: BW, brandSid: BN };

const brandBase: BrandInfo = {
  legalName: 'Acme Roofing LLC',
  ein: '12-3456789',
  businessType: 'llc',
  street: '1 Main St',
  city: 'Omaha',
  state: 'NE',
  zip: '68102',
  website: 'https://acme.test',
  contactFirstName: 'Ada',
  contactLastName: 'Lee',
  contactEmail: 'ada@acme.test',
  contactPhone: '+14025550199',
  contactTitle: 'Owner',
};
const brand = (over: Partial<BrandInfo> = {}): BrandInfo => ({ ...brandBase, ...over });

function basic(sid: string, token: string): string {
  return `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`;
}

/** METHOD pathname for each recorded request, e.g. 'POST /v1/EndUsers'. */
function log(f: { requests: RecordedRequest[] }): string[] {
  return f.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`);
}

/** The form body of the request at index i; the test fails when that request had none. */
function formAt(f: { requests: RecordedRequest[] }, i: number): URLSearchParams {
  const form = f.requests[i]?.form;
  if (!form) throw new Error(`request ${i} has no form body`);
  return form;
}

function brandsWith(f: typeof fetch, primaryProfileSid = PRIMARY): TwilioBrands {
  return new TwilioBrands({ http: new TwilioHttp({ ...master, fetch: f }), primaryProfileSid });
}

/** Routes for the fresh flow. Longer prefixes win, so the deeper per-profile routes are listed explicitly. */
function freshRoutes(): Record<string, string | string[]> {
  return {
    [`POST ${TH}/CustomerProfiles`]: 'profile-create',
    [`POST ${TH}/CustomerProfiles/${BU}/EntityAssignments`]: 'assignment-create',
    [`POST ${TH}/CustomerProfiles/${BU}/Evaluations`]: 'evaluation-compliant',
    [`POST ${TH}/CustomerProfiles/${BU}`]: 'profile-submit',
    [`POST ${TH}/EndUsers`]: 'enduser-create',
    [`POST ${API}/Accounts/${sub.accountSid}/Addresses.json`]: 'address-create',
    [`POST ${TH}/SupportingDocuments`]: 'document-create',
    [`POST ${TH}/TrustProducts`]: 'trust-create',
    [`POST ${TH}/TrustProducts/${BW}/EntityAssignments`]: 'assignment-create',
    [`POST ${TH}/TrustProducts/${BW}/Evaluations`]: 'evaluation-compliant',
    [`POST ${TH}/TrustProducts/${BW}`]: 'profile-submit',
    [`POST ${MSG}/a2p/BrandRegistrations`]: 'brand-create',
  };
}

const submitArgs = (b: BrandInfo = brand(), prev: Previous = none) => ({
  companyId,
  brand: b,
  statusCallback,
  previous: prev,
});

describe('TwilioBrands', () => {
  test('submits the business profile, the messaging profile and the brand, in order', async () => {
    const f = fixtureFetch(freshRoutes());
    const result = await brandsWith(f).submitBrand(sub, submitArgs());

    expect(log(f)).toEqual([
      'POST /v1/CustomerProfiles',
      'POST /v1/EndUsers',
      `POST /v1/CustomerProfiles/${BU}/EntityAssignments`,
      'POST /v1/EndUsers',
      `POST /v1/CustomerProfiles/${BU}/EntityAssignments`,
      `POST /2010-04-01/Accounts/${sub.accountSid}/Addresses.json`,
      'POST /v1/SupportingDocuments',
      `POST /v1/CustomerProfiles/${BU}/EntityAssignments`,
      `POST /v1/CustomerProfiles/${BU}/EntityAssignments`,
      `POST /v1/CustomerProfiles/${BU}/Evaluations`,
      `POST /v1/CustomerProfiles/${BU}`,
      'POST /v1/TrustProducts',
      'POST /v1/EndUsers',
      `POST /v1/TrustProducts/${BW}/EntityAssignments`,
      `POST /v1/TrustProducts/${BW}/EntityAssignments`,
      `POST /v1/TrustProducts/${BW}/Evaluations`,
      `POST /v1/TrustProducts/${BW}`,
      'POST /v1/a2p/BrandRegistrations',
    ]);
    expect(result).toEqual({ customerProfileSid: BU, trustProductSid: BW, brandSid: BN });

    expect(formAt(f, 0).get('FriendlyName')).toBe(`Roofline ${companyId}`);
    expect(formAt(f, 0).get('PolicySid')).toBe(SECONDARY_PROFILE_POLICY);
    expect(formAt(f, 0).get('StatusCallback')).toBe(statusCallback);
    expect(formAt(f, 8).get('ObjectSid')).toBe(PRIMARY);
    expect(formAt(f, 10).get('Status')).toBe('pending-review');
    expect(formAt(f, 11).get('PolicySid')).toBe(A2P_PROFILE_POLICY);
    expect(formAt(f, 16).get('Status')).toBe('pending-review');
    expect(formAt(f, 17).get('CustomerProfileBundleSid')).toBe(BU);
    expect(formAt(f, 17).get('A2PProfileBundleSid')).toBe(BW);
    expect(formAt(f, 17).get('BrandType')).toBe('STANDARD');
  });

  test('maps the business type and EIN', async () => {
    const f = fixtureFetch(freshRoutes());
    await brandsWith(f).submitBrand(sub, submitArgs());

    expect(JSON.parse(formAt(f, 1).get('Attributes') ?? '')).toEqual({
      business_name: 'Acme Roofing LLC',
      business_identity: 'direct_customer',
      business_type: 'Limited Liability Corporation',
      business_industry: 'CONSTRUCTION',
      business_registration_identifier: 'EIN',
      business_registration_number: '123456789',
      business_regions_of_operation: 'USA_AND_CANADA',
      website_url: 'https://acme.test',
    });
  });

  test.each([
    ['corporation', 'Corporation'],
    ['partnership', 'Partnership'],
    ['non_profit', 'Non-profit Corporation'],
  ] as const)('maps the business type %s to %s', async (businessType, twilioName) => {
    const f = fixtureFetch(freshRoutes());
    await brandsWith(f).submitBrand(sub, submitArgs(brand({ businessType })));

    const attributes = JSON.parse(formAt(f, 1).get('Attributes') ?? '') as Record<string, string>;
    expect(attributes.business_type).toBe(twilioName);
  });

  test('a non-compliant evaluation is a rejection with a plain reason', async () => {
    const f = fixtureFetch({
      ...freshRoutes(),
      [`POST ${TH}/CustomerProfiles/${BU}/Evaluations`]: 'evaluation-noncompliant',
    });
    const attempt = brandsWith(f).submitBrand(sub, submitArgs());

    await expect(attempt).rejects.toBeInstanceOf(RegistrarRejectedError);
    await expect(attempt).rejects.toMatchObject({ reasonText: 'Business Registration Number' });
    expect(f.requests.some((r) => r.url.includes('/a2p/BrandRegistrations'))).toBe(false);
  });

  test('a Twilio refusal keeps only its code, and an unreachable Twilio is unavailable', async () => {
    const refused = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ code: 20404, message: 'secret+14025550199' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
      )) as unknown as typeof fetch;
    const rejected = brandsWith(refused).submitBrand(sub, submitArgs());

    await expect(rejected).rejects.toBeInstanceOf(RegistrarRejectedError);
    await expect(rejected).rejects.toMatchObject({ reasonText: 'Twilio error 20404' });
    const error = await rejected.catch((e: unknown) => e);
    expect((error as RegistrarRejectedError).reasonText).not.toContain('4025550199');

    const down = (() => Promise.reject(new Error('socket hang up'))) as unknown as typeof fetch;
    const unavailable = brandsWith(down).submitBrand(sub, submitArgs());
    await expect(unavailable).rejects.toBeInstanceOf(RegistrarUnavailableError);
    await expect(unavailable).rejects.toThrow("Twilio didn't answer.");
  });

  /** A fetch that answers one method and url with a status and a body, and everything else from the fixtures. */
  function failing(base: ReturnType<typeof fixtureFetch>, method: string, prefix: string, status: number, body: unknown): typeof fetch {
    return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if ((init?.method ?? 'GET').toUpperCase() === method && url === prefix) {
        return Promise.resolve(
          new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
        );
      }
      return base(input, init);
    }) as typeof fetch;
  }

  test.each([429, 403, 401])('a %i from Twilio is unavailable, with the code only', async (status) => {
    const f = failing(fixtureFetch(freshRoutes()), 'POST', `${MSG}/a2p/BrandRegistrations`, status, {
      code: 20429,
      message: 'secret+14025550199',
    });
    const error = await brandsWith(f)
      .submitBrand(sub, submitArgs())
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(RegistrarUnavailableError);
    expect((error as Error).message).toMatch(/code 20429/);
    expect((error as Error).message).not.toContain('secret');
    expect((error as Error).message).not.toContain('4025550199');
  });

  test('progress is reported as each id exists, and survives a later failure', async () => {
    const ok: Array<Record<string, string | undefined>> = [];
    await brandsWith(fixtureFetch(freshRoutes())).submitBrand(sub, {
      ...submitArgs(),
      onProgress: (p) => ok.push({ ...p }),
    });
    expect(ok).toEqual([{ customerProfileSid: BU }, { trustProductSid: BW }, { brandSid: BN }]);

    const seen: Array<Record<string, string | undefined>> = [];
    const f = failing(fixtureFetch(freshRoutes()), 'POST', `${TH}/TrustProducts`, 500, { code: 20500 });
    await expect(
      brandsWith(f).submitBrand(sub, { ...submitArgs(), onProgress: (p) => seen.push({ ...p }) }),
    ).rejects.toBeInstanceOf(RegistrarUnavailableError);
    expect(seen).toEqual([{ customerProfileSid: BU }]);
  });

  test('brand statuses', async () => {
    const statusOf = (name: string) =>
      brandsWith(fixtureFetch({ [`GET ${MSG}/a2p/BrandRegistrations/${BN}`]: name })).brandStatus(sub, BN);

    expect(await statusOf('brand-pending')).toEqual({ status: 'pending', failureReason: null });
    expect(await statusOf('brand-approved')).toEqual({ status: 'approved', failureReason: null });
    expect(await statusOf('brand-failed')).toEqual({
      status: 'failed',
      failureReason: 'EIN does not match the legal name',
    });
  });

  test('the campaign uses the mixed use case and our samples', async () => {
    const f = fixtureFetch({ [`POST ${MSG}/Services/${MG}/Compliance/Usa2p`]: 'campaign-create' });
    const result = await brandsWith(f).submitCampaign(sub, {
      brandSid: BN,
      messagingServiceSid: MG,
      campaign,
      previousCampaignSid: null,
    });

    expect(result).toEqual({ campaignSid: QE });
    const form = formAt(f, 0);
    expect(form.getAll('MessageSamples')).toEqual(campaign.samples);
    expect(form.get('UsAppToPersonUsecase')).toBe('MIXED');
    expect(form.get('HasEmbeddedLinks')).toBe('true');
    expect(form.get('HasEmbeddedPhone')).toBe('true');
    expect(form.get('BrandRegistrationSid')).toBe(BN);
    expect(form.get('OptInKeywords')).toBe('START');
    expect(form.get('OptOutKeywords')).toBe('STOP');
    expect(form.get('HelpKeywords')).toBe('HELP');
    expect(form.get('Description')).toBe(campaign.description);
    expect(form.get('MessageFlow')).toBe(campaign.messageFlow);
    expect(form.get('OptInMessage')).toBe(campaign.optInMessage);
    expect(form.get('OptOutMessage')).toBe(campaign.optOutMessage);
    expect(form.get('HelpMessage')).toBe(campaign.helpMessage);
  });

  test('resubmitting a failed campaign deletes the old one first', async () => {
    const f = fixtureFetch({
      [`DELETE ${MSG}/Services/${MG}/Compliance/Usa2p/${QE}`]: '{}',
      [`POST ${MSG}/Services/${MG}/Compliance/Usa2p`]: 'campaign-create',
    });
    await brandsWith(f).submitCampaign(sub, {
      brandSid: BN,
      messagingServiceSid: MG,
      campaign,
      previousCampaignSid: QE,
    });

    expect(log(f)).toEqual([`DELETE /v1/Services/${MG}/Compliance/Usa2p/${QE}`, `POST /v1/Services/${MG}/Compliance/Usa2p`]);
  });

  test('campaign statuses', async () => {
    const statusOf = (body: string) =>
      brandsWith(fixtureFetch({ [`GET ${MSG}/Services/${MG}/Compliance/Usa2p/${QE}`]: body })).campaignStatus(sub, MG, QE);

    expect(await statusOf('campaign-verified')).toEqual({ status: 'approved', failureReason: null });
    expect(await statusOf('campaign-failed')).toEqual({
      status: 'failed',
      failureReason: 'Sample messages do not match the use case',
    });
    expect(await statusOf('{"campaign_status":"EXPIRED"}')).toEqual({ status: 'failed', failureReason: null });
    expect(await statusOf('campaign-pending')).toEqual({ status: 'pending', failureReason: null });
  });

  test('resubmitting a fixed brand updates the profile in place', async () => {
    const f = fixtureFetch({
      [`GET ${TH}/CustomerProfiles/${BU}/EntityAssignments`]: 'assignments-list',
      [`GET ${TH}/EndUsers/${IT1}`]: 'enduser-get-business',
      [`GET ${TH}/EndUsers/${IT2}`]: 'enduser-get-rep',
      [`GET ${TH}/SupportingDocuments/${RD1}`]: 'document-get',
      [`POST ${TH}/EndUsers/${IT1}`]: 'enduser-update',
      [`POST ${TH}/EndUsers/${IT2}`]: 'enduser-update',
      [`GET ${TH}/TrustProducts/${BW}/EntityAssignments`]: 'trust-assignments-both',
      [`POST ${API}/Accounts/${sub.accountSid}/Addresses/${AD1}.json`]: 'address-update',
      [`POST ${TH}/CustomerProfiles/${BU}/Evaluations`]: 'evaluation-compliant',
      [`POST ${TH}/CustomerProfiles/${BU}`]: 'profile-submit',
      [`POST ${TH}/TrustProducts/${BW}/Evaluations`]: 'evaluation-compliant',
      [`POST ${TH}/TrustProducts/${BW}`]: 'profile-submit',
      [`POST ${MSG}/a2p/BrandRegistrations/${BN}`]: 'brand-pending',
    });
    const result = await brandsWith(f).submitBrand(sub, submitArgs(brand({ ein: '98-7654321' }), previous));

    expect(log(f)).toEqual([
      `GET /v1/CustomerProfiles/${BU}/EntityAssignments`,
      `GET /v1/EndUsers/${IT1}`,
      `GET /v1/EndUsers/${IT2}`,
      `GET /v1/SupportingDocuments/${RD1}`,
      `POST /v1/EndUsers/${IT1}`,
      `POST /v1/EndUsers/${IT2}`,
      `POST /2010-04-01/Accounts/${sub.accountSid}/Addresses/${AD1}.json`,
      `POST /v1/CustomerProfiles/${BU}/Evaluations`,
      `POST /v1/CustomerProfiles/${BU}`,
      `GET /v1/TrustProducts/${BW}/EntityAssignments`,
      `POST /v1/TrustProducts/${BW}/Evaluations`,
      `POST /v1/TrustProducts/${BW}`,
      `POST /v1/a2p/BrandRegistrations/${BN}`,
    ]);
    expect(log(f)).not.toContain('POST /v1/CustomerProfiles');
    expect(result).toEqual(previous);

    const business = JSON.parse(formAt(f, 4).get('Attributes') ?? '') as Record<string, string>;
    expect(business.business_registration_number).toBe('987654321');

    const address = formAt(f, 6);
    expect(address.get('Street')).toBe('1 Main St');
    expect(address.get('City')).toBe('Omaha');
    expect(address.get('Region')).toBe('NE');
    expect(address.get('PostalCode')).toBe('68102');
    expect(address.get('CustomerName')).toBe('Acme Roofing LLC');
    expect(address.get('IsoCountry')).toBe('US');
  });

  test('a saved but unfinished messaging profile is completed before review', async () => {
    const f = fixtureFetch({
      [`GET ${TH}/CustomerProfiles/${BU}/EntityAssignments`]: 'assignments-list',
      [`GET ${TH}/EndUsers/${IT1}`]: 'enduser-get-business',
      [`GET ${TH}/EndUsers/${IT2}`]: 'enduser-get-rep',
      [`GET ${TH}/SupportingDocuments/${RD1}`]: 'document-get',
      [`POST ${TH}/EndUsers/${IT1}`]: 'enduser-update',
      [`POST ${TH}/EndUsers/${IT2}`]: 'enduser-update',
      [`GET ${TH}/TrustProducts/${BW}/EntityAssignments`]: 'assignments-empty',
      [`POST ${TH}/EndUsers`]: 'enduser-create',
      [`POST ${TH}/TrustProducts/${BW}/EntityAssignments`]: 'assignment-create',
      [`POST ${API}/Accounts/${sub.accountSid}/Addresses/${AD1}.json`]: 'address-update',
      [`POST ${TH}/CustomerProfiles/${BU}/Evaluations`]: 'evaluation-compliant',
      [`POST ${TH}/CustomerProfiles/${BU}`]: 'profile-submit',
      [`POST ${TH}/TrustProducts/${BW}/Evaluations`]: 'evaluation-compliant',
      [`POST ${TH}/TrustProducts/${BW}`]: 'profile-submit',
      [`POST ${MSG}/a2p/BrandRegistrations/${BN}`]: 'brand-pending',
    });
    await brandsWith(f).submitBrand(sub, submitArgs(brand(), previous));

    const entries = log(f);
    const at = entries.indexOf(`GET /v1/TrustProducts/${BW}/EntityAssignments`);
    expect(at).toBeGreaterThan(-1);
    expect(entries.slice(at, at + 5)).toEqual([
      `GET /v1/TrustProducts/${BW}/EntityAssignments`,
      'POST /v1/EndUsers',
      `POST /v1/TrustProducts/${BW}/EntityAssignments`,
      `POST /v1/TrustProducts/${BW}/EntityAssignments`,
      `POST /v1/TrustProducts/${BW}/Evaluations`,
    ]);
    expect(entries).not.toContain('POST /v1/TrustProducts');
    const first = entries.indexOf(`POST /v1/TrustProducts/${BW}/EntityAssignments`);
    expect(formAt(f, first).get('ObjectSid')).toBe(IT1);
    expect(formAt(f, first + 1).get('ObjectSid')).toBe(BU);
  });

  test('every TrustHub and Messaging call uses the subaccount credentials', async () => {
    const f = fixtureFetch({
      ...freshRoutes(),
      [`POST ${MSG}/Services/${MG}/Compliance/Usa2p`]: 'campaign-create',
      [`GET ${MSG}/Services/${MG}/Compliance/Usa2p/${QE}`]: 'campaign-verified',
      [`GET ${MSG}/a2p/BrandRegistrations/${BN}`]: 'brand-approved',
    });
    const brands = brandsWith(f);
    await brands.submitBrand(sub, submitArgs());
    await brands.submitCampaign(sub, { brandSid: BN, messagingServiceSid: MG, campaign, previousCampaignSid: null });
    await brands.brandStatus(sub, BN);
    await brands.campaignStatus(sub, MG, QE);

    expect(f.requests).toHaveLength(21);
    const subAuth = basic(sub.accountSid, sub.authToken);
    for (const request of f.requests) {
      expect(request.auth).toBe(subAuth);
    }
  });
});
