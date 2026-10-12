import pg from 'pg';
import { afterEach, beforeEach, describe, expect, inject, test } from 'vitest';
import { plainRejection } from '@roofline/shared';
import { continueRegistration } from '../src/account/texting/progress.ts';
import { type AppDeps, createApp } from '../src/app.ts';
import type { TextingRegistrar } from '../src/providers/registrar.ts';
import { TwilioAccounts } from '../src/providers/twilio/accounts.ts';
import { TwilioBrands } from '../src/providers/twilio/brands.ts';
import { TWILIO_API, TWILIO_MESSAGING, TWILIO_TRUSTHUB, TwilioHttp } from '../src/providers/twilio/http.ts';
import { loginAs, makeTestApp, type TestApp } from './helpers.ts';
import { fixtureFetch } from './twilio-fixtures.ts';

/** Master credentials (the ones we hold) and a company's subaccount (the one its registration runs as). */
const master = { accountSid: 'AC00000000000000000000000000000000', authToken: 'master-token' };
const sub = { accountSid: 'AC11111111111111111111111111111111', authToken: 'sub-auth-token' };
const PRIMARY = 'BU33333333333333333333333333333333';
const MG = 'MG22222222222222222222222222222222';
const BU = 'BU11111111111111111111111111111111';
const BW = 'BW11111111111111111111111111111111';
const BN = 'BN11111111111111111111111111111111';
const QE = 'QE11111111111111111111111111111111';
const TH = TWILIO_TRUSTHUB;
const MSG = TWILIO_MESSAGING;
const API = TWILIO_API;
/** What the recorded number fixture (incoming-create) answers. */
const BOUGHT_NUMBER = '+14025550123';
const FAILURE_TEXT = 'EIN does not match the legal name';

const BRAND = {
  legalName: 'Acme Roofing LLC',
  ein: '12-3456789',
  businessType: 'llc',
  street: '1200 Farnam St',
  city: 'Omaha',
  state: 'NE',
  zip: '68102',
  website: 'https://acme.com',
  contactFirstName: 'Maria',
  contactLastName: 'Lopez',
  contactEmail: 'maria@acme.test',
  contactPhone: '(402) 555-0199',
  contactTitle: 'Owner',
};

let t: TestApp;

beforeEach(async () => {
  t = await makeTestApp();
  // The seed gives every company an approved registration row. These tests start from none.
  await ownerQuery('delete from texting_registrations where company_id = $1', [t.seed.a.companyId]);
});

afterEach(async () => {
  await t.close();
});

/** Runs SQL as the owner role, which bypasses row-level security. */
async function ownerQuery<R extends Record<string, unknown> = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<R[]> {
  const client = new pg.Client({ connectionString: inject('dbUrls').owner });
  await client.connect();
  try {
    const res = await client.query<R>(sql, params);
    return res.rows;
  } finally {
    await client.end();
  }
}

/** Gives Acme a card: the company has a subscription and is active. */
async function addCard(): Promise<void> {
  await ownerQuery("update companies set stripe_subscription_id = 'sub_test', status = 'active' where id = $1", [
    t.seed.a.companyId,
  ]);
}

/**
 * The recorded Twilio answers for a fresh registration. The brand and campaign status routes serve
 * the given fixtures in order (the last repeats), so a test chooses how the carriers answer over time.
 */
function recordedRoutes(brand: string[], campaign: string[]): Record<string, string | string[]> {
  return {
    [`GET ${API}/Accounts.json`]: 'accounts-empty',
    [`POST ${API}/Accounts.json`]: 'account-create',
    [`GET ${MSG}/Services`]: 'services-empty',
    [`POST ${MSG}/Services`]: 'service-create',
    [`GET ${MSG}/Services/${MG}/PhoneNumbers`]: 'service-numbers-empty',
    [`POST ${MSG}/Services/${MG}/PhoneNumbers`]: 'service-number-add',
    [`GET ${API}/Accounts/${sub.accountSid}/AvailablePhoneNumbers/US/Local.json`]: 'available-402',
    [`GET ${API}/Accounts/${sub.accountSid}/IncomingPhoneNumbers.json`]: 'incoming-numbers-empty',
    [`POST ${API}/Accounts/${sub.accountSid}/IncomingPhoneNumbers.json`]: 'incoming-create',
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
    [`GET ${MSG}/a2p/BrandRegistrations/${BN}`]: brand,
    [`POST ${MSG}/Services/${MG}/Compliance/Usa2p`]: 'campaign-create',
    [`GET ${MSG}/Services/${MG}/Compliance/Usa2p/${QE}`]: campaign,
  };
}

/** The real Twilio adapters over the recorded answers, as the registrar the app is built with. */
function registrarOver(routes: Record<string, string | string[]>): TextingRegistrar {
  const http = new TwilioHttp({ ...master, fetch: fixtureFetch(routes) });
  const accounts = new TwilioAccounts({ http });
  const brands = new TwilioBrands({ http, primaryProfileSid: PRIMARY });
  return {
    configured: true,
    ensureSubaccount: accounts.ensureSubaccount.bind(accounts),
    ensureMessagingService: accounts.ensureMessagingService.bind(accounts),
    ensureNumber: accounts.ensureNumber.bind(accounts),
    submitBrand: brands.submitBrand.bind(brands),
    brandStatus: brands.brandStatus.bind(brands),
    submitCampaign: brands.submitCampaign.bind(brands),
    campaignStatus: brands.campaignStatus.bind(brands),
  };
}

/** Builds the app over the recorded registrar, with Acme's phone and a card, and submits its brand. */
async function submitWith(routes: Record<string, string | string[]>) {
  const deps: AppDeps = { ...t.deps, registrar: registrarOver(routes) };
  const app = createApp(deps);
  const owner = await loginAs(app, t.seed.a.owner);
  await ownerQuery("update companies set phone_e164 = '+14025550199' where id = $1", [t.seed.a.companyId]);
  await addCard();
  const res = await owner.post('/api/texting/registration').send({ brand: BRAND, useHostedPolicyPages: false });
  expect(res.status).toBe(202);
  await t.jobs.drain(deps);
  return { deps, owner };
}

describe('texting registration against recorded Twilio answers', () => {
  test("with Twilio's recorded answers, a registration goes from submitted to approved, and a rejection to Fix and resubmit", async () => {
    const companyId = t.seed.a.companyId;
    const { deps, owner } = await submitWith(
      recordedRoutes(['brand-pending', 'brand-approved'], ['campaign-pending', 'campaign-verified']),
    );

    // Submitted: the brand is still with the carriers after the first pass.
    expect((await owner.get('/api/texting')).body.state).toBe('waiting');

    // The brand is approved and the campaign is submitted and still pending.
    await continueRegistration(deps, companyId);
    expect((await owner.get('/api/texting')).body.state).toBe('waiting');

    // The campaign is verified, so the number is bought and texting is on.
    await continueRegistration(deps, companyId);
    const view = await owner.get('/api/texting');
    expect(view.body.state).toBe('approved');
    expect(view.body.number).toBe(BOUGHT_NUMBER);

    const numbers = await ownerQuery<{ e164: string; purpose: string; status: string }>(
      'select e164, purpose, status from company_phone_numbers where company_id = $1',
      [companyId],
    );
    expect(numbers).toEqual([{ e164: BOUGHT_NUMBER, purpose: 'main', status: 'active' }]);
    expect(t.logged).toEqual([]);
  });

  test('a brand the carriers reject shows Fix and resubmit with a plain reason', async () => {
    const { owner } = await submitWith(recordedRoutes(['brand-failed'], ['campaign-pending']));

    const view = await owner.get('/api/texting');
    expect(view.body.state).toBe('needs_fix');
    expect(view.body.reason).toBe(plainRejection(FAILURE_TEXT).reason);
    // Twilio's own words never reach the company.
    expect(JSON.stringify(view.body)).not.toContain(FAILURE_TEXT);
  });
});

